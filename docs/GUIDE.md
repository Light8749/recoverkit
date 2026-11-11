# RecoverKit: full guide

Finds the people a digital business is losing — **registered but never bought**, and **bought once then went quiet** — and drafts human follow-up messages in the business's own voice. The business approves them, RecoverKit sends them, and recovered sales are counted automatically.

Built for VTU sites, fintech apps, e-commerce stores, betting platforms and subscription services.

## Quick start

Requires Node.js 22.13+ (Node 24 recommended: `nvm use`).

```bash
npm install
npm run cli -- init                                # writes .env with a random master key (back it up)
npm run cli -- create-project "My VTU" deposits    # prints public + secret keys
npm run cli -- create-user <projectId> you@yourbusiness.ng
npm start                                          # http://localhost:8787/dashboard
```

Want to look around first? `npm run demo` starts a dashboard with sample data at http://localhost:8790. Sign in as `demo@recoverkit.test` with password `demo-password-123`.

Each business picks its own AI model under **Dashboard → AI model**. There's also a server-wide default (see *AI models* below). With no model set, built-in templates are used.

## Adding businesses and logins

Make your own login the server admin once: `npm run cli -- make-admin you@yourbusiness.ng`. Sign in again and **Businesses** appears in the sidebar:

- **Add a business:** name, wallet deposits or sales, and the owner's email. The owner gets a link (valid 7 days) to choose their password. With `RK_MAIL_FROM` set it's emailed; it's always shown to you as well, to send by WhatsApp.
- **A business's page:** whether their website, gateways and connector are connected, recovered revenue, their logins, **Add a login** for a colleague, and **Reset link** / **New invite link** for anyone locked out.

Everyone can change their password under **Settings → Password** (other devices are signed out), and **Forgot your password?** on the sign-in page emails a one-hour link. Links are single-use and only their hashes are stored; a new link cancels the previous one. Without email set up, `npm run cli -- reset-link <email>` prints one.

## Onboarding a business's developer

The developer never needs this repository or the server code. In the dashboard, the business owner opens **Developers**, which shows every step with their own keys and server address filled in:

1. **Send this to your developer:** a guide link (valid 30 days) with the public key and server address. It contains no secret key and no data.
2. **Create a secret key for your developer:** shown once, labelled `developer` in Settings, revocable at any time. Send it privately.

The developer then adds the website script, records real sales from their server (`npm install recoverkit`, the PHP file, or the HTTP API from any language), and runs the read-only connector for past customers. The PHP SDK and connector download straight from the RecoverKit server (`/sdk/recoverkit-php.zip` or `/sdk/php/<file>`), and every server publishes the API reference at **`/docs`**. The SDKs and connectors are MIT-licensed, so they can ship in the business's app.

## How a real purchase is detected: three layers

| Layer | Where it looks | Setup | Trusted as a purchase? |
|---|---|---|---|
| 1. Browser / app | Page views, checkout clicks, form submits (names only), "payment successful" screens | One `<script>` + `init()` | **Never.** A success screen only lowers confidence so we don't chase someone who may have paid. |
| 2. Webhooks | Paystack `charge.success`, Flutterwave `charge.completed` | Paste a URL in the gateway dashboard, enter the secret in Settings | Yes, signature-checked |
| 3. Server | Your own purchase code, e.g. after the VTU vendor API returns success | One line | Yes, exact |

A webhook and a server call for the same payment become one purchase (matched on the payment reference, or same person + amount within 15 minutes).

**VTU, betting and fintech:** set the project to `deposits` mode. Gateway payments then count as *wallet funding*, not sales, and only `trackPurchase` from your server counts as a sale. "Funded wallet, never bought" becomes one of your best lead groups. You can override per payment with Paystack/Flutterwave metadata `recoverkit_kind: "sale"` or `"deposit"`.

### Layer 1: website

```html
<script src="https://YOUR-RECOVERKIT-HOST/sdk/recoverkit.js"></script>
<script>
  RecoverKit.init({ key: 'rk_pub_...' }); // endpoint defaults to the server the script came from
  // after login or signup:
  RecoverKit.identify({ email: user.email, phone: user.phone });
</script>
```

Optional: `data-rk-event="viewed_plan"` on any element, `RecoverKit.checkoutStarted(amountInKobo)`, `RecoverKit.reset()` on logout. Respects Global Privacy Control / Do Not Track.

