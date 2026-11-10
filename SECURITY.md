# Security and privacy

## What is protected, and how

| Threat | Protection | Tested in |
|---|---|---|
| Fake purchases from the browser | The public key can never create a purchase. Browser "payment success" only *lowers* confidence. | `e2e: layer 1 cannot create purchases` |
| Forged or replayed webhooks | Every gateway, preset or custom, must have a signature check (HMAC, shared-secret header, or Stripe-style timestamped with a 5-minute window). Constant-time compare. Each gateway has its own random, unguessable URL and secret, so one gateway's signature never works for another. Each event is processed once. Unknown, disabled and badly signed requests all get the same 401. | `gateways-ai`, `e2e: layer 2`, `custom gateway` |
| Malicious gateway configs | Field paths are validated (`a.b.c` only) and read through own properties only, so `__proto__`, `constructor` and inherited keys can't be read. Lookups of preset and provider names are prototype-safe. | `gateways-ai: specs refuse...` |
| SSRF through a custom AI base URL | https is required. The host is resolved, and loopback, private, link-local (including cloud metadata 169.254.169.254) and multicast addresses are refused unless `RK_ALLOW_PRIVATE_AI_URLS=1`. Redirects are not followed, there's a 60-second timeout and a 1 MB response cap. | `gateways-ai: SSRF`, `e2e: choose a different AI provider` |
| Leaking AI or gateway keys | Stored with AES-256-GCM, never rendered back into pages (password fields are write-only), never logged. | `e2e: custom gateway`, `e2e: AI provider` |
| Stolen or guessed server keys | 256-bit secrets, stored as SHA-256 only, shown once, revocable. Failed attempts are rate limited. | `e2e: revoked secret keys stop working` |
| Merging or hijacking people with the public key | Browser identify can only look up or create a new person. It can never merge two people or attach a new email to an existing one. | `e2e: attack: public key cannot merge...` |
| Collecting sensitive data | Allowlisted event types and names only. Form values, card data, query strings and ids in URLs are dropped. | `unit: browser events`, `unit: paths` |
| Reversing hashed identities | Client hash is project-scoped. The server adds a secret HMAC pepper before storage. | `unit: identity hashes` |
| Database leak | Contacts, gateway secrets and channel credentials use AES-256-GCM. Sessions are stored as hashes. Passwords use scrypt. | `e2e: layer 3`, `e2e: dashboard login` |
| SQL injection | Every query is parameterised. | review |
| XSS | Every dashboard value is HTML-escaped. Strict CSP with no scripts allowed (`default-src 'none'`). | `e2e: dashboard: CSRF, XSS` |
| CSRF / clickjacking | Per-session CSRF token. Origin and `Sec-Fetch-Site` checks (login included; `Origin: null` is only trusted when the browser says same-origin). `SameSite=Strict` cookies, `frame-ancestors 'none'`, `X-Frame-Options: DENY`. | `e2e: dashboard: CSRF`, `cross-origin login`, `real-browser origin headers` |
| Brute-force login, user enumeration | Rate limited per IP and per email. scrypt always runs. Unknown and wrong-password users get the same message. | `e2e: brute force` |
| Cross-tenant access | Every dashboard query is scoped to the logged-in project. | `e2e: cross-project access` |
| Prompt injection into the AI | Journey data is labelled as data only. Event names are restricted to `[A-Za-z0-9_.:/-]`. No PII reaches the model. Output containing links, phone numbers or unknown placeholders is discarded. | `e2e: AI drafting`, `unit: draft checker` |
| Chasing someone who already paid | Re-checked right before each send, plus a 7-day per-person cap and an atomic claim so nothing sends twice. | `e2e: send` |
| Spam / unsubscribe | Signed unsubscribe token (GET shows a confirmation page, POST unsubscribes, so link scanners can't). | `e2e: send` |
| Request floods | Body size limits on every endpoint, per-IP and per-project rate limits, bounded limiter memory, header and request timeouts. | `e2e: collect rejects...` |
| Dependencies | One runtime dependency (`@anthropic-ai/sdk`, pinned). `npm audit`: 0 vulnerabilities. | `npm audit` |

## Known limits (accepted, not bugs)

1. **The public key is public.** Anyone with it who also knows a customer's email can add page-view or "payment success" events to that customer. The worst outcome is that the customer is *not* messaged. Restrict origins in Settings to reduce this.
2. **Some gateways (Paystack, Monnify, Korapay, Squad) sign webhooks with your main secret key**, so RecoverKit has to store it (encrypted). Use a restricted key where the gateway offers one, and rotate it if the RecoverKit server is ever compromised. Gateways with a separate webhook secret (Flutterwave, Stripe, most custom setups) don't have this problem.
3. **The master key is the crown jewel.** Losing it makes stored contacts unreadable. Leaking it exposes them. Keep `.env` at permission 600, back it up offline, and never commit it.
4. **Rate limits are in-memory** and per process. Running several instances needs a shared store (for example Redis).
5. **TLS is your job.** Run behind HTTPS (`RK_PUBLIC_URL=https://...`, `RK_TRUST_PROXY=1` behind a proxy). Cookies are only marked `Secure` on https.
6. **WhatsApp** business-started messages need a Meta-approved template. Inbound "STOP" replies are not handled yet; the unsubscribe link is.
7. **NDPA:** you are a data processor for each business. Sign a data processing agreement, keep the erasure endpoint wired up, and only message people the business has a lawful basis to contact.
8. **AI providers see the journey summary** (event types, timings, amounts and your voice notes), never contact details. Choose a provider whose data terms you accept. A self-hosted model through `RK_ALLOW_PRIVATE_AI_URLS` keeps everything on your servers.
9. **DNS rebinding:** the SSRF check resolves the host before the request, so a hostile DNS server could still switch addresses between the check and the connection. Keep `RK_ALLOW_PRIVATE_AI_URLS` off, and add an egress firewall in production for full protection.
