<p align="center">
  <img src="assets/brand/kobo-animated.svg" width="160" alt="Kobo, the RecoverKit homing pigeon">
</p>

<h1 align="center">RecoverKit</h1>

<p align="center">
  <b>Find the customers you're already losing, and bring them back.</b><br>
  A sales-recovery SDK and read-only connector for websites and apps.
</p>

<p align="center">
  <a href="https://github.com/Light8749/recoverkit/actions/workflows/ci.yml"><img src="https://github.com/Light8749/recoverkit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.13-339933" alt="Node 22.13+">
  <img src="https://img.shields.io/badge/PHP-%E2%89%A57.4-777BB4" alt="PHP 7.4+">
  <img src="https://img.shields.io/badge/server-all%20rights%20reserved-lightgrey" alt="Server license: all rights reserved"> <img src="https://img.shields.io/badge/SDKs-MIT-green" alt="SDKs and connectors: MIT">
</p>

---

Every business with a website or app has people who:

- **signed up and never bought**
- **funded a wallet and never made a purchase**
- **bought once and quietly disappeared**

They're warm leads, and almost nobody follows up with them. RecoverKit finds them, works out who *really* paid, and drafts a short, human follow-up in the business's own voice (Pidgin included). The business approves it, RecoverKit sends it over WhatsApp, SMS or email, and any sale that follows is counted as recovered revenue.

Built for digital businesses in Nigeria first, including VTU sites, online stores, fintech, betting and subscription apps, and designed to work anywhere.

## Highlights

- 🔒 **Your data stays yours.** Emails and phone numbers are hashed on the device or your server before anything leaves. For existing businesses, a **read-only connector** reads your database where it lives, and nothing is exported.
- 💳 **A payment is not a sale.** On a VTU site, a wallet top-up isn't a purchase. Each business defines what a real sale is, so RecoverKit never chases someone who already paid.
- 🧩 **Fits how you already build.** Laravel, WordPress/WooCommerce (including guest checkouts), Django, Rails, Node/Prisma/Mongoose, Spring Boot and ASP.NET. MySQL/MariaDB, PostgreSQL, SQLite and MongoDB.
- 💸 **Any payment gateway.** Built-in presets for Paystack, Flutterwave, Monnify, Korapay, Squad and Stripe, plus a custom option for any gateway that signs its webhooks.
- 🤖 **Any AI model, or none.** Claude, OpenAI, Gemini, or any OpenAI-compatible API (Groq, DeepSeek, Mistral, Ollama…). The model never sees names, emails or phone numbers.
- ✅ **Human in the loop.** Every message can require approval. Right before sending, RecoverKit checks again that the person hasn't paid, opted out or been messaged recently.
- 📈 **Pay on results.** Recovered revenue is attributed automatically, so the business can be charged a percentage of what actually came back.

## How it works

```
 Your website / app        Your payment gateway        Your server / database
 ──────────────────        ────────────────────        ──────────────────────
 Browser or React Native   Webhooks (signed)           trackPurchase() from your code,
 SDK: page views, checkout                             or the read-only connector for
 starts, identify()                                    your existing history
        │                          │                              │
        └──────── hashed IDs, event types, dates, amounts ────────┘
                                   │
                              RecoverKit
          join identities → who really paid → funnel stages → ranked leads
                                   │
                 AI drafts in your voice → you approve → WhatsApp / SMS / email
                                   │
                    sale within 7 days of a message = recovered revenue
```

Browser signals alone are never trusted as proof of purchase. Only signed webhooks, your own server, or your database can say a sale happened.

## Quick start

Requires **Node.js 22.13+** (Node 24 recommended) and, for the PHP connector and its tests, **PHP 7.4+** with PDO.

```bash
git clone https://github.com/Light8749/recoverkit.git && cd recoverkit
npm install
npm run demo          # dashboard with sample data at http://localhost:8790
                      # sign in: demo@recoverkit.test / demo-password-123
```

Running it for real:

```bash
npm run cli -- init                                     # writes .env with a random master key (back it up)
npm run cli -- create-project "My Business" deposits    # 'deposits' for VTU/fintech/betting, 'sales' for stores
npm run cli -- create-user <projectId> you@business.ng  # dashboard login
npm start                                               # http://localhost:8787
```

Then add RecoverKit to your app:

```html
<script src="https://YOUR-RECOVERKIT-HOST/sdk/recoverkit.js"></script>
<script>RecoverKit.init({ key: 'rk_pub_...' });</script>
```

```php
// After the real sale happens (for example, your VTU vendor API returned success):
$rk->trackPurchase(['email' => $user->email, 'amount' => $amountKobo, 'ref' => $order->reference]);
```