### Layer 1: React Native / Expo

```js
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RecoverKit } from './sdk/react-native/index.js';
RecoverKit.init({ key: 'rk_pub_...', endpoint: 'https://YOUR-RECOVERKIT-HOST', storage: AsyncStorage });
RecoverKit.screen('Pricing');
RecoverKit.identify({ email, phone });
```

### Layer 2: any payment gateway

Go to **Dashboard → Payments → Add a gateway**. Connect as many gateways as you use. Each one gets its own webhook URL (`/v1/webhooks/gw_…`) to paste into that gateway's dashboard.

- **Presets:** Paystack, Flutterwave, Monnify (Moniepoint), Korapay, Squad (GTCO) and Stripe. Each preset is just a pre-filled form, and every field can be edited.
- **Other gateway (custom):** for Remita, Interswitch, OPay, a bank, an in-house wallet, or anything that signs its webhooks. You describe:
  - **the signature:** HMAC (SHA-256, SHA-512 or SHA-1, hex or base64, over the whole body or one JSON field), a shared-secret header, or a Stripe-style timestamped signature. Up to two methods; either can pass.
  - **which webhooks count:** the event field and values, and the status field and success values.
  - **where the details are:** dotted paths for reference, amount, currency, email, phone, name, time and event ID.
  - **the amount unit:** kobo/cents or naira/dollars.
- Unsigned webhooks are never accepted. Each gateway shows when its last webhook arrived and what happened to it, so you can debug the setup. Gateways can be switched off or removed.

Check the field paths against your gateway's current webhook docs. Gateways change their payloads.

### Layer 3: your server

Node:

```js
import { RecoverKit } from 'recoverkit'; // npm install recoverkit
const rk = new RecoverKit({ publicKey: 'rk_pub_...', secretKey: process.env.RK_SECRET_KEY, endpoint: 'https://YOUR-RECOVERKIT-HOST' });
await rk.identify({ email: user.email, phone: user.phone, firstName: user.firstName }); // on signup
await rk.trackPurchase({ email: user.email, amount: 50000, ref: order.paymentReference }); // amount in kobo
await rk.walletFunded({ email: user.email, amount: 200000 });
await rk.erase({ email: user.email }); // right to erasure
```

PHP / Laravel (`sdk/php/RecoverKit.php`, no dependencies):

```php
$rk = new RecoverKit(env('RK_PUBLIC_KEY'), env('RK_SECRET_KEY'), env('RK_ENDPOINT'));
$rk->identify(['email' => $user->email, 'phone' => $user->phone, 'firstName' => $user->first_name]);
// right after the VTU vendor API returns success:
$rk->trackPurchase(['email' => $user->email, 'amount' => $amountKobo, 'ref' => $order->reference]);
```

SDK calls time out after 3 seconds and never throw by default, so RecoverKit can't break a checkout.

## Existing data: the read-only connector

The SDK and webhooks only see people from the day they're installed. A business with years of customers has its best leads in its own database: people who signed up and never bought, funded a wallet and never bought, or bought once and disappeared. The connector brings those in **without exporting anything**.

It's a small PHP program (`sdk/php/recoverkit-connector.php`, `recoverkit-detect.php` and `RecoverKit.php`) that runs **on the business's own server**:

1. **Setup** (`php recoverkit-connector.php setup`). It reads only table and column **names** (plus row counts and short status labels like `successful`). It asks the business's chosen AI model, through RecoverKit, which table holds users and what counts as a real sale, or falls back to built-in guesses. It shows the answer in plain English, runs a dry run that counts people, buyers and never-bought on their server, and saves `recoverkit-connector.json` once the developer confirms.
2. **Sync** (`php recoverkit-connector.php sync`, from cron every 15 minutes). The first run sends up to 2 years of history (`RK_HISTORY_DAYS`). After that it sends only what's new. Emails and phones are hashed on their server, and only hashes, event types, dates and amounts leave.
3. **A sale is whatever the business says it is.** A row only counts if it matches every filter, for example `status = successful` **and** `service = data or airtime`. Wallet top-ups and payment attempts are sent as signals, never as sales.

**Works with any language or framework.** The connector reads the *database*, not the code, so the app can be PHP, Node, Python, Ruby, Java, .NET or Go. Point `--app` at the project folder and it finds the database login in that framework's own config file:

