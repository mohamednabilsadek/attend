# Hudoori | University Attendance Management System
**Bilingual web platform for managing student attendance across university courses and class groups**

> **Document status:** This guide reorganizes the deployment and operational information available in the original project notes. The application source code itself has not been independently reviewed, so this document does not certify that every described feature has been security-tested.

---

## Contents

1. [Overview](#1-overview)
2. [Deployment Options](#2-deployment-options)
3. [Requirements](#3-requirements)
4. [Deploy with GitHub Pages and Google Apps Script](#4-deploy-with-github-pages-and-google-apps-script)
5. [Self-Host on Ubuntu](#5-self-host-on-ubuntu)
6. [Backups and Data Recovery](#6-backups-and-data-recovery)
7. [Performance and Expected Capacity](#7-performance-and-expected-capacity)
8. [Security Considerations](#8-security-considerations)
9. [Troubleshooting](#9-troubleshooting)
10. [Pre-Launch Checklist](#10-pre-launch-checklist)

---

## 1. Overview

**Hudoori** is a web project for recording and reviewing student attendance across university courses and lectures. The original project notes describe two deployment options:

1. **Simple hosted deployment:** The website runs on GitHub Pages, while Google Apps Script provides the backend and stores data in a dedicated file on Google Drive.
2. **Self-hosted deployment:** A Node.js server on Ubuntu serves the website and API and stores data locally on the server.

### Project goals

- Browser-based access from desktop and mobile devices.
- Arabic and English interfaces.
- User account management according to the roles supported by the application.
- Attendance recording and review.
- Backup and recovery, depending on the deployment method.

> **Important:** Verify the exact roles, permissions, and attendance workflow in the actual application source code before adopting the system for official university use.

---

## 2. Deployment Options

| Option | Suitable for | Advantages | Considerations |
|---|---|---|---|
| GitHub Pages + Google Apps Script | A pilot or small group | Simple setup; no Ubuntu server administration | Subject to Apps Script quotas and concurrent-execution limits |
| Ubuntu + Node.js + HTTPS | A department, faculty, or broader internal deployment | More control over hosting, data, and server configuration | Requires server maintenance, security updates, and reliable backups |

**Practical recommendation:** Start with a limited pilot, then run realistic load tests before using the system in large lectures or relying on its records officially.

---

## 3. Requirements

### Google Apps Script deployment

- A Google account with access to Google Drive.
- A Google Apps Script project.
- A GitHub repository containing the website files.
- A deployed Web App URL ending in `/exec`.
- HTTPS, so supported browsers can request camera and location permissions.

### Ubuntu deployment

- An Ubuntu server.
- Node.js version 16 or later according to the original guide; use a currently security-supported release where possible.
- The `hudoori-selfhost` package.
- Administrative permissions for installation and systemd service configuration.
- Caddy or an equivalent HTTPS solution.
- Sufficient disk space for the database and backups.

---

## 4. Deploy with GitHub Pages and Google Apps Script

### Step 1: Create an Apps Script project

1. Open [Google Apps Script](https://script.google.com).
2. Create a new project.
3. Paste the contents of `Code.gs` into the project.
4. Replace the default `SETUP_CODE` value with a strong, unique secret.
5. Save the project.

### Step 2: Authorize and deploy the Web App

1. Run the `authorize` function and grant the required permissions after reviewing them.
2. Select **Deploy → New deployment → Web app**.
3. The original guide specifies these settings:
   - **Execute as:** Me
   - **Who has access:** Anyone
4. Deploy the app and save the URL ending in `/exec`.

> **Security warning:** Setting access to **Anyone** may expose the API endpoint to the public internet. Do not use this configuration for a real university deployment until authentication, authorization, abuse protection, and data-access controls have been reviewed and tested.

### Step 3: Connect the website to the API

1. Open `pages/config.json`.
2. Replace `PASTE_WEB_APP_URL_HERE/exec` with the deployed Web App URL.
3. Validate the JSON and ensure the URL contains no extra characters or spaces.

The original guide also describes opening the page with a URL parameter:

```text
index.html?api=<exec_url>
```

### Step 4: Publish with GitHub Pages

1. Upload the required website files, including `index.html` and `config.json`, to the repository.
2. Open **Settings → Pages**.
3. Select the `main` branch and `/root` folder if that matches the repository layout.
4. Wait for deployment to finish, then open the website over HTTPS.
5. Test database creation, sign-in, lecturer creation, and student registration using test accounts.

### Step 5: Initial setup

1. Open the website.
2. Go to **Admin → Create Database**.
3. Enter the setup details and `SETUP_CODE`.
4. Add lecturer accounts through the administration interface.
5. Test student registration and verify permissions.

### Updating Apps Script

After changing `Code.gs`:

1. Open **Deploy → Manage deployments**.
2. Select the existing deployment and choose **Edit**.
3. Create a new version.
4. Test the API after deployment.

---

## 5. Self-Host on Ubuntu

According to the original guide, the package uses a single Node.js server to serve the website and API. The documented data path is:

```text
/opt/hudoori/data/hudoori-db.json
```

Daily backups are described as being stored under `data/backups/`, retaining the latest 30 copies. Verify these paths against the actual package before running commands or performing maintenance.

### Step 1: Copy the package and install the service

Copy the package directory to the server, then run the following commands after confirming the source and paths:

```bash
scp -r hudoori-selfhost user@SERVER:~/
ssh user@SERVER
cd hudoori-selfhost
sudo bash install.sh
```

### Step 2: Set the setup secret

Open the environment file:

```bash
sudo nano /opt/hudoori/hudoori.env
```

Set `SETUP_CODE` to a strong, unique secret. Do not leave the default placeholder in place, and never commit the secret to GitHub or publish it in a public file.

### Step 3: Start and verify the service

```bash
sudo systemctl enable --now hudoori
systemctl status hudoori
```

The original guide suggests this initial local test:

```bash
curl -s localhost:8080/api -d '{"op":"status"}'
```

If the service does not work, inspect the logs:

```bash
journalctl -u hudoori -f
```

### Step 4: Configure HTTPS with Caddy

Browsers generally require HTTPS for camera and location access, except in trusted contexts such as `localhost`.

**Internal network only:** You can configure an internal name such as `hudoori.lan` with a local certificate. Devices must trust the relevant Caddy certificate authority; otherwise, browser warnings may appear and permissions may fail.

**Public domain:** Use a domain you control with Caddy and Let's Encrypt after configuring DNS and allowing the required traffic on ports 80 and 443.

**Without directly opening inbound ports:** Consider Cloudflare Tunnel or Tailscale, depending on network policy and privacy requirements.

> Keep port `8080` inaccessible from the internet. The original guide says the application listens on `127.0.0.1` and Caddy receives HTTPS traffic. Verify the actual listener and firewall rules on the server.

### Step 5: First launch

1. Open the website over HTTPS.
2. Go to **Admin → Create Database**.
3. Enter the setup secret configured in the environment file.
4. Create test accounts and verify the core workflows before entering real data.

### Updating the application

After reviewing the changes and taking a backup:

1. Update the application files using the approved release procedure.
2. Do not overwrite the data directory.
3. Restart the service:

```bash
sudo systemctl restart hudoori
```

4. Check service status and logs, then test sign-in, attendance, and backup functions.

---

## 6. Backups and Data Recovery

### Google Apps Script deployment

- Use **Export Encrypted Backup** in settings when available.
- Store the backup in a private, secure location outside the public repository.
- Test recovery periodically in a test environment, not directly on the production database.

### Ubuntu self-hosted deployment

- The original guide describes daily backups retaining the latest 30 copies. Verify that backups are completing and can be restored.
- Copy data periodically to a location separate from the server.
- Restrict access to database and backup files.
- The local database file is described as **unencrypted**. Protect it with appropriate file permissions and suitable encryption for storage and off-server backups.

### Migrating from Google to Ubuntu

According to the original guide:

1. Export an encrypted backup from the old version's settings.
2. Open the Ubuntu deployment.
3. Select **Admin → Restore Backup**.
4. Follow the restore process using the new setup secret.
5. Verify user, course, and attendance-record counts after recovery.

Do not consider the migration complete until data integrity and consistency have been checked.

---

## 7. Performance and Expected Capacity

The figures below come from experimental measurements described in the original project notes. They are not production guarantees. Actual results depend on server hardware, network conditions, client devices, and request patterns.

| Scenario in the original guide | Database size | Reported result |
|---|---:|---|
| 500 students and 30 courses, approximately 30,000 records | 8 MB | About 950 requests/second; slowest 5% around 0.28 seconds |
| 3,000 students and 100 courses, approximately 214,000 records | 56 MB | About 640 requests/second; slowest 5% around 0.6 seconds |

The guide notes that these measurements were obtained in a local test environment. An administration dashboard that loads all attendance records at once may become slow as the database grows.

### Recommendations before scaling up

- Run load tests on the actual server and network.
- Test simultaneous QR attendance scans from dozens of devices.
- Add pagination or lazy loading if record volumes become large.
- Monitor response time, memory usage, disk space, and API errors.
- Test rejected requests, repeated login attempts, and network interruptions.

---

## 8. Security Considerations

This is an initial review checklist, not a claim that the application already implements every control listed below.

- **Authentication and authorization:** Ensure every administrative or academic operation verifies the user's identity and permissions on the server, not only in the browser.
- **Data protection:** Never place databases, backups, or secrets in a public repository.
- **Setup secret:** Use a strong, unique secret and rotate it if exposed. Do not rely on a secret embedded in public frontend files.
- **Password storage:** Review password storage and reset procedures. The original guide says passwords are hashed using the email; this design should be audited before production use. Email alone should not be used as a secure password-derivation secret.
- **Privacy:** Collect only the student data needed, and define who can access attendance records and how long they are retained.
- **Camera and location:** Explain why permissions are requested and how the data is used. Test behavior when permission is denied.
- **Audit trail:** Consider logging important administrative actions and attendance-record changes, including the actor and timestamp.
- **Updates:** Keep the operating system, Node.js, and dependencies updated; review HTTPS and firewall configuration regularly.
- **Backups:** Test restoration rather than merely checking that backup files exist.
- **Institutional approval:** Perform a security, authorization, and privacy review before using the system for official university records.

---

## 9. Troubleshooting

| Problem | What to check |
|---|---|
| Camera or location does not work | Open the site over HTTPS and check browser and device permissions |
| Website cannot reach the API | Verify the `/exec` URL in `config.json`, deployment status, and browser network errors |
| Ubuntu service is not running | Run `systemctl status hudoori`, then inspect `journalctl -u hudoori -f` |
| Data appears missing after restart | Check the data path, file permissions, service logs, and backups |
| Errors occur after an Apps Script update | Deploy a new version, verify the Web App URL, and test core operations |
| System slows down with many records | Inspect response size and server performance; consider pagination or lazy loading |
| HTTPS certificate warnings appear internally | Verify the hostname and certificate, and confirm the device trusts the certificate authority |

---

## 10. Pre-Launch Checklist

- [ ] Test Arabic and English interfaces and RTL/LTR direction.
- [ ] Test the layout on a small phone, tablet, and desktop.
- [ ] Test administrator, lecturer, and student roles with separate accounts.
- [ ] Confirm students cannot modify records or data outside their permissions.
- [ ] Test course, class-group, and lecture management according to the application's actual features.
- [ ] Test attendance recording and duplicate prevention if required.
- [ ] Test camera and location access both when permissions are granted and when denied.
- [ ] Test backup and restore in a non-production environment.
- [ ] Ensure no secrets or student data are exposed in a public repository.
- [ ] Run realistic load tests and review logs and errors.
- [ ] Document the system owner, support process, update procedure, and recovery plan.
- [ ] Obtain the required university approvals before processing real student data.

---

## Project Information

- **Name:** Hudoori
- **Type:** University attendance management web application
- **Languages:** Arabic and English, according to the project description
- **Interface:** Browser-based and intended for mobile devices; actual compatibility should be tested
- **Deployment options:** GitHub Pages + Google Apps Script, or self-hosted Ubuntu

**Final note:** This guide organizes the available deployment and operations notes. To redesign the user interface, modify attendance logic, or conduct a security review, the actual source files are required, including `index.html`, `Code.gs`, `server.js`, and relevant configuration files.
