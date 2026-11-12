// The developer guide: everything a business's developer needs to connect their app, with the
// business's own keys filled in. Used by the dashboard Developers page, the shareable guide link
// and the public /docs page (with placeholders). Developers never need the RecoverKit source.
import { esc, group, row, pill } from './ui.js';

const PUB_PLACEHOLDER = 'rk_pub_YOUR_PUBLIC_KEY';
const SEC_PLACEHOLDER = 'rk_sec_YOUR_SECRET_KEY';

/** A code block in a list row. text is plain text and is escaped here. */
export const code = (text, label = '') => `<div class="row code-row">${label ? `<span class="code-label">${esc(label)}</span>` : ''}<pre>${esc(text)}</pre></div>`;
const option = (title, sub, body, open = false) => `<details class="option"${open ? ' open' : ''}><summary><span>${title}${sub ? `<small>${sub}</small>` : ''}</span></summary><div class="option-body">${body}</div></details>`;
const note = (html) => `<p class="group-foot">${html}</p>`;

/**
 * base: this server's public URL. publicKey: the project's public key (or null for placeholders).
 * secretKey: only when it was just created and is being shown once. mode: 'sales' | 'deposits'.
 */
export function developerGuide({ base, publicKey, secretKey, mode = 'sales', links = true }) {
  const pk = publicKey || PUB_PLACEHOLDER;
  const sk = secretKey || SEC_PLACEHOLDER;
  const deposits = mode === 'deposits';
  const envBlock = `RK_PUBLIC_KEY=${pk}\nRK_SECRET_KEY=${sk}\nRK_ENDPOINT=${base}`;
  const exportBlock = envBlock.split('\n').map((l) => `export ${l}`).join('\n');
  const dl = (f) => `${base}/sdk/php/${f}`;
  const saleCall = deposits
    ? 'when a customer buys airtime, data or anything else with their balance'
    : 'when a payment for an order really succeeds';

  const keys = group('1. Your connection details', [
    row('Server address', `<code>${esc(base)}</code>`, { sub: 'RK_ENDPOINT' }),
    row('Public key', `<code>${esc(pk)}</code>`, { sub: 'RK_PUBLIC_KEY. Safe in websites and apps' }),
    row('Secret key', secretKey ? `<code>${esc(sk)}</code>` : pill(links ? 'Create one above' : 'Ask the business owner', 'orange'), { sub: 'RK_SECRET_KEY. Server only, never in a website or app' }),
    code(envBlock, 'Add to your app\'s .env'),
  ], secretKey
    ? '<b>Copy the secret key now: it won\'t be shown again.</b> Send it to your developer privately (not in a group chat). You can revoke it in Settings at any time.'
    : links ? 'Create a secret key with the button above, then send it to your developer privately (not in a group chat). Each one can be revoked in Settings.'
      : 'The business owner creates a secret key on the Developers page of their RecoverKit dashboard and sends it to you privately.');

  const website = group('2. Your website', [
    code(`<script src="${base}/sdk/recoverkit.js"></script>\n<script>RecoverKit.init({ key: '${pk}' });</script>`, 'Before </body> on every page'),
    code(`// After sign-up or login, when you know who the user is:\nRecoverKit.identify({ email: user.email, phone: user.phone });\n\n// After logout:\nRecoverKit.reset();`, 'JavaScript'),
  ], 'Works with any site: plain HTML, WordPress, Laravel Blade, React, Vue, Next.js. Emails and phone numbers are hashed in the browser. The script never reads form fields or card details, and it respects "Do Not Track". The browser can\'t record a sale: that comes from your server or payment gateway, below.');

  const php = `${'<'}?php\nrequire_once __DIR__ . '/recoverkit-php/RecoverKit.php';\n$rk = new RecoverKit(getenv('RK_PUBLIC_KEY'), getenv('RK_SECRET_KEY'), getenv('RK_ENDPOINT'));\n\n// After sign-up or login:\n$rk->identify(['email' => $user->email, 'phone' => $user->phone, 'firstName' => $user->first_name]);\n\n// ${saleCall} (amount in kobo):\n$rk->trackPurchase(['email' => $user->email, 'amount' => 150000, 'ref' => $order->reference]);${deposits ? "\n\n// When a wallet is funded (a deposit is not a sale):\n$rk->walletFunded(['email' => $user->email, 'amount' => 500000]);" : ''}`;
  const node = `import { RecoverKit } from 'recoverkit';\nconst rk = new RecoverKit({\n  publicKey: process.env.RK_PUBLIC_KEY,\n  secretKey: process.env.RK_SECRET_KEY,\n  endpoint: process.env.RK_ENDPOINT,\n});\n\n// After sign-up or login:\nawait rk.identify({ email: user.email, phone: user.phone, firstName: user.firstName });\n\n// ${saleCall} (amount in kobo):\nawait rk.trackPurchase({ email: user.email, amount: 150000, ref: order.reference });${deposits ? '\n\n// When a wallet is funded (a deposit is not a sale):\nawait rk.walletFunded({ email: user.email, amount: 500000 });' : ''}`;
  const python = `import hashlib, os, requests\n\nPK, SK, BASE = os.environ["RK_PUBLIC_KEY"], os.environ["RK_SECRET_KEY"], os.environ["RK_ENDPOINT"]\n\ndef rk_id(kind, value):  # kind "e" = email (trimmed, lower case), "p" = phone (digits with country code)\n    return hashlib.sha256(f"rk1|{PK}|{kind}|{value}".encode()).hexdigest()\n\ndef rk_send(email, events=None, first_name=None):\n    body = {"ids": [rk_id("e", email.strip().lower())], "contact": {"email": email, "firstName": first_name}}\n    if events: body["events"] = events\n    try:\n        requests.post(f"{BASE}/v1/server/events", json=body, timeout=3,\n                      headers={"Authorization": f"Bearer {SK}"})\n    except requests.RequestException:\n        pass  # never let RecoverKit break your checkout\n\nrk_send(user.email, first_name=user.first_name)                      # after sign-up or login\nrk_send(user.email, [{"type": "purchase", "amount": 150000, "ref": order.ref}])  # a real sale, in kobo`;
  const curl = `curl -X POST ${base}/v1/server/events \\\n  -H "Authorization: Bearer $RK_SECRET_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"ids": ["<sha256 of rk1|${pk}|e|customer@example.com>"],\n       "events": [{"type": "purchase", "amount": 150000, "currency": "NGN", "ref": "ORDER-1001"}]}'`;
  const server = `<section class="group"><h2 class="group-head">3. Your server: record real sales</h2>
    ${option('PHP', 'Laravel, WordPress, CodeIgniter, plain PHP', `${group('', [
      code(`mkdir -p recoverkit-php && cd recoverkit-php\ncurl -fsSL -O ${dl('RecoverKit.php')}`, 'Download (or use the zip below)'),
      code(php, 'PHP'),
    ], 'Laravel: put the three values in <code>.env</code>, read them in <code>config/services.php</code>, then use <code>config(...)</code> instead of <code>getenv</code>.')}`, true)}
    ${option('Node.js', 'Express, NestJS, Next.js API routes', group('', [code('npm install recoverkit', 'Install'), code(node, 'JavaScript')]))}
    ${option('Python, Go, Ruby, Java, C# or anything else', 'Call the HTTP API directly', group('', [code(python, 'Python example'), code(curl, 'curl')],
      `Hash each email as <code>sha256("rk1|PUBLIC_KEY|e|" + email.trim().toLowerCase())</code>. Phones use <code>p</code> and digits only with the country code (<code>2348031234567</code>). Full rules: <a href="${base}/docs#api">API reference</a>.`))}
    <p class="group-foot">Calls time out after 3 seconds and never throw, so RecoverKit can't break a purchase. Pass your order or payment reference as <code>ref</code>: a sale reported twice (by your server and a gateway webhook) is counted once.${deposits ? ' This business takes <b>wallet deposits</b>: only <code>trackPurchase</code> counts as a sale, so people who fund their wallet and never buy become leads.' : ''}</p></section>`;

  const payments = group('4. Payment gateway webhooks', [
    row('Paystack, Flutterwave, Monnify, Stripe or any gateway', '', { href: links && publicKey ? '/dashboard/payments' : undefined, sub: 'The business owner adds the gateway in the dashboard under Payments, then pastes the webhook URL it shows into the gateway\'s settings. No code needed.' }),
  ]);

  const history = `<section class="group"><h2 class="group-head">5. Past customers (read-only connector)</h2>
    <p class="group-foot lead"><b>Quickest:</b> ${links ? 'click <b>Create install command</b> at the top of this page and run it in your app\'s folder.' : 'ask the business owner for an <b>install command</b> (Developers page → Create install command) and run it in your app\'s folder.'} It connects, finds your database and sets everything up by itself. The steps below are the manual way.</p>
    <p class="group-foot lead">The connector runs on your server, next to your database. It reads your tables where they are (nothing is exported), works out who signed up, bought and went quiet, and sends only hashes, dates and amounts. It looks at table and column names only, suggests a mapping, shows you a dry run, and asks before saving.</p>
    ${option('MySQL, MariaDB, PostgreSQL or SQLite', 'Any language or framework, on a server with PHP 7.4+ (most hosting has it)', `${group('', [
      code(`mkdir -p ~/recoverkit-php && cd ~/recoverkit-php\ncurl -fsSL -O ${dl('RecoverKit.php')} -O ${dl('recoverkit-connector.php')} -O ${dl('recoverkit-detect.php')}`, 'Download, outside public_html'),
      `<div class="row"><a class="btn tinted small" href="${base}/sdk/recoverkit-php.zip" download>Download the zip instead</a><small class="row-sub">For cPanel: upload it with File Manager and extract it in your home folder.</small></div>`,
      code(`${exportBlock}\n\nphp recoverkit-connector.php setup --app=/path/to/your/app\nphp recoverkit-connector.php sync`, 'Set up, then send your history'),
      code(`*/15 * * * * cd $HOME/recoverkit-php && php recoverkit-connector.php sync --app=/path/to/your/app >> sync.out 2>&1`, 'Cron: keep it up to date every 15 minutes'),
    ], '<code>--app</code> lets it find your database login in your app\'s config: Laravel, WordPress and WooCommerce (classic and HPOS), CodeIgniter, Django, Rails, Prisma, Spring Boot, ASP.NET, or any <code>.env</code> with <code>DATABASE_URL</code>. It also reads the three RK_ values from that <code>.env</code>, so the cron line needs no secrets. Or set <code>RK_DB_DSN</code>, <code>RK_DB_USER</code> and <code>RK_DB_PASS</code> yourself: a read-only database login is best.')}`, true)}
    ${option('MongoDB', 'Node.js apps with Mongoose, Prisma or the MongoDB driver', group('', [
      code(`cd /path/to/your/app\nnpx recoverkit-connector@1 setup --app=.\nnpx recoverkit-connector@1 sync --app=.`, 'Run in your app folder (Node 20+)'),
      code(`*/15 * * * * cd /path/to/your/app && npx recoverkit-connector@1 sync --app=. >> recoverkit-sync.out 2>&1`, 'Cron'),
    ], 'It finds your connection string in your code and <code>.env</code>, and checks your MongoDB login can only read. Orders stored inside customer documents are supported.'))}
    ${option('No PHP on the server', 'Use Docker', group('', [
      code(`docker build -t recoverkit-connector https://github.com/Light8749/recoverkit.git#main:sdk/php\n\ndocker run --rm -it --network host -v /path/to/your/app:/app:ro -v recoverkit-state:/state \\\n  -e RK_PUBLIC_KEY -e RK_SECRET_KEY -e RK_ENDPOINT recoverkit-connector setup --app=/app --dir=/state`, 'Docker'),
    ], 'Your app folder is mounted read-only. Run the same command with <code>sync</code> from cron.'))}
    <p class="group-foot">Every query the connector runs is written to <code>recoverkit-connector.log</code> on your server. If your tables change, it stops and asks you to run setup again. To cut it off, revoke its secret key in Settings.</p></section>`;

  const check = group('6. Check it works', [
    row('Overview', '', { sub: 'The yellow warning disappears once a real sale arrives from your server or a gateway' }),
    row('Leads', '', { sub: 'People who signed up and didn\'t buy, or bought once and went quiet, appear here' }),
    row('Settings', '', { sub: 'Shows each connector sync: when, how many people and records' }),
  ]);

  return `${keys}${website}${server}${payments}${history}${check}`;
}

/** The public API reference (part of /docs). */
export function apiReference(base) {
  const ep = (method, path, auth, desc, body, resp) => `<article class="card api"><div class="meta">${pill(method, 'accent')} <code>${esc(path)}</code> ${pill(auth)}</div><p>${desc}</p>${body ? `<pre>${esc(body)}</pre>` : ''}${resp ? `<p class="small">Response</p><pre>${esc(resp)}</pre>` : ''}</article>`;
  return `<h2 class="section-title" id="api">API reference</h2>
  ${group('Basics', [
    row('Base URL', `<code>${esc(base)}</code>`),
    row('Format', 'JSON request and response bodies'),
    row('Server calls', '<code>Authorization: Bearer rk_sec_…</code>', { sub: 'Secret key. Only from your server' }),
    row('Browser calls', '<code>X-RK-Key: rk_pub_…</code>', { sub: 'Public key. Write-only, can never record a sale' }),
    row('Amounts', 'Integers in minor units', { sub: 'Kobo, cents: ₦1,500 is 150000' }),
    row('Errors', '<code>{ "error": "message" }</code>', { sub: '400 bad input, 401 bad key, 403 origin not allowed, 429 too many requests' }),
  ])}
  ${group('Identity hashes', [
    code('id = sha256_hex("rk1|" + PUBLIC_KEY + "|" + kind + "|" + value)', 'Formula'),
    row('Email (kind e)', '', { sub: 'Trim spaces and lower-case it: " Ada@Shop.NG " becomes ada@shop.ng' }),
    row('Phone (kind p)', '', { sub: 'Digits only with the country code, no +: 0803 123 4567 becomes 2348031234567' }),
  ], 'RecoverKit never needs raw emails or phones to match people: send up to 4 hashes per person as <code>ids</code>. Send raw contact details in <code>contact</code> only if you want RecoverKit to message them; they are stored encrypted.')}
  ${ep('POST', '/v1/server/events', 'secret key', 'Identify a person and record what they did. Send <code>contact</code> to let RecoverKit message them. Up to 50 events per call.',
    `{
  "ids": ["<email hash>", "<phone hash>"],
  "contact": { "email": "ada@shop.ng", "phone": "2348031234567", "firstName": "Ada" },
  "anonId": "a_3f2c...",            // optional: the browser SDK's anonymous id
  "events": [
    { "type": "purchase", "amount": 150000, "currency": "NGN", "ref": "ORDER-1001" }
  ]
}

event types: purchase, wallet_funded, registered, checkout_started, custom
fields: type, amount (minor units; required for purchase and wallet_funded),
        currency (3 letters), ref (your order/payment reference, no spaces),
        name ([A-Za-z0-9_.:/-], up to 64), ts (milliseconds, up to 7 days old)`,
    '{ "ok": true, "person": "identified", "purchases": [ ... ] }')}
  ${ep('POST', '/v1/server/erase', 'secret key', 'Delete everything RecoverKit holds about one person (right to erasure).', '{ "ids": ["<email hash>"] }', '{ "ok": true, "erased": true }')}
  ${ep('POST', '/v1/collect', 'public key', 'Used by the browser and React Native SDKs. Records page views, checkout starts and other signals. It can never record a purchase. Most developers use the script instead of calling this directly.',
    `{
  "key": "rk_pub_...",
  "anonId": "a_3f2c...",
  "ids": ["<email hash>"],          // optional, after identify
  "events": [{ "type": "page_view", "path": "/pricing" }]
}

event types: page_view, click, form_submit, checkout_started, payment_signal, registered, custom`, '{ "ok": true, "accepted": 1 }')}
  ${ep('POST', '/v1/webhooks/{gatewayId}', 'gateway signature', 'Where your payment gateway sends its webhooks. The URL, with its gateway id, is shown in the dashboard under Payments. Signatures are checked with the secret you saved there.', '', '')}
  ${ep('POST', '/v1/connector/sync', 'secret key', 'Used by the read-only connectors to send history. You don\'t need to call it yourself.', '', '')}
  ${group('Limits', [
    row('Server calls', '12,000 a minute per business'),
    row('Browser calls', '300 a minute per visitor'),
    row('Events per call', '50'),
  ])}`;
}
