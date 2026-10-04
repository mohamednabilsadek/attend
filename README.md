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
