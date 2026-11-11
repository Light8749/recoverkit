# Put RecoverKit online with cPanel (free if you already have hosting)

You need cPanel hosting that has **Setup Node.js App** with **Node.js 22.13 or newer** (24 is best). It runs on a subdomain such as `recover.yourvtusite.com`, with free HTTPS.

## 1. Make the subdomain and its HTTPS

1. cPanel → **Domains** (or **Subdomains**) → create `recover.yourvtusite.com`. Any document root is fine; RecoverKit doesn't use it.
2. cPanel → **SSL/TLS Status** → tick the new subdomain → **Run AutoSSL**. Wait until it shows a padlock, which can take a few minutes.

## 2. Upload the app (outside public_html)

1. cPanel → **File Manager** → open your **home folder** (the one that *contains* `public_html`, not `public_html` itself).
2. **Upload** `recoverkit-cpanel.zip`, then right-click it → **Extract**. You'll get a folder called `recoverkit`.

Keeping it outside `public_html` means nobody can download your database or `.env` from the web.

## 3. Create the Node.js app

cPanel → **Setup Node.js App** → **Create Application**:

| Field | Value |
|---|---|
| Node.js version | the highest offered, **22.13 or newer** |
| Application mode | Production |
| Application root | `recoverkit` |
| Application URL | `recover.yourvtusite.com` |
| Application startup file | `app.cjs` |

Click **Create**. Then, on the same page, click **Run NPM Install** and wait for it to finish.

## 4. Create your keys and your login (cPanel Terminal)

At the top of the app's page, cPanel shows a command like `source /home/USER/nodevenv/recoverkit/24/bin/activate && cd /home/USER/recoverkit`. Copy it.

cPanel → **Terminal**. Paste that command, then run these one at a time:

```bash
node src/cli.js init --public-url=https://recover.yourvtusite.com
node src/cli.js create-project "Your VTU name" deposits
node src/cli.js create-user prj_XXXX you@youremail.com
```

- `init` creates `.env` with your master key. **Download a copy of `.env` somewhere safe.** Without it, the encrypted data can't be read.
- `create-project` prints your **public key** and **secret key**. Save the secret key now; it's only shown once. Use `deposits` for VTU, betting or fintech, and `sales` for a store.
- `create-user` asks for a dashboard password (12+ characters). Use the `prj_…` id from the step before.

## 5. Start it

Back in **Setup Node.js App**, click **Restart**. Open `https://recover.yourvtusite.com/login` and sign in.

## 6. Become the admin, so you can add businesses

In the cPanel Terminal (after the `source … && cd …` command from step 4):

```bash
node src/cli.js make-admin you@youremail.com
```

Sign in again: **Businesses** is now in the sidebar. Add each business there; you don't need the terminal for that any more.

To email invites and password resets, add this line to `recoverkit/.env` (use an address on your own domain), then **Restart**:

```
RK_MAIL_FROM=RecoverKit <no-reply@yourvtusite.com>
```

That uses your hosting's sendmail. For better delivery, use an SMTP service such as **Brevo** (free for 300 emails a day). Add these lines too, with the SMTP login and SMTP key from Brevo → **SMTP & API**, and make sure the RK_MAIL_FROM address is a verified sender in Brevo:

```
RK_SMTP_HOST=smtp-relay.brevo.com
RK_SMTP_PORT=587
RK_SMTP_USER=your-login@smtp-brevo.com
RK_SMTP_PASS=your-brevo-smtp-key
```

Restart, then click **Send a test email** on the Businesses page.

If it says `ECONNREFUSED …:587`, your host blocks outgoing SMTP (common on shared hosting). Use Brevo's API instead, which goes over normal HTTPS: in Brevo → **SMTP & API → API Keys**, create a key, then replace the four `RK_SMTP_…` lines with one line and Restart:

```
RK_BREVO_API_KEY=xkeysib-...
```

If the test then says the IP address isn't recognised, allow your server's IP in Brevo → **Security → Authorised IPs**.

Without RK_MAIL_FROM, the Businesses page shows each link for you to send by WhatsApp.

## Keep it safe

- **Back up** `recoverkit/.env` and `recoverkit/recoverkit.db` regularly (cPanel → **Backup**, or download them).
- **To update RecoverKit:** upload a new zip, extract it over the old folder (your `.env` and database stay), then **Run NPM Install** and **Restart**.
- **If it doesn't start:** check `recoverkit/stderr.log` in File Manager. "Cannot find module node:sqlite" means the Node version is older than 22.13; pick a newer one under Setup Node.js App.