…and bring in your existing customers with the read-only connector:

```bash
php sdk/php/recoverkit-connector.php setup --app=/path/to/your/app   # SQL databases
npx recoverkit-connector setup --app=/path/to/your/app              # MongoDB
```

Setup reads only table and field **names**, suggests what counts as a sale, shows a dry run ("12,403 people · 3,210 bought · 9,193 never bought"), and waits for you to confirm. The full walkthrough is in **[docs/GUIDE.md](docs/GUIDE.md)**.

## For a business's developer

You don't need this repository to connect an app. Everything comes from the RecoverKit server the business uses:

| You need | Where it comes from |
|---|---|
| Server address, public key, secret key | The business owner: dashboard → **Developers** (they can send you a guide link with everything filled in) |
| Website script | `https://THEIR-RECOVERKIT-HOST/sdk/recoverkit.js` |
| Node.js server SDK | `npm install recoverkit` |
| PHP server SDK and SQL connector | `https://THEIR-RECOVERKIT-HOST/sdk/recoverkit-php.zip`, or the single files under `/sdk/php/` |
| MongoDB connector | `npx recoverkit-connector@1 setup --app=.` |
| Any other language | The HTTP API: `https://THEIR-RECOVERKIT-HOST/docs` |

The SDKs and connectors are **MIT-licensed**, so you can ship them in your app.

## What's in the box

| Part | Path |
|---|---|
| Server, ingestion API, webhooks, AI drafting, sending, dashboard | `src/` |
| Browser SDK (one `<script>`) and React Native SDK | `sdk/browser`, `sdk/react-native`, `sdk/core` |
| Server SDKs | `sdk/node`, `sdk/php` (Laravel-friendly) |
| Read-only connector for SQL databases (PHP, or Docker) | `sdk/php/recoverkit-connector.php`, `sdk/php/Dockerfile` |
| Read-only connector for MongoDB (Node, `npx`) | `sdk/connector-node` |
| Brand: Kobo the mascot (static, animated, app icon) | `assets/brand` |
| Tests | `test/`, `sdk/connector-node/test` |

## Security and privacy

RecoverKit is built so a business never has to hand over raw customer data:

- **Hashing:** emails and phone numbers are hashed with a per-project salt, then given a secret server-side pepper before storage.
- **Encrypted storage:** contact details, gateway secrets and AI keys are encrypted with AES-256-GCM.
- **Signed webhooks:** every webhook needs a valid signature, and replayed events are ignored.
- **Read-only connectors:** a read-only login, a read-only session, `SELECT` (or find) only, every query logged, and an automatic stop if the database schema changes.
- **Locked-down dashboard:** strict CSP, CSRF protection, `SameSite=Strict` cookies, rate-limited logins, and no JavaScript.
- **Network protection:** checks that block server-side request forgery on custom AI endpoints.

The threat model, the protection for each threat, and the known limits are in **[SECURITY.md](SECURITY.md)**. Please report vulnerabilities privately (see SECURITY.md), not in public issues.

## Tests

```bash
npm test             # unit + end-to-end: real HTTP server, SQLite, and an embedded PostgreSQL 17
npm run test:mysql   # the connector against MySQL/MariaDB (set RK_TEST_MYSQL_DSN; see the test file)
npm run test:mongo   # the MongoDB connector against a real mongod (downloaded automatically)
npm run check        # syntax check of every JS file, the browser bundle and the PHP files
npm run check:ai     # one real call to your AI model (needs your API key; costs a few kobo)
```

CI runs every suite on each push, against real MariaDB, PostgreSQL and MongoDB.

## Roadmap

- [x] Three-layer purchase detection (browser, webhooks, server)
- [x] Configurable gateways and any-provider AI drafting
- [x] Read-only connector for SQL databases and MongoDB, including WooCommerce, guest checkouts and embedded orders
- [ ] Send through the connector, so contact details never leave the business's server
- [ ] Inbound WhatsApp replies ("STOP", questions) in the dashboard
- [ ] Hosted demo
- [ ] SQL Server support

## Contributing

Issues and ideas are very welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)** before opening a pull request.

## License

**SDKs and connectors (`sdk/`): MIT.** Businesses that use RecoverKit, and their developers, can use them freely in their own apps. See [sdk/LICENSE](sdk/LICENSE).

**The server (everything else): all rights reserved.** Copyright © 2026 Light8749. The source is public so you can read it, evaluate it and run it locally. You may not use it in production, redistribute it, or offer it as a service without written permission. See [LICENSE](LICENSE).

Third-party materials keep their own licenses: the Apple HIG skills and the animation-principles skills in `.claude/skills` are MIT-licensed, and their license files are included.
