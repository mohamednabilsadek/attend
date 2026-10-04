# Hudoori — Publishing Guide (Online Database)

Idea: **The page** is on GitHub Pages, and **the database** is a Google Apps Script that stores data in a dedicated file on your personal Google Drive. All users (students/lecturers/admin) share the same data.

## Steps (About 10 minutes)

1. Open [https://script.google.com](https://script.google.com) $\leftarrow$ **New project**.
2. Delete the existing code and paste the entire contents of the **Code.gs** file.
3. Change the line `const SETUP_CODE = 'CHANGE-THIS-CODE'` to your own secret code (used once to create the database). Save the project.
4. From the menu, select the **authorize** function, then click **Run** and grant the necessary permissions (Drive).
5. **Deploy ▸ New deployment ▸ Web app**
* Execute as: **Me**
* Who has access: **Anyone**
* Click Deploy and copy the URL ending with `/exec`.


6. Open `pages/config.json` and paste the URL in place of `PASTE_WEB_APP_URL_HERE/exec`.
7. Upload `index.html` and `config.json` to your GitHub repository, then enable **Settings ▸ Pages** (Branch: main / root).
8. Open the website link (https) $\leftarrow$ Choose **Admin** $\leftarrow$ **Create Database** $\leftarrow$ Enter your details and setup code.
9. From the admin dashboard, add lecturers. Students register themselves via "Student $\leftarrow$ New Account".

## Important Notes

* **HTTPS is required** for the camera and location permission prompt to appear (GitHub Pages provides this).
* **The setup code is secret** — do not share it. After creation, it is only used to restore a backup.
* **Download an encrypted backup** from the settings after making important changes. Do not place the backup file in a public repository.
* When modifying `Code.gs` later: Deploy ▸ Manage deployments ▸ Edit ▸ New version (the URL remains the same).
* Each request takes about 0.5–2 seconds (due to the nature of Apps Script), and free accounts have daily quotas; suitable for hundreds of students, check quotas for larger numbers.
* Changing a user's email requires setting a new password for them (passwords are hashed using the email).
* You can also open the page without `config.json` using the URL: `index.html?api=<exec_url>`.

# Local server:
You've prepared a local Ubuntu hosting package: hudoori-selfhost tar.zip along with README-ar.md.

The package is a single Node server (server.js) that serves both the page and the database from the same address, eliminating the need for Google or GitHub. You tested it locally and it worked as expected: the page and API, database creation, data persistence after reboot, daily backups, and path protection. However, you haven't tested it on a real Ubuntu machine or via Caddy.



## Quick Steps:
1.Copy the folder to the server, then run sudo bash install.sh. It requires Node 16 or newer and has no external dependencies.

2.Edit /opt/hudoori/hudoori.env and set SETUP_CODE to a secret code of your choice. The server will not start with the default placeholder code.

3.Run sudo systemctl enable --now hudoori.

4.Enable HTTPS via Caddy (the Caddyfile is ready). Without HTTPS, camera and location permission prompts will not appear.

5.Open the link, select Admin, then Create Database, and enter your setup code.

## File Locations:
-----------------
Data: In /opt/hudoori/data/hudoori-db.json.
Daily Backups: In data/backups/, keeping the last 30 copies.
Logs: journalctl -u hudoori -f.


## Important Notes:
----------------
* HTTPS on local networks: With a self-signed Caddy certificate, you need to install the root certificate once on each phone. If you have a public domain, Let's Encrypt requires no phone setup. If you don't want to open ports, Cloudflare Tunnel or Tailscale are great alternatives.
* Server Security: It listens on 127.0.0.1 only, and Caddy receives port 443 traffic. Close port 8080 in your firewall.
* External Backup: The database file on the server is unencrypted, so periodically copy the data/ folder to another device.
* Migrating from Google: Export an encrypted settings backup from your old version, then restore it on the new site via Admin $\leftarrow$ Restore Backup.


# How many courses and students can this system handle managing at the same time?

The answer depends on the deployment environment. I measured performance on experimental databases after a full semester, on a local server on the same machine without a real network.

## On a Local Ubuntu Server

| Test Scale | Database Size | Student Response |
| --- | --- | --- |
| **150 students working together** | — | **6 ms** |
| **500 students and 30 courses** ($\approx$30,000 attendance records) | **8 MB** | ~950 req/sec, with the slowest 5% at **0.28 seconds** |
| **3,000 students and 100 courses** ($\approx$214,000 records) | **56 MB** | ~640 req/sec, with the slowest 5% at **0.6 seconds** |

* **First measurement:** Before optimization, the server read the database file from the disk for every request, which dropped performance to about 13 req/sec and caused delays reaching up to 36 seconds with 150 students. Therefore, I added an in-memory cache, deferred disk writes (every 1.5 seconds, with immediate saving upon shutdown), and gzip compression to the server.
* **Measurement after optimization:** All numbers in the table are post-optimization, included in the updated package I sent you. I verified that data persists after reboot.
* **Practical limit:** A few thousand students and hundreds of courses run easily. The real limit for a single course is the lecturer's interface: a room with hundreds of students works, but a long live attendance list will feel heavy on a mobile screen.
* **What gets strained first:** The admin dashboard loads all attendance records at once. At 3,000 students and a full semester, the response size reached about 54 MB (taking 2 seconds), which slows down mobile devices. Up to around 1,000 students is acceptable; beyond that, pagination/lazy-loading for records is needed, which I can add if required.
* **Actual statistics:** This measurement does not account for a burst of simultaneous QR scans. Actual attendance registration is relatively heavy on writes, but with the database in memory, I do not foresee any issue for several hundred requests per minute.
* **Known flaw:** Any rejected request (wrong password or outside the geographical range) causes the server to reload the database from the disk. If many rejected requests flood in with a huge database, it will momentarily slow down.

### On Google Apps Script

I haven't measured this directly; these are estimates based on Google's limits:

* Each request takes **0.5 to 2 seconds**.
* The maximum concurrent execution limit is **30**.
* Therefore, it handles around **100 to 150 active students** simultaneously; beyond that, responses will be delayed.
* Free accounts are subject to daily quotas.

### Recommendation

* **For a department or college (hundreds of students at once):** Local hosting is clearly more suitable.
* **For a trial or small group:** Apps Script is sufficient.
* In both cases, let real-world load be your benchmark: test it yourself by having dozens of devices connect to a live QR session during the first lecture.