| Framework | Where it looks |
|---|---|
| Laravel | `.env` (`DB_*` or `DB_URL`) |
| WordPress / WooCommerce | `wp-config.php` (also reads the table prefix) |
| Django | `settings.py` (literal values, `os.environ`, `env()`, `dj_database_url`) |
| Rails | `config/database.yml` (anchors, `<%= ENV[...] %>`, `url:`) |
| Node with Prisma | `prisma/schema.prisma` → `env("DATABASE_URL")`, including SQLite files |
| Spring Boot | `application.properties` / `application.yml` (`jdbc:` URLs, `${VAR:default}`) |
| ASP.NET | `appsettings.json` connection strings |
| Anything else (Express, NestJS, Flask, FastAPI, Go, Rust…) | `DATABASE_URL`, or `DB_HOST` / `DB_NAME` / `DB_USER`, or `PG*` variables in `.env` or the environment |

Databases: **MySQL / MariaDB, PostgreSQL and SQLite** (this PHP connector) and **MongoDB** (the Node connector below). SQL Server and Oracle are detected and reported as not supported yet.

**WooCommerce works out of the box.** WooCommerce's tables are the same in every store, so the connector recognises them and uses a built-in mapping, with no AI and no guessing:
- **Both order layouts:** the older one (`wp_posts` + `wp_postmeta`) and the newer one (`wc_orders`). During a migration, when both hold the same orders, only one is read.
- **What counts:** paid means `completed` or `processing`. Unpaid orders (`pending`, `failed`, `on-hold`, `cancelled`) become abandoned-checkout signals. Refunds and checkout drafts are ignored.
- **Guest checkouts** are matched by their billing email and phone, so a guest who bought once and never came back is a lead.
- **No double counting with Paystack:** the order's transaction ID becomes the payment reference, so it merges with a Paystack webhook for the same payment.

**Guest checkouts and key/value tables, for any app.** A sale or signal can name `emailColumn` / `phoneColumn` on the order row itself (guest buyers). A field can also be written as `meta:<key>` to read it from a key/value side table (like `wp_postmeta`). The connector turns that into a safe read-only join.

```bash
php recoverkit-connector.php detect /var/www/myapp      # see what it found (password hidden)
php recoverkit-connector.php setup --app=/var/www/myapp
php recoverkit-connector.php sync  --app=/var/www/myapp  # cron, every 15 minutes
# Or set everything yourself:
RK_DB_DSN="mysql:host=127.0.0.1;dbname=shop" RK_DB_USER=recoverkit RK_DB_PASS=... php recoverkit-connector.php setup
```

Put `RK_PUBLIC_KEY`, `RK_SECRET_KEY`, `RK_ENDPOINT` and, ideally, a read-only `RK_DB_USER` / `RK_DB_PASS` in the app's `.env` or the environment. A read-only login always wins over the app's own.

**No PHP on the server?** Use the container in `sdk/php/Dockerfile`: `docker build -t recoverkit-connector sdk/php`. The usage notes, including cron, are at the top of that file. The app folder is mounted read-only.

How the business stays safe:
- **Read-only, three ways:** a read-only login (setup warns, and prints the `GRANT SELECT` to create one, if the login could write), a read-only database session, and code that only ever builds `SELECT` statements. Every table and column name must exist in the scanned schema, and every value is a bound parameter.
- **No free-form queries:** nothing on the internet can tell it what to run. It only makes outbound HTTPS calls, and nothing calls in.
- **A log of every query** in `recoverkit-connector.log` on their server.
- **It stops itself** if a mapped table or column disappears, rather than send wrong data.
- **One-click cut-off:** revoke the secret key it uses in Dashboard → Settings. The connector's last syncs show there too.
- **Contact details stay home by default.** Setup asks whether RecoverKit may keep encrypted email, phone and first name so it can send follow-ups. If the answer is no, only hashes leave.

Re-running sync never duplicates anything, because every row has a stable key.

### MongoDB apps: the Node connector

MongoDB apps (usually Node, often Mongoose) use `sdk/connector-node`. It has the same steps, the same mapping and the same safety rules:

```bash
npx recoverkit-connector detect /path/to/your/app       # finds the connection string (credentials hidden)
npx recoverkit-connector setup --app=/path/to/your/app
npx recoverkit-connector sync  --app=/path/to/your/app  # cron, every 15 minutes
# From this repo before it's published: cd sdk/connector-node && npm install && node recoverkit-connector.mjs ...
```

