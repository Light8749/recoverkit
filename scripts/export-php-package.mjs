// Builds dist/recoverkit-php: the Composer package (PHP SDK + read-only connector), published from
// its own repository (github.com/Light8749/recoverkit-php) because Packagist reads a root composer.json.
//   node scripts/export-php-package.mjs
import { copyFileSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHP_FILES } from '../src/downloads.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/recoverkit-php');
// Keep .git so the package repository's history survives a rebuild.
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f !== '.git') rmSync(join(out, f), { recursive: true, force: true });

for (const f of PHP_FILES) copyFileSync(join(root, 'sdk/php', f), join(out, f));
copyFileSync(join(root, 'sdk/LICENSE'), join(out, 'LICENSE'));
mkdirSync(join(out, 'bin'));
writeFileSync(join(out, 'bin/recoverkit-connector'), "#!/usr/bin/env php\n<?php\n// vendor/bin/recoverkit-connector setup|sync|status|detect\ndefine('RECOVERKIT_CONNECTOR_CLI', true);\nrequire __DIR__ . '/../recoverkit-connector.php';\n", { mode: 0o755 });

writeFileSync(join(out, 'composer.json'), JSON.stringify({
  name: 'light8749/recoverkit',
  description: 'RecoverKit PHP SDK and read-only connector: record real sales and bring in past customers. Emails and phones are hashed before they leave your server.',
  type: 'library',
  license: 'MIT',
  keywords: ['recoverkit', 'sales-recovery', 'abandoned-checkout', 'win-back', 'laravel', 'woocommerce'],
  homepage: 'https://github.com/Light8749/recoverkit',
  support: { issues: 'https://github.com/Light8749/recoverkit/issues', source: 'https://github.com/Light8749/recoverkit/tree/main/sdk/php' },
  require: { php: '>=7.4', 'ext-json': '*', 'ext-curl': '*', 'ext-pdo': '*' },
  autoload: { classmap: ['RecoverKit.php', 'recoverkit-detect.php'] },
  bin: ['bin/recoverkit-connector'],
}, null, 2) + '\n');

writeFileSync(join(out, 'README.md'), `# RecoverKit for PHP

The RecoverKit server SDK and read-only connector, for Laravel, WordPress/WooCommerce, CodeIgniter, Symfony or plain PHP.
This repository is generated from [Light8749/recoverkit](https://github.com/Light8749/recoverkit) (\`sdk/php\`); please open issues there.

\`\`\`bash
composer require light8749/recoverkit
\`\`\`

Add the three values from the business's RecoverKit dashboard (**Developers** page) to your \`.env\`:

\`\`\`
RK_PUBLIC_KEY=rk_pub_...
RK_SECRET_KEY=rk_sec_...      # server only
RK_ENDPOINT=https://the-business-recoverkit-server
\`\`\`

## Record real sales

\`\`\`php
$rk = new RecoverKit(getenv('RK_PUBLIC_KEY'), getenv('RK_SECRET_KEY'), getenv('RK_ENDPOINT'));

$rk->identify(['email' => $user->email, 'phone' => $user->phone, 'firstName' => $user->first_name]); // after sign-up or login
$rk->trackPurchase(['email' => $user->email, 'amount' => 150000, 'ref' => $order->reference]);     // a real sale, in kobo
$rk->walletFunded(['email' => $user->email, 'amount' => 500000]);                                  // a deposit is not a sale
\`\`\`

Calls time out after 3 seconds and never throw, so RecoverKit can't break a checkout.

## Bring in past customers (read-only)

\`\`\`bash
vendor/bin/recoverkit-connector setup --app=.    # reads table names only, suggests a mapping, dry run, asks before saving
vendor/bin/recoverkit-connector sync --app=.     # first run sends history, then only what's new
\`\`\`

Cron, every 15 minutes: \`*/15 * * * * cd /path/to/app && vendor/bin/recoverkit-connector sync --app=. >> recoverkit-sync.out 2>&1\`

It finds your database login in your app's config (Laravel, WordPress and WooCommerce, CodeIgniter, Django, Rails, Prisma, Spring Boot, ASP.NET, or any \`.env\` with \`DATABASE_URL\`), uses a read-only session, logs every query to \`recoverkit-connector.log\`, and sends only hashes, dates and amounts.

Full docs: \`/docs\` on the business's RecoverKit server. MIT License.
`);
console.log('wrote dist/recoverkit-php');
