# RecoverKit

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
  RecoverKit.init({ key: 'rk_pub_...', endpoint: 'https://YOUR-RECOVERKIT-HOST' });
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
import { RecoverKit } from './sdk/node/index.js';
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
| `RK_DB_PATH` | `./recoverkit.db` | SQLite file. |
| `RK_AI_PROVIDER` | — | Server-default AI: `anthropic`, `openai`, `gemini`, `openai-compatible` or `none`. |
| `RK_AI_MODEL` / `RK_AI_API_KEY` / `RK_AI_BASE_URL` | — | Model, key and (for openai-compatible) base URL for the default. |
| `ANTHROPIC_API_KEY` | — | Shortcut: with no `RK_AI_PROVIDER`, uses Claude (`claude-opus-5-5`) as the default. |
| `RK_ALLOW_PRIVATE_AI_URLS` | off | Set `1` only to let a business point at a model on your own network (e.g. Ollama on localhost). |
| `RK_RETENTION_DAYS` | 395 | Raw events older than this are deleted. |

## Tests

```bash
npm test         # 50 unit + end-to-end tests, real HTTP server and SQLite
npm run check    # syntax check of every JS file, the browser bundle and the PHP SDK
npm audit        # 0 known vulnerabilities at the time of writing
```

See [SECURITY.md](SECURITY.md) for the threat model and the review.

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
- `npm run brand` writes standalone files to `assets/brand/`: `kobo.svg` (static), `kobo-mark.svg`, `kobo-animated.svg`, `kobo-app-icon.svg` and a brand sheet `index.html`.

## Design

The dashboard follows Apple's Human Interface Guidelines, adapted for the web. The [Raintree Apple HIG skills](https://github.com/raintree-technology/apple-hig-skills) (MIT) are installed in `.claude/skills/`, and the design decisions are in `.claude/apple-design-context.md`. In short:
- a sidebar on desktop and a tab bar on phones
- system colors and fonts
- automatic light and dark mode
- inset grouped lists and switches
- no JavaScript