- **Finding the connection string:** `MONGODB_URI` and the usual names in `.env`, the variable the app's own code passes to `mongoose.connect(process.env.X)` or `new MongoClient(...)`, or a Prisma `mongodb` datasource.
- **Learning the layout:** it samples a few documents per collection to learn field names. Only names and short status labels go to the AI.
- **References and dates:** references can be `ObjectId`s, and amounts can be numbers or `Decimal128`. A collection with no `createdAt` field still has dates, because every `ObjectId` contains its creation time.
- **Read-only:** it checks the login has only the `read` role, warns about servers with no login, and prints the `db.createUser` command for a read-only user. It only ever runs finds and read-only aggregations, and refuses `$out` and `$merge`. Field names can't start with `$`, so nothing in the mapping can become a query operator.
- **Orders stored inside user documents** (for example `users.orders: [...]`) are read too, with the parent user as the buyer. Each item is keyed by its own `_id` (Mongoose adds one), so adding orders to the front of a list never duplicates old ones. Wallet top-ups stored the same way become deposit signals.
- **Publishing to npm:** the package is self-contained and tested from a packed tarball. To make `npx recoverkit-connector` work for everyone, run `cd sdk/connector-node && npm login && npm publish` from your own npm account. The name `recoverkit-connector` was free when this was written.

## Identity

Emails are trimmed and lowercased. Nigerian numbers are normalised (`0803…`, `803…`, `+234 0803…` → `234803…`). Each identifier is SHA-256 hashed **on the device or your server**, with the project key mixed in so hashes differ between businesses. The RecoverKit server then applies a secret HMAC pepper before storing, so stored keys can't be reversed by guessing phone numbers. The browser, webhooks and server all produce the same hash, so they join without RecoverKit ever seeing a raw email from the browser.

