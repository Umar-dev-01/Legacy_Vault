# Amanah · go-live setup (about 20 minutes)

| File | What it is |
|---|---|
| `index.html`, `style.css`, `script.js` | The website |
| `Code.gs` | The backend: stores wills, sends reminders and delivers wills. Runs free on Google |
| `SETUP.md` | This guide |

Why a backend? HTML, CSS and JS only run while someone has the page open. Sending an email on day 90, when nobody is visiting, needs something that runs on its own. Google Apps Script does that for free, using a Google Sheet as the database and Gmail to send.

---

## 1. Put the website online
1. Go to **app.netlify.com/drop** and sign in.
2. Drag the folder with `index.html`, `style.css` and `script.js` onto the page.
3. Copy your site address, for example `https://amanah-will.netlify.app/`

GitHub Pages, Hostinger or any static host works too.

## 2. Create the database
1. Make a **separate Gmail account** for the service, for example `amanah.wills@gmail.com`. Every email goes out from this account.
2. Signed in to that account, open **sheets.new** and name the sheet `Amanah Database`.

## 3. Add the backend
1. In the sheet: **Extensions → Apps Script**.
2. Delete everything in the editor and paste all of `Code.gs`.
3. Change this line to your site address from step 1 (keep the `/` at the end):
   ```js
   SITE_URL: 'https://amanah-will.netlify.app/',
   ```
4. Press **Ctrl + S** to save.

## 4. Run setup once
1. In the function dropdown at the top, choose **setup**, then click **Run**.
2. Click **Review permissions** → choose the account → **Advanced** → **Go to project (unsafe)** → **Allow**.
   Google says "unsafe" for every personal script that isn't published. It's your own code.
3. The log should say **Setup done**. A `Wills` tab and an hourly check now exist.

## 5. Publish the backend
1. **Deploy → New deployment** → gear icon → **Web app**.
2. **Execute as:** Me. **Who has access:** Anyone.
3. Click **Deploy** and copy the **Web app URL** (it ends with `/exec`).

## 6. Connect the website
1. Open `script.js` and paste the URL on this line:
   ```js
   API_URL: 'https://script.google.com/macros/s/XXXXXXXX/exec',
   ```
2. Also replace `hello@yourdomain.com` in `index.html` with your contact email.
3. In Netlify, open your site → **Deploys** → drag the folder into the box again.

The yellow "Preview mode" bar disappears. The site is live.

## 7. Test without waiting 90 days
1. On your site, write a will with **your own email**, and a **second email of yours** as the person who receives it. Confirm it from your inbox.
2. In `Code.gs` set `TEST_EMAIL` to your email and save.
3. With `TEST_SKIP_DAYS = 76`: run **testSkipDays**, then run **hourlyCheck** → you get the "14 days left" reminder.
4. Set `TEST_SKIP_DAYS = 13`, save, run **testSkipDays** + **hourlyCheck** → you get the last reminder.
5. Set `TEST_SKIP_DAYS = 1`, save, run both again → your second email receives the will.

## Changing the backend later
After editing `Code.gs`: **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. The URL stays the same.

## Limits to know
- A free Gmail account can send about **100 emails a day** from a script. Google Workspace allows about 1,500. The backend keeps 25 a day in reserve so reminders and deliveries never get blocked by sign-ups.
- Each email address can have one open will at a time. Signing up again just re-sends the link.
- **You can read every will in the sheet.** Say so in your privacy policy, and never share the sheet.
- This is a student-scale setup. For thousands of users, move to a real server and database (for example Firebase or Supabase) with encryption.
# Amanat