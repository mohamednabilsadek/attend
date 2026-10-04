/* =====================================================================
   Hudoori server core.  Runs unchanged in Google Apps Script and Node.js.
   The adapter (`env`) supplies storage, time, randomness and SHA-256.
   Every request: load DB -> authenticate token -> run op -> save.
   Clients never receive other people's secrets (see buildView).
   ===================================================================== */
function HudooriCore(env) {
  'use strict';
  const MIN = 6e4, DAY = 864e5, TOKEN_TTL = 14 * DAY;
  let DB = null, CU = null, DIRTY = false;
  const now = () => env.now();
  const uid32 = () => env.uuid().replace(/-/g, '');
  const rid = p => p + uid32().slice(0, 10);
  const rsec = () => uid32() + uid32().slice(0, 12);
  const cyrb53 = (str, seed = 0) => { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return 4294967296 * (2097151 & h2) + (h1 >>> 0); };
  const hash = s => cyrb53(String(s), 0).toString(36) + cyrb53(String(s), 7).toString(36);
  const fT = ts => ts ? env.fmtTime(ts) : '—';
  const durMin = (a, b) => (a && b) ? Math.max(0, Math.round((b - a) / MIN)) : null;
  class HErr extends Error { constructor(msg, code) { super(msg); this.code = code || 'error'; } }
  const bad = (m, c) => { throw new HErr(m, c); };
  const str = (v, max) => String(v == null ? '' : v).slice(0, max || 200);
  const num = v => { const n = +v; return isFinite(n) ? n : NaN; };
  const ROLE_LABEL = { student: 'Student', instructor: 'Instructor', admin: 'Admin' };

  /* ---------- data model ---------- */
  const GOVS = [1, 2, 3, 4, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 34, 35, 88];
  const normDigits = s => String(s || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/\s+/g, '');
  function validNID(s) {
    if (!/^[23]\d{13}$/.test(s)) return false;
    const y = (s[0] === '2' ? 1900 : 2000) + +s.slice(1, 3), m = +s.slice(3, 5), d = +s.slice(5, 7), dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d && dt.getTime() < Date.now() && GOVS.includes(+s.slice(7, 9));
  }
  function emptyDB(inst) {
    return { v: 2, ver: 1, users: [], courses: [], lectures: [], sessions: [], records: [], notifs: [], logs: [], presenting: {}, createdAt: now(), updatedAt: now(), seq: { stu: 0 }, tokens: {}, fails: {},
      departments: ['علوم الحاسب', 'نظم المعلومات', 'تكنولوجيا المعلومات', 'أمن المعلومات', 'الذكاء الاصطناعي'],
      settings: { institution: inst || 'Hudoori', requireGps: true, rotateSec: 10, lateAfter: 10, graceSec: 25 } };
  }
  const initialized = () => !!(DB && DB.users.some(u => u.role === 'admin'));
  const pwStore = (pre, salt) => env.sha256(salt + ':' + pre);
  const checkPre = pre => { if (typeof pre !== 'string' || pre.length < 20 || pre.length > 200) bad('Invalid password.', 'pre'); return pre; };
  function nextStudentId() { DB.seq.stu++; return 'STU-' + new Date().getFullYear() + '-' + String(DB.seq.stu).padStart(3, '0'); }
  function mkUser({ name, email, pre, role, dept, extra }) {
    const salt = rsec(), u = { id: rid('u_'), name, email, salt, pw: pwStore(pre, salt), role, active: true, dept: dept || '', createdAt: now(), ...(extra || {}) };
    if (role === 'student') { u.studentId = nextStudentId(); u.cardSecret = rsec(); } return u;
  }
  const user = id => DB.users.find(u => u.id === id);
  const course = id => DB.courses.find(c => c.id === id);
  const lecture = id => DB.lectures.find(l => l.id === id);
  const sessionById = id => DB.sessions.find(s => s.id === id);
  const recOf = (lid, sid) => DB.records.find(r => r.lectureId === lid && r.studentId === sid);
  const myActive = u => DB.sessions.find(s => s.instructorId === u.id && s.status === 'open' && s.endsAt > now());
  function log(action, detail) { const u = CU; DB.logs.unshift({ id: rid('lg'), ts: now(), uid: u ? u.id : null, uname: u ? u.name : 'system', role: u ? u.role : '', action, detail: str(detail, 300) }); if (DB.logs.length > 500) DB.logs.length = 500; DIRTY = true; }
  function notify(userId, text, type = 'info', key) { if (!userId) return; if (key && DB.notifs.some(n => n.userId === userId && n.key === key)) return; DB.notifs.unshift({ id: rid('n_'), userId, text, type, ts: now(), read: false, key }); if (DB.notifs.length > 600) DB.notifs.length = 600; DIRTY = true; }
  function revokeTokens(uid) { Object.keys(DB.tokens).forEach(t => { if (DB.tokens[t].uid === uid) delete DB.tokens[t]; }); DIRTY = true; }

  /* ---------- QR + attendance engine (same rules as the client UI) ---------- */
  const sessionCounter = s => Math.floor(now() / (s.rotateSec * 1000));
  function parsePayload(t) { const p = String(t || '').trim().split('|'); if (p[0] !== 'SADS1') return null; return p[1] === 'S' ? { kind: 'S', id: p[2], counter: +p[3], sig: p[4] } : p[1] === 'C' ? { kind: 'C', id: p[2], sig: p[3] } : null; }
  const fail = (msg, code) => ({ ok: false, msg, code });
  function closeExpired() { DB.sessions.forEach(s => { if (s.status === 'open' && s.endsAt <= now()) { s.status = 'closed'; s.closedAt = s.endsAt; DIRTY = true; } }); }
  function verifySession(text) {
    const p = parsePayload(text);
    if (!p) return fail('Unrecognised QR code. Scan the instructor\'s live session QR.', 'format');
    if (p.kind !== 'S') return fail('That is a student ID card, not a session QR code.', 'format');
    const s = sessionById(p.id); if (!s) return fail('Session not found.', 'nosession');
    closeExpired();
    if (s.status !== 'open') return fail('This session has ended — scans are no longer accepted.', 'closed');
    if (p.sig !== hash(s.secret + ':' + p.counter)) return fail('Invalid QR signature (forged code).', 'forged');
    const cur = sessionCounter(s), back = Math.ceil((DB.settings.graceSec || 25) / s.rotateSec);
    if (p.counter < cur - back || p.counter > cur + 1) return fail('QR code expired — it rotates every ' + s.rotateSec + 's. Screenshots and replays are rejected.', 'replay');
    return { ok: true, s };
  }
  function haversine(a, b, c, d) { const R = 6371000, r = x => x * Math.PI / 180, dLa = r(c - a), dLo = r(d - b); const q = Math.sin(dLa / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(q)); }
  function attend({ sessionId, studentId, method, gps, source }) {
    closeExpired();
    const s = sessionById(sessionId); if (!s) return fail('Session not found.', 'nosession');
    if (s.status !== 'open' || s.endsAt <= now()) return fail('Session closed — scans are no longer accepted.', 'closed');
    const stu = user(studentId); if (!stu || stu.role !== 'student') return fail('Student not found.', 'nostudent');
    if (!stu.active) return fail(stu.name + '\'s account is deactivated.', 'inactive');
    const c = course(s.courseId), lec = lecture(s.lectureId);
    if (!c.enrolled.includes(studentId)) return fail((source === 'student' ? 'You are' : stu.name + ' is') + ' not enrolled in ' + c.code + '.', 'notenrolled');
    if (gps && !(isFinite(gps.lat) && isFinite(gps.lng) && Math.abs(gps.lat) <= 90 && Math.abs(gps.lng) <= 180)) gps = null;
    let g = null;
    if (source === 'student') {
      const need = DB.settings.requireGps && c.geoOn !== false;
      if (need) {
        if (!gps) return fail('Location could not be verified — GPS is required.', 'gps');
        const d = haversine(c.lat, c.lng, gps.lat, gps.lng);
        if (d > c.radius) return fail(`Outside the allowed area — ${Math.round(d)} m from ${c.room} (limit ${c.radius} m).`, 'gps');
        g = { dist: Math.round(d) };
      } else if (gps) g = { dist: Math.round(haversine(c.lat, c.lng, gps.lat, gps.lng)) };
    } else if (gps) g = gps;
    let rec = recOf(lec.id, studentId);
    if (s.type === 'in') {
      if (rec && rec.checkIn) return fail(`Duplicate scan blocked — ${stu.name} already checked in at ${fT(rec.checkIn)}.`, 'dup');
      const late = now() > lec.startedAt + c.lateAfter * MIN, st = late ? 'late' : 'present';
      if (rec) { rec.checkIn = now(); rec.status = st; rec.method = method; rec.gps = g; }
      else { rec = { id: rid('r_'), lectureId: lec.id, courseId: c.id, studentId, checkIn: now(), checkOut: null, status: st, method, gps: g }; DB.records.push(rec); }
      notify(studentId, `Checked in to ${c.code} at ${fT(rec.checkIn)} — ${st === 'late' ? 'marked LATE' : 'marked present'}.`, 'success');
      log('CHECK_IN', `${stu.name} → ${c.code} ${lec.title} (${method}${g ? ', ' + g.dist + ' m' : ''}) ${st}`);
      return { ok: true, msg: `${stu.name} checked in${late ? ' (late)' : ''} · ${c.code}`, status: st };
    }
    if (!rec || !rec.checkIn) return fail(`${stu.name} has not checked in to this lecture yet.`, 'nocheckin');
    if (rec.checkOut) return fail(`Duplicate scan blocked — ${stu.name} already checked out at ${fT(rec.checkOut)}.`, 'dup');
    rec.checkOut = now(); rec.gpsOut = g;
    notify(studentId, `Checked out of ${c.code} at ${fT(rec.checkOut)} (${durMin(rec.checkIn, rec.checkOut)} min present).`, 'success');
    log('CHECK_OUT', `${stu.name} ← ${c.code} ${lec.title} (${method})`);
    return { ok: true, msg: `${stu.name} checked out · ${c.code}`, status: rec.status };
  }
  function scanCard(text, sessionId) {
    const p = parsePayload(text);
    if (!p) return fail('Unrecognised QR code.', 'format');
    if (p.kind !== 'C') return fail('That is a session QR, not a student ID card.', 'format');
    const stu = DB.users.find(u => u.role === 'student' && u.studentId === p.id);
    if (!stu) return fail('Unknown student ID ' + p.id + '.', 'nostudent');
    if (p.sig !== hash(stu.cardSecret + ':' + stu.studentId)) return fail('Invalid card signature — forged or revoked card.', 'forged');
    const pr = DB.presenting[stu.id]; const s = sessionById(sessionId);
    const gps = pr && s && pr.sessionId === sessionId && now() - pr.ts < 5 * MIN ? pr.gps : null;
    return attend({ sessionId, studentId: stu.id, method: 'card', gps, source: 'instructor' });
  }
  function attendById(text, sessionId) {
    const q = normDigits(text).toUpperCase(); if (!q) return fail('Enter a student ID.', 'format');
    const stu = DB.users.find(u => u.role === 'student' && (u.studentId.toUpperCase() === q || u.studentId.toUpperCase().endsWith('-' + q.replace(/^0+/, '').padStart(3, '0'))));
    if (!stu) return fail('Unknown student ID ' + str(text, 40).trim() + '.', 'nostudent');
    return attend({ sessionId, studentId: stu.id, method: 'id', gps: null, source: 'instructor' });
  }
  function setStatus(lecId, sid, st) {
    const lec = lecture(lecId), c = course(lec.courseId); let rec = recOf(lecId, sid); DIRTY = true;
    if (st === 'absent') { if (rec) DB.records = DB.records.filter(r => r !== rec); }
    else {
      if (!rec) { rec = { id: rid('r_'), lectureId: lecId, courseId: c.id, studentId: sid, checkIn: null, checkOut: null, status: st, method: 'manual', gps: null }; DB.records.push(rec); }
      if (st === 'present' || st === 'late') { if (!rec.checkIn) rec.checkIn = st === 'late' ? lec.startedAt + (c.lateAfter + 1) * MIN : lec.startedAt; }
      else { rec.checkIn = null; rec.checkOut = null; }
      rec.status = st; rec.method = 'manual';
    }
    notify(sid, `Your attendance for ${c.code} ${lec.title} was set to ${st.toUpperCase()} by your instructor.`, 'info');
    log('OVERRIDE', `${user(sid).name} → ${st} (${c.code} ${lec.title})`);
  }

  /* ---------- per-role views (what each client is allowed to see) ---------- */
  const noSecret = u => { const o = { ...u }; delete o.pw; delete o.salt; delete o.cardSecret; return o; };
  const ownView = u => { const o = { ...u }; delete o.pw; delete o.salt; return o; };
  const liteUser = u => ({ id: u.id, name: u.name, role: u.role, active: u.active, studentId: u.studentId, dept: u.dept, year: u.year });
  const openSess = s => s.status === 'open' && s.endsAt > now();
  function buildView() {
    const me = CU, v = { v: 2, ver: DB.ver, settings: DB.settings, departments: DB.departments, seq: { stu: 0 }, presenting: {}, logs: [], notifs: DB.notifs.filter(n => n.userId === me.id).slice(0, 100) };
    const withoutSecret = s => { const o = { ...s }; delete o.secret; return o; };
    if (me.role === 'student') {
      const mine = DB.courses.filter(c => c.enrolled.includes(me.id)), ids = new Set(mine.map(c => c.id));
      v.courses = DB.courses.filter(c => c.active || ids.has(c.id)).map(c => ({ ...c, enrolled: ids.has(c.id) ? [me.id] : [], enrolledAt: ids.has(c.id) ? { [me.id]: (c.enrolledAt || {})[me.id] || 0 } : {} }));
      const insIds = new Set(v.courses.map(c => c.instructorId).filter(Boolean));
      v.users = [ownView(me), ...DB.users.filter(u => insIds.has(u.id)).map(liteUser)];
      v.lectures = DB.lectures.filter(l => ids.has(l.courseId));
      v.sessions = DB.sessions.filter(s => ids.has(s.courseId) && openSess(s)).map(withoutSecret);
      v.records = DB.records.filter(r => r.studentId === me.id);
    } else if (me.role === 'instructor') {
      const own = DB.courses.filter(c => c.instructorId === me.id), ids = new Set(own.map(c => c.id));
      v.courses = DB.courses.filter(c => ids.has(c.id) || !c.instructorId).map(c => ids.has(c.id) ? c : { ...c, enrolled: [], enrolledAt: {} });
      v.users = [ownView(me), ...DB.users.filter(u => u.role === 'student').map(liteUser), ...DB.users.filter(u => u.role === 'instructor' && u.id !== me.id).map(liteUser)];
      v.lectures = DB.lectures.filter(l => ids.has(l.courseId));
      v.sessions = DB.sessions.filter(s => ids.has(s.courseId)).map(s => s.instructorId === me.id && openSess(s) ? s : withoutSecret(s));
      v.records = DB.records.filter(r => ids.has(r.courseId));
    } else {
      v.courses = DB.courses; v.users = DB.users.map(noSecret); v.lectures = DB.lectures; v.sessions = DB.sessions.map(withoutSecret); v.records = DB.records; v.logs = DB.logs;
    }
    return v;
  }

  /* ---------- operations ---------- */
  const guard = (cond, msg, code) => { if (!cond) bad(msg, code); };
  const ownCourse = (cid) => { const c = course(cid); guard(c, 'Course not found.', 'nocourse'); guard(CU.role === 'admin' || c.instructorId === CU.id, 'Not allowed.', 'forbidden'); return c; };
  function session(user) { const t = rsec(); DB.tokens[t] = { uid: user.id, exp: now() + TOKEN_TTL }; DIRTY = true; return t; }
  const PUBLIC = {
    status() { return { initialized: initialized(), institution: DB ? DB.settings.institution : '', departments: DB ? DB.departments : [] }; },
    setup(a) {
      guard(a.code && a.code === env.setupCode(), 'Wrong setup code.', 'setupcode');
      guard(!initialized(), 'The database is already set up.', 'exists');
      const inst = str(a.inst, 120).trim(), name = str(a.name, 120).trim(), email = str(a.email, 160).trim().toLowerCase();
      guard(inst, 'Enter the institution name.'); guard(name.length >= 3, 'Enter the administrator name.'); guard(/^\S+@\S+\.\S+$/.test(email), 'Enter a valid email address.'); checkPre(a.pre);
      DB = emptyDB(inst); const u = mkUser({ name, email, pre: a.pre, role: 'admin' }); DB.users.push(u); CU = u; log('DB_CREATE', inst);
      return { token: session(u), uid: u.id };
    },
    login(a) {
      guard(initialized(), 'The system has not been set up yet. The administrator must create the database first.', 'uninit');
      const email = str(a.email, 160).trim().toLowerCase(), f = DB.fails[email] || { n: 0, until: 0 }, role = a.role;
      if (f.until > now()) bad('Too many attempts. Try again in a few minutes.', 'locked');
      const u = DB.users.find(x => x.email.toLowerCase() === email);
      if (!u || typeof a.pre !== 'string' || pwStore(a.pre, u.salt) !== u.pw) { f.n++; if (f.n >= 6) { f.until = now() + 5 * MIN; f.n = 0; } DB.fails[email] = f; DIRTY = true; const e = new HErr('Incorrect email or password.', 'creds'); e.persist = true; throw e; }
      if (!ROLE_LABEL[role] || u.role !== role) bad('This account is not a ' + ROLE_LABEL[role] + ' account. Choose the correct account type.', 'role');
      if (!u.active) bad('This account is deactivated. Contact an administrator.', 'inactive');
      delete DB.fails[email]; CU = u; log('LOGIN', u.email);
      return { token: session(u), uid: u.id };
    },
    register(a) {
      guard(initialized(), 'The system has not been set up yet. The administrator must create the database first.', 'uninit');
      const name = str(a.name, 120).trim().replace(/\s+/g, ' '), email = str(a.email, 160).trim().toLowerCase(), nid = normDigits(a.nid), year = parseInt(a.year, 10), dept = str(a.dept, 100);
      guard(name.split(' ').length >= 2 && name.length >= 5, 'Please enter your full name (at least two names).'); guard(/^\S+@\S+\.\S+$/.test(email), 'Enter a valid email address.');
      guard(validNID(nid), 'Enter a valid 14-digit National ID number.'); guard(year >= 1 && year <= 5, 'Select your academic year.'); guard(dept && DB.departments.includes(dept), 'Select your department.'); checkPre(a.pre);
      guard(!DB.users.some(x => x.email.toLowerCase() === email), 'An account with this email already exists.'); guard(!DB.users.some(x => x.nationalId === nid), 'An account with this National ID already exists.');
      const u = mkUser({ name, email, pre: a.pre, role: 'student', dept, extra: { nationalId: nid, year } }); DB.users.push(u); CU = u;
      notify(u.id, `Welcome ${name.split(' ')[0]}! Your student ID is ${u.studentId}. Enroll in courses to start checking in.`, 'info'); log('REGISTER', u.email + ' ' + u.studentId);
      return { token: session(u), uid: u.id };
    },
    restore(a) {
      const okCode = !initialized() && a.code && a.code === env.setupCode();
      guard(okCode || (CU && CU.role === 'admin'), 'Not allowed.', 'forbidden');
      const d = a.db; guard(d && d.v === 2 && Array.isArray(d.users) && d.users.some(u => u.role === 'admin') && Array.isArray(d.courses) && Array.isArray(d.records), 'This is not a valid Hudoori backup.', 'badbackup');
      const keep = CU && CU.id, ver = (DB && DB.ver || 1) + 1;
      d.tokens = {}; d.fails = {}; d.ver = ver; d.presenting = d.presenting || {}; d.logs = d.logs || []; d.notifs = d.notifs || []; d.sessions = d.sessions || []; d.lectures = d.lectures || []; d.seq = d.seq || { stu: 0 }; d.settings = d.settings || emptyDB().settings; d.departments = d.departments || [];
      DB = d; DIRTY = true; let tok = null;
      if (keep && user(keep)) { CU = user(keep); tok = session(CU); } else CU = null;
      if (CU) log('DB_RESTORE', 'backup restored');
      return { token: tok };
    }
  };
  const S = ['student'], I = ['instructor'], AD = ['admin'], IA = ['instructor', 'admin'], ALL = ['student', 'instructor', 'admin'];
  const OPS = {
    view: [ALL, () => ({})],
    logout: [ALL, (a, t) => { delete DB.tokens[t]; log('LOGOUT', CU.email); return {}; }],
    readAll: [ALL, () => { DB.notifs.forEach(n => { if (n.userId === CU.id) n.read = true; }); DIRTY = true; return {}; }],
    upcoming: [S, a => { (Array.isArray(a.list) ? a.list : []).slice(0, 6).forEach(x => { const key = str(x.key, 80), text = str(x.text, 220); if (key && text) notify(CU.id, text, 'upcoming', key); }); return {}; }],
    enroll: [S, a => { const c = course(a.id); guard(c && c.active && c.instructorId, 'Course not found.'); guard(!c.enrolled.includes(CU.id), 'Already enrolled.');
      c.enrolled.push(CU.id); c.enrolledAt = c.enrolledAt || {}; c.enrolledAt[CU.id] = now(); notify(c.instructorId, `${CU.name} (${CU.studentId}) enrolled in ${c.code}.`, 'info'); log('ENROLL', `${CU.name} → ${c.code}`); DIRTY = true; return {}; }],
    drop: [S, a => { const c = course(a.id); guard(c, 'Course not found.'); c.enrolled = c.enrolled.filter(x => x !== CU.id); log('DROP', `${CU.name} ✗ ${c.code}`); DIRTY = true; return {}; }],
    verifyQR: [S, a => { const v = verifySession(a.text); if (!v.ok) return { res: v }; const c = course(v.s.courseId);
      if (!c.enrolled.includes(CU.id)) return { res: fail('Not enrolled in ' + c.code + ' — enroll from Courses first.', 'notenrolled') }; return { res: { ok: true }, courseId: c.id }; }],
    studentAttend: [S, a => { const v = verifySession(a.text); if (!v.ok) return { res: v }; if (v.s.id !== a.sessionId) return { res: fail('This QR belongs to a different course session.', 'wrongsession') };
      const g = a.gps && isFinite(num(a.gps.lat)) && isFinite(num(a.gps.lng)) ? { lat: num(a.gps.lat), lng: num(a.gps.lng) } : null;
      return { res: attend({ sessionId: a.sessionId, studentId: CU.id, method: 'qr', gps: g, source: 'student' }) }; }],
    present: [S, a => { const s = sessionById(a.sessionId); guard(s && openSess(s), 'The session has ended.'); const c = course(s.courseId); guard(c.enrolled.includes(CU.id), 'You are not enrolled in ' + c.code + '.');
      const g = a.gps && isFinite(num(a.gps.lat)) && isFinite(num(a.gps.lng)) ? { lat: num(a.gps.lat), lng: num(a.gps.lng), dist: Math.round(num(a.gps.dist) || 0) } : null;
      DB.presenting[CU.id] = { courseId: c.id, sessionId: s.id, type: s.type, gps: g, ts: now() }; DIRTY = true; return {}; }],
    unpresent: [S, () => { if (DB.presenting[CU.id]) { delete DB.presenting[CU.id]; DIRTY = true; } return {}; }],

    startSession: [I, a => {
      const c = course(a.cid); guard(c && c.instructorId === CU.id && c.active, 'Course not found.'); guard(!myActive(CU), 'You already have a live session', 'busy');
      const type = a.type === 'out' ? 'out' : 'in', dur = Math.min(180, Math.max(1, parseInt(a.dur, 10) || 10)), rot = Math.min(60, Math.max(3, parseInt(a.rot, 10) || 8)); let lid = a.lid;
      if (type === 'in' && (lid === 'new' || !lid)) { const n = DB.lectures.filter(l => l.courseId === c.id).reduce((m, l) => Math.max(m, l.n), 0) + 1; const lec = { id: rid('l_'), courseId: c.id, n, title: 'Lecture ' + n, startedAt: now(), endedAt: now() + c.schedule.mins * MIN }; DB.lectures.push(lec); lid = lec.id; }
      const lec = lid && lecture(lid); guard(lec && lec.courseId === c.id, 'No lecture to check out from — start a check-in first');
      const s = { id: rid('s_'), courseId: c.id, lectureId: lec.id, instructorId: CU.id, type, startedAt: now(), endsAt: now() + dur * MIN, durationMin: dur, rotateSec: rot, secret: rsec(), status: 'open' };
      DB.sessions.push(s); c.enrolled.forEach(sid => notify(sid, `${type === 'in' ? 'Check-in' : 'Check-out'} is now open for ${c.code} — closes in ${dur} min.`, 'info')); log('SESSION_START', `${c.code} ${type} ${dur}min rot ${rot}s`); DIRTY = true; return {}; }],
    stopSession: [I, () => { const s = myActive(CU); if (!s) return {}; s.status = 'closed'; s.closedAt = now(); log('SESSION_STOP', course(s.courseId).code); DIRTY = true; return {}; }],
    extend: [I, () => { const s = myActive(CU); if (!s) return {}; s.endsAt += 5 * MIN; s.durationMin += 5; DIRTY = true; return {}; }],
    instScan: [I, a => { const s = sessionById(a.sessionId); if (!s || s.instructorId !== CU.id || !openSess(s)) return { res: fail('No open session — scans are rejected.', 'closed') }; return { res: scanCard(a.text, s.id) }; }],
    instManual: [I, a => { const s = sessionById(a.sessionId); if (!s || s.instructorId !== CU.id || !openSess(s)) return { res: fail('No open session — scans are rejected.', 'closed') }; return { res: attendById(a.text, s.id) }; }],
    setStatus: [IA, a => { const lec = lecture(a.lid); guard(lec, 'Lecture not found.'); ownCourse(lec.courseId); const st = a.st; guard(['present', 'late', 'excused', 'absent'].includes(st), 'Invalid status.');
      const stu = user(a.sid); guard(stu && stu.role === 'student', 'Student not found.'); setStatus(lec.id, stu.id, st); return {}; }],
    claim: [I, a => { const c = course(a.id); guard(c && !c.instructorId, 'Course not found.'); c.instructorId = CU.id; log('ASSIGN', `${c.code} → ${CU.name}`); DIRTY = true; return { code: c.code }; }],
    saveCourse: [IA, a => {
      const d = a.data || {}, code = str(d.code, 30).trim().toUpperCase(), name = str(d.name, 160).trim(), days = (Array.isArray(d.days) ? d.days : []).map(Number).filter(x => x >= 0 && x <= 6);
      guard(code && name, 'Code and name are required.'); guard(days.length, 'Pick at least one day.'); guard(!DB.courses.some(c => c.code === code && c.id !== a.id), 'Course code already exists.');
      const lat = num(d.lat), lng = num(d.lng), rad = parseInt(d.radius, 10), geoOn = !!d.geoOn;
      guard(!geoOn || (isFinite(lat) && isFinite(lng) && rad >= 20), 'Enter valid coordinates and a radius of at least 20 m.');
      const time = /^\d{2}:\d{2}$/.test(d.time) ? d.time : '09:00';
      const data = { code, name, room: str(d.room, 80).trim() || 'TBA', schedule: { days, time, mins: Math.min(600, Math.max(15, parseInt(d.mins, 10) || 90)) }, lateAfter: Math.max(0, parseInt(d.lateAfter, 10) || 0), lat: isFinite(lat) ? lat : 0, lng: isFinite(lng) ? lng : 0, radius: rad >= 20 ? rad : 150, geoOn, active: !!d.active };
      let ins = CU.role === 'admin' ? (d.instructorId || null) : CU.id; if (ins) guard(user(ins) && user(ins).role === 'instructor', 'Instructor not found.');
      if (a.id) { const c = ownCourse(a.id); Object.assign(c, data, { instructorId: CU.role === 'admin' ? ins : c.instructorId }); log('COURSE_EDIT', code); }
      else { DB.courses.push({ id: rid('c_'), ...data, instructorId: ins, enrolled: [], enrolledAt: {}, createdAt: now() }); log('COURSE_NEW', code); }
      DIRTY = true; return {}; }],
    delCourse: [IA, a => { const c = ownCourse(a.id); DB.records = DB.records.filter(r => r.courseId !== c.id); DB.lectures = DB.lectures.filter(l => l.courseId !== c.id); DB.sessions = DB.sessions.filter(s => s.courseId !== c.id); DB.courses = DB.courses.filter(x => x.id !== c.id); log('COURSE_DEL', c.code); DIRTY = true; return {}; }],
    toggleEnroll: [I, a => { const c = ownCourse(a.cid), sid = a.sid, st = user(sid); guard(st && st.role === 'student' && st.active, 'Student not found.');
      if (c.enrolled.includes(sid)) c.enrolled = c.enrolled.filter(x => x !== sid); else { c.enrolled.push(sid); c.enrolledAt = c.enrolledAt || {}; c.enrolledAt[sid] = now(); notify(sid, `You were enrolled in ${c.code} ${c.name}.`, 'info'); }
      log('ENROLL_EDIT', `${st.name} / ${c.code}`); DIRTY = true; return {}; }],
    announce: [I, a => { const c = ownCourse(a.cid), t = str(a.text, 500).trim(); guard(t, 'Write a message first'); c.enrolled.forEach(s => notify(s, `Announcement (${c.code}): ${t}`, 'announce')); log('ANNOUNCE', c.code + ': ' + t); DIRTY = true; return { n: c.enrolled.length }; }],

    saveUser: [AD, a => {
      const id = a.id || '', name = str(a.name, 120).trim(), email = str(a.email, 160).trim().toLowerCase(), role = a.role, dept = str(a.dept, 100), nid = normDigits(a.nid), year = parseInt(a.year, 10), act = !!a.active;
      guard(name.length >= 2, 'Name is required.'); guard(/^\S+@\S+\.\S+$/.test(email), 'Enter a valid email.'); guard(ROLE_LABEL[role], 'Invalid role.'); guard(!DB.users.some(x => x.email.toLowerCase() === email && x.id !== id), 'Email already in use.');
      if (!id) checkPre(a.pre); else if (a.pre) checkPre(a.pre);
      if (role === 'student') { guard(validNID(nid), 'Enter a valid 14-digit National ID number.'); guard(!DB.users.some(x => x.nationalId === nid && x.id !== id), 'An account with this National ID already exists.'); guard(year >= 1 && year <= 5, 'Select the academic year.'); guard(dept, 'Select the department.'); }
      if (id && id === CU.id) guard(act && role === 'admin', 'You cannot deactivate or demote your own admin account.');
      if (id) { const x = user(id); guard(x, 'User not found.'); const wasAdmin = x.role === 'admin'; if (wasAdmin && role !== 'admin') guard(DB.users.filter(y => y.role === 'admin').length > 1, 'Cannot delete the last admin');
        Object.assign(x, { name, email, role, dept, active: act }); if (a.pre) { x.salt = rsec(); x.pw = pwStore(a.pre, x.salt); revokeTokens(x.id); } if (!act) revokeTokens(x.id);
        if (role === 'student') { x.nationalId = nid; x.year = year; if (!x.studentId) { x.studentId = nextStudentId(); x.cardSecret = rsec(); } } log('USER_EDIT', email); }
      else { DB.users.push(mkUser({ name, email, pre: a.pre, role, dept, extra: role === 'student' ? { nationalId: nid, year } : {} })); log('USER_ADD', email + ' ' + role); }
      DIRTY = true; return {}; }],
    toggleUser: [AD, a => { const x = user(a.id); guard(x, 'User not found.'); guard(x.id !== CU.id, 'You cannot deactivate yourself'); x.active = !x.active; if (!x.active) revokeTokens(x.id);
      notify(x.id, x.active ? 'Your account was re-activated.' : 'Your account was deactivated.', 'info'); log(x.active ? 'USER_ACTIVATE' : 'USER_DEACTIVATE', x.email); DIRTY = true; return { name: x.name, active: x.active }; }],
    delUser: [AD, a => { const x = user(a.id); guard(x, 'User not found.'); guard(x.id !== CU.id, 'You cannot delete yourself'); guard(!(x.role === 'admin' && DB.users.filter(y => y.role === 'admin').length < 2), 'Cannot delete the last admin');
      const id = x.id; revokeTokens(id); DB.users = DB.users.filter(y => y.id !== id); DB.records = DB.records.filter(r => r.studentId !== id); DB.notifs = DB.notifs.filter(n => n.userId !== id);
      DB.courses.forEach(c => { c.enrolled = c.enrolled.filter(s => s !== id); if (c.instructorId === id) c.instructorId = null; }); DB.sessions.forEach(s => { if (s.instructorId === id && s.status === 'open') s.status = 'closed'; }); log('USER_DEL', x.email); DIRTY = true; return {}; }],
    assign: [AD, a => { const c = course(a.cid); guard(c, 'Course not found.'); const u = a.uid ? user(a.uid) : null; guard(!a.uid || (u && u.role === 'instructor'), 'Instructor not found.');
      c.instructorId = u ? u.id : null; if (u) notify(u.id, `You were assigned to ${c.code} ${c.name}.`, 'info'); log('ASSIGN', `${c.code} → ${u ? u.name : 'unassigned'}`); DIRTY = true; return {}; }],
    saveSettings: [AD, a => { const s = DB.settings; s.institution = str(a.institution, 120).trim() || s.institution; s.requireGps = !!a.requireGps; s.rotateSec = Math.min(60, Math.max(3, parseInt(a.rotateSec, 10) || 10)); s.lateAfter = Math.max(0, parseInt(a.lateAfter, 10) || 0); s.graceSec = Math.min(120, Math.max(5, parseInt(a.graceSec, 10) || 25)); log('SETTINGS', 'updated'); DIRTY = true; return {}; }],
    addDept: [AD, a => { const d = str(a.name, 100).trim(); guard(d, 'Enter a department name.'); guard(!DB.departments.includes(d), 'Department already exists'); DB.departments.push(d); log('DEPT_ADD', d); DIRTY = true; return {}; }],
    delDept: [AD, a => { const i = DB.departments.indexOf(a.name); if (i >= 0) { DB.departments.splice(i, 1); log('DEPT_DEL', a.name); DIRTY = true; } return {}; }],
    eraseAll: [AD, () => { DB.users = [CU]; DB.courses = []; DB.lectures = []; DB.sessions = []; DB.records = []; DB.notifs = []; DB.presenting = {}; DB.seq.stu = 0; DB.tokens = { ...Object.fromEntries(Object.entries(DB.tokens).filter(([, v]) => v.uid === CU.id)) }; log('DB_ERASE', 'all data erased'); DIRTY = true; return {}; }],
    backup: [AD, () => { const d = JSON.parse(JSON.stringify(DB)); d.tokens = {}; d.fails = {}; log('DB_EXPORT', 'encrypted backup'); DIRTY = true; return { db: d }; }]
  };

  /* ---------- request entry point ---------- */
  const reply = (o) => JSON.stringify(o);
  function run(req, write) {
    const op = String(req.op || ''), a = (req.a && typeof req.a === 'object') ? req.a : {}; DIRTY = false; CU = null; DB = env.load();
    if (DB) { const t = DB.tokens && DB.tokens[req.token]; if (t && t.exp > now()) { const u = user(t.uid); if (u && u.active) CU = u; } }
    let data;
    try {
      if (op === 'ping') return { ok: true, data: { service: 'hudoori' } };
      if (PUBLIC[op]) { if (op !== 'status' && op !== 'setup' && op !== 'restore') guard(DB, 'The system has not been set up yet. The administrator must create the database first.', 'uninit'); data = PUBLIC[op](a); }
      else { const spec = OPS[op]; guard(spec && spec[1], 'Unknown operation.', 'badop'); guard(CU, 'Please sign in again.', 'auth'); guard(spec[0].includes(CU.role), 'Not allowed.', 'forbidden'); if (write) closeExpired(); data = spec[1](a, req.token); }
    } catch (e) {
      if (e instanceof HErr) { if (e.persist && write && DB) { DB.ver = (DB.ver || 0) + 1; env.save(DB); } return { ok: false, error: e.message, code: e.code, ver: DB ? DB.ver : 0, now: now() }; }
      throw e;
    }
    const out = { ok: true, data, ver: DB ? DB.ver : 0, now: now() };
    if (write && DIRTY) { DB.ver = (DB.ver || 0) + 1; DB.updatedAt = now(); const tk = DB.tokens; Object.keys(tk).forEach(k => { if (tk[k].exp < now()) delete tk[k]; }); env.save(DB); out.ver = DB.ver; }
    if (op !== 'status' && op !== 'logout' && op !== 'ping' && CU && DB && !a.noView) { if (op === 'view') closeExpired(); out.view = buildView(); }
    if (op === 'logout') delete out.view;
    return out;
  }
  const READONLY = { view: 1, status: 1, ping: 1 };
  function handle(raw) {
    let req; try { req = JSON.parse(raw); } catch (e) { return reply({ ok: false, error: 'Bad request.', code: 'bad' }); }
    if (!req || typeof req !== 'object') return reply({ ok: false, error: 'Bad request.', code: 'bad' });
    try {
      if (req.op === 'view' && req.a && req.a.since != null && !req.a.full) { const pv = env.peekVer(); if (pv != null && pv === req.a.since) return reply({ ok: true, data: {}, same: true, ver: pv, now: env.now() }); }
      const res = READONLY[req.op] ? run(req, false) : env.lock(() => run(req, true));
      if (req.op === 'view' && req.a && req.a.since === res.ver && res.ok && !req.a.full) { return reply({ ok: true, data: {}, same: true, ver: res.ver, now: res.now }); }
      return reply(res);
    } catch (e) { if (env.logError) env.logError(e); return reply({ ok: false, error: 'Server error. Please try again.', code: 'server' }); }
  }
  return { handle };
}
if (typeof module !== 'undefined') module.exports = HudooriCore;