To *send* messages, RecoverKit needs a way to reach the person. Contact details are accepted **only** from trusted sources (your server's `identify`, or signed webhooks), stored with AES-256-GCM, masked in the dashboard, and **never sent to the AI model** — the model writes `{first_name}` and the name is filled in afterwards.

## AI models

Any business can choose its model under **Dashboard → AI model**, and the choice isn't tied to Claude:

| Provider | How it's called |
|---|---|
| Anthropic Claude | Official `@anthropic-ai/sdk`. Default model `claude-opus-5-5`, with adaptive thinking, structured output, and server-side fallback on supported models. |
| OpenAI | Chat Completions with a strict JSON schema |
| Google Gemini | `generateContent` with a JSON response schema |
| Other (OpenAI-compatible) | Any `/chat/completions` API: Groq, DeepSeek, Mistral, OpenRouter, Together, Fireworks, Ollama, LM Studio, vLLM… Set the base URL. |
| No AI | Built-in templates |

Type any model name your provider offers. API keys are stored encrypted and never shown again. **Test with a sample lead** runs one real draft and shows the result or the exact error. Whatever the provider, the model never receives names, emails or phone numbers. If it fails, or writes a link or phone number, a template is used instead.

## Leads, scoring and confidence

- **Stages:** registered → browsed → checkout abandoned → funded not bought → new customer → repeat customer; customers with no purchase for 30 days become *bought once, gone quiet* or *regulars gone quiet*.
- **Score (0–100):** intent signals (pricing views, checkout, wallet funding, past purchases) plus recency.
- **Confidence that they really haven't paid:** 0.9 with verified purchase data, 0.4 without. Lowered by a browser "payment successful" screen or activity in the last 2 hours. Only leads at 60%+ get drafts.

## Sending

Channels (Settings): WhatsApp Cloud API (needs an approved template with one `{{1}}` body variable), SMS via Termii, email via Resend, or test mode that only logs. Right before each send, RecoverKit re-checks: has the person bought, opted out, or been messaged in the last 7 days? If so it skips them. Every message carries a signed unsubscribe link.

Run `npm run cli -- send <projectId>` from cron to send approved messages automatically, or use the Send button.

## Recovered revenue and pricing

A verified purchase within 7 days of a sent message counts as recovered (`RK_ATTRIBUTION_DAYS`). The overview shows recovered revenue and the fee (`RK_FEE_PERCENT`, default 10%).

## Configuration

| Variable | Default | |
|---|---|---|
| `RK_MASTER_KEY` | — (required) | 32+ random bytes, base64. Derives the identity pepper, encryption key and token-signing key. |
| `RK_PUBLIC_URL` | `http://localhost:8787` | Must be `https://` in production. |
| `RK_TRUST_PROXY` | off | Set `1` behind a TLS proxy so client IPs and https are detected. |
| `RK_MAIL_FROM` | none | Sender for invites and password resets, e.g. `RecoverKit <no-reply@yourdomain.com>`. Without it, links are shown on the Admin page for you to send. |
| `RK_BREVO_API_KEY` | none | Send those emails through Brevo's HTTPS API. Use this on shared hosting that blocks SMTP ports (an `ECONNREFUSED …:587` error). |
| `RK_SMTP_HOST` | none | Send those emails through SMTP, e.g. Brevo `smtp-relay.brevo.com`, with `RK_SMTP_PORT` (587; 465 for TLS), `RK_SMTP_USER` and `RK_SMTP_PASS`. TLS is required. |
| `RK_RESEND_API_KEY` | none | Send them through Resend instead. With neither, `sendmail` is used. |
| `RK_SENDMAIL` | `/usr/sbin/sendmail` | Path to sendmail (cPanel hosting has it). |
| `RK_DB_PATH` | `./recoverkit.db` | SQLite file. |
| `RK_AI_PROVIDER` | — | Server-default AI: `anthropic`, `openai`, `gemini`, `openai-compatible` or `none`. |
| `RK_AI_MODEL` / `RK_AI_API_KEY` / `RK_AI_BASE_URL` | — | Model, key and (for openai-compatible) base URL for the default. |
| `ANTHROPIC_API_KEY` | — | Shortcut: with no `RK_AI_PROVIDER`, uses Claude (`claude-opus-5-5`) as the default. |
| `RK_ALLOW_PRIVATE_AI_URLS` | off | Set `1` only to let a business point at a model on your own network (e.g. Ollama on localhost). |
| `RK_RETENTION_DAYS` | 395 | Raw events older than this are deleted. |

## Tests

```bash
npm test         # 83 unit + end-to-end tests, including the connector against a real PostgreSQL 17 (embedded, no install needed)
npm run test:mysql  # the connector against a real MySQL/MariaDB (set RK_TEST_MYSQL_DSN; see the test file)
npm run test:mongo  # the MongoDB connector against a real mongod (downloaded automatically on first run)
npm run check:ai    # ONE real call to your AI model (draft + database mapping). Needs ANTHROPIC_API_KEY or RK_AI_*; costs a few kobo
npm run check    # syntax check of every JS file, the browser bundle and the PHP SDK
npm audit        # 0 known vulnerabilities at the time of writing
```

See [SECURITY.md](../SECURITY.md) for the threat model and the review.

## Mascot: Kobo

**Kobo is a homing pigeon.** Homing pigeons always find their way back and carry messages, and RecoverKit brings customers back with follow-up messages. Every kobo counts.

- `src/dashboard/mascot.js` is the single source. Kobo appears in the sidebar (blinks, with an occasional head-bob), on the sign-in page (the full animation), in empty states, and as the favicon.
- The animation follows Disney's 12 principles of animation, using the [animation-principles skills](https://github.com/dylantarre/animation-principles) (MIT) installed in `.claude/skills/anim-*`. In each 6-second loop Kobo:
  1. crouches (anticipation)
  2. flies a boomerang arc out and back, wings flapping and tail trailing (arcs, follow-through)
  3. lands with a squash and stretch
  4. does a pigeon head-bob
  5. pops a ₦ coin out of his satchel: a recovered sale
- It uses only CSS keyframes, with no JavaScript, so it works under the strict CSP. It stops for anyone with Reduce Motion turned on.
- `npm run brand` writes standalone files to `../assets/brand/`: `kobo.svg` (static), `kobo-mark.svg`, `kobo-animated.svg`, `kobo-app-icon.svg` and a brand sheet `index.html`.

## Design

The dashboard follows Apple's Human Interface Guidelines, adapted for the web. The [Raintree Apple HIG skills](https://github.com/raintree-technology/apple-hig-skills) (MIT) are installed in `.claude/skills/`, and the design decisions are in `.claude/apple-design-context.md`. In short:
- a sidebar on desktop and a tab bar on phones
- system colors and fonts
- automatic light and dark mode
- inset grouped lists and switches
- no JavaScript