/* =====================================================================
   Google Apps Script adapter — storage in a private Drive file.
   ===================================================================== */
const SETUP_CODE = 'CHANGE-THIS-CODE';   // <-- put your own secret code here (used once to create the database)
const TZ = 'Africa/Cairo';
const DB_FILE_NAME = 'hudoori-db.json';

const gasEnv = {
  now: () => Date.now(),
  uuid: () => Utilities.getUuid(),
  sha256: s => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''),
  fmtTime: ts => Utilities.formatDate(new Date(ts), TZ, 'HH:mm'),
  setupCode: () => SETUP_CODE,
  lock: fn => { const l = LockService.getScriptLock(); l.waitLock(25000); try { return fn(); } finally { l.releaseLock(); } },
  peekVer: () => { const v = CacheService.getScriptCache().get('ver'); return v == null ? null : +v; },
  load: () => {
    const id = PropertiesService.getScriptProperties().getProperty('DBFILE'); if (!id) return null;
    try { return JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8')); } catch (e) { return null; }
  },
  save: db => {
    const props = PropertiesService.getScriptProperties(), json = JSON.stringify(db); let id = props.getProperty('DBFILE');
    if (id) { try { DriveApp.getFileById(id).setContent(json); } catch (e) { id = null; } }
    if (!id) { const f = DriveApp.createFile(DB_FILE_NAME, json, MimeType.PLAIN_TEXT); props.setProperty('DBFILE', f.getId()); }
    CacheService.getScriptCache().put('ver', String(db.ver), 21600);
  },
  logError: e => console.error(e && e.stack || e)
};
const hudooriCore = HudooriCore(gasEnv);

function doPost(e) {
  return ContentService.createTextOutput(hudooriCore.handle(e && e.postData ? e.postData.contents : '{}')).setMimeType(ContentService.MimeType.JSON);
}
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data: { service: 'hudoori' } })).setMimeType(ContentService.MimeType.JSON);
}
/** Run this once from the editor (Run ▸ authorize) so Google asks you to allow Drive access. */
function authorize() { DriveApp.getRootFolder(); CacheService.getScriptCache(); LockService.getScriptLock(); Logger.log('Authorized. Now deploy as a Web app.'); }
