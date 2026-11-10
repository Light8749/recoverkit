// The PHP connector against a real MySQL/MariaDB server.
// Skipped unless RK_TEST_MYSQL_DSN points at a server where RK_TEST_MYSQL_USER can create databases and users:
//   RK_TEST_MYSQL_DSN="mysql:host=127.0.0.1;port=3307" RK_TEST_MYSQL_USER=root RK_TEST_MYSQL_PASS= npm run test:mysql
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createApp } from '../src/server.js';
import { identityHashes } from '../sdk/core/identity.js';

const DSN = process.env.RK_TEST_MYSQL_DSN;
const skip = DSN ? false : 'set RK_TEST_MYSQL_DSN to run the MySQL connector tests';
const DAY = 864e5;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONNECTOR = join(root, 'sdk/php/recoverkit-connector.php');
const DB = `rk_test_${randomBytes(4).toString('hex')}`;
const RO_USER = `rk_ro_${randomBytes(3).toString('hex')}`;
const RO_PASS = randomBytes(12).toString('hex');
let app, base, dir, project;
const aiCalls = [];
const lagos = (ms) => new Date(ms + 3600e3).toISOString().replace('T', ' ').slice(0, 19);

const MAPPING = {
  people: { table: 'users', id: 'id', email: 'email', phone: 'phone', firstName: 'fullname', createdAt: 'created_at' },
  conversions: [{ name: 'vtu_purchase', table: 'transactions', key: 'id', userColumn: 'user_id', timeColumn: 'created_at', amountColumn: 'amount', amountUnit: 'major', refColumn: 'reference',
    filters: [{ column: 'status', values: ['successful'] }, { column: 'service', values: ['data', 'airtime'] }] }],
  signals: [{ name: 'wallet_funding', kind: 'deposit', table: 'wallet_fundings', key: 'id', userColumn: 'user_id', timeColumn: 'created_at', amountColumn: 'amount', amountUnit: 'major', filters: [{ column: 'status', values: ['success'] }] }],
  notes: '',
};
const fakeAnthropic = { beta: { messages: { create: async (req) => { aiCalls.push(req); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(MAPPING) }] }; } } } };

/** Run SQL as the admin user through PHP's own MySQL driver. */
function adminSql(sql, db = '') {
  return new Promise((resolve, reject) => {
    const code = '$p = new PDO(getenv("RK_DSN"), getenv("RK_U"), getenv("RK_P"), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]); $p->exec(stream_get_contents(STDIN));';
    const child = execFile('php', ['-r', code], { env: { PATH: process.env.PATH, RK_DSN: DSN + (db ? `;dbname=${db}` : ''), RK_U: process.env.RK_TEST_MYSQL_USER || 'root', RK_P: process.env.RK_TEST_MYSQL_PASS || '' } },
      (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
    child.stdin.end(sql);
  });
}

function php(args, env = {}) {
  return new Promise((resolve) => {
    execFile('php', [CONNECTOR, ...args], {
      env: { PATH: process.env.PATH, RK_PUBLIC_KEY: project.publicKey, RK_SECRET_KEY: project.secretKey, RK_ENDPOINT: base, RK_DB_DSN: `${DSN};dbname=${DB}`,
        RK_DB_USER: RO_USER, RK_DB_PASS: RO_PASS, RK_TIMEZONE: 'Africa/Lagos', ...env },
      timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr }));
  });
}
const personOf = (email) => app.people.findByHashes(project.id, identityHashes(project.publicKey, { email }));

before(async () => {
  if (skip) return;
  const now = Date.now();
  await adminSql(`CREATE DATABASE ${DB} CHARACTER SET utf8mb4;
    CREATE USER '${RO_USER}'@'%' IDENTIFIED BY '${RO_PASS}';
    GRANT SELECT ON ${DB}.* TO '${RO_USER}'@'%';`);
  await adminSql(`
    CREATE TABLE users (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, fullname VARCHAR(100), email VARCHAR(190) UNIQUE, phone VARCHAR(20),
      password VARCHAR(100), created_at DATETIME NOT NULL) ENGINE=InnoDB;
    CREATE TABLE wallet_fundings (id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED, amount DECIMAL(12,2), status VARCHAR(20), created_at DATETIME) ENGINE=InnoDB;
    CREATE TABLE transactions (id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED, service ENUM('data','airtime','wallet_credit','electricity'),
      amount DECIMAL(12,2), status ENUM('pending','successful','failed'), reference VARCHAR(64), created_at TIMESTAMP NULL) ENGINE=InnoDB;
    INSERT INTO users VALUES
      (1,'Ada Obi','ada@example.com','08031110001','$2y$10$secret','${lagos(now - 60 * DAY)}'),
      (2,'Bayo Ade','bayo@example.com','08031110002','$2y$10$secret','${lagos(now - 30 * DAY)}'),
      (3,'Chidi Eze','chidi@example.com',NULL,'$2y$10$secret','${lagos(now - 5 * DAY)}'),
      (4,'Dupe Bello','dupe@example.com',NULL,'$2y$10$secret','${lagos(now - 500 * DAY)}'),
      (5,'No Contact',NULL,NULL,'$2y$10$secret','${lagos(now - 10 * DAY)}'),
      (6,'Funmi Ojo','funmi@example.com',NULL,'$2y$10$secret','${lagos(now - 3 * DAY)}');
    INSERT INTO wallet_fundings VALUES (1,2,2000.00,'success','${lagos(now - 20 * DAY)}');
    INSERT INTO transactions VALUES
      (1,1,'data',500.00,'successful','VTU-AAA-1','${lagos(now - 10 * DAY)}'),
      (2,2,'wallet_credit',2000.00,'successful','WAL-BBB-1','${lagos(now - 20 * DAY)}'),
      (3,4,'airtime',1000.50,'successful','VTU-DDD-1','${lagos(now - 400 * DAY)}'),
      (4,6,'data',300.00,'failed','VTU-FFF-1','${lagos(now - 2 * DAY)}');`, DB);

  dir = mkdtempSync(join(tmpdir(), 'rk-mysql-'));
  const config = {
    masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 'rk.db'), publicUrl: 'http://127.0.0.1', trustProxy: false,
    ai: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-test' }, allowPrivateAiUrls: false,
    attributionDays: 7, feePercent: 10, minDaysBetweenMessages: 7, retentionDays: 3650,
  };
  app = await createApp({ config, anthropicFactory: () => fakeAnthropic, logger: { log() {}, warn() {}, error() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  config.publicUrl = base;
  project = app.projects.create({ name: 'Ada VTU (MySQL)', gatewayMode: 'deposits' });
});

after(async () => {
  if (skip) return;
  await app.close();
  await adminSql(`DROP DATABASE IF EXISTS ${DB}; DROP DATABASE IF EXISTS ${DB}_b; DROP USER IF EXISTS '${RO_USER}'@'%';`).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

test('mysql: a login that can write gets a clear warning and a GRANT SELECT recipe', { skip }, async () => {
  const d = join(dir, 'admin'); mkdirSync(d);
  const r = await php(['setup', '--yes', '--no-ai', `--dir=${d}`], { RK_DB_USER: process.env.RK_TEST_MYSQL_USER || 'root', RK_DB_PASS: process.env.RK_TEST_MYSQL_PASS || '' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /This database login can also WRITE/);
  assert.match(r.out, /GRANT SELECT ON <your_database>\.\* TO 'recoverkit'@'localhost';/);
});

test('mysql: setup with a read-only user, ENUM status values found, correct dry run', { skip }, async () => {
  const r = await php(['setup', '--yes', `--dir=${dir}`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ Read-only session/);
  assert.match(r.out, /6 people · 2 have bought \(2 sales\) · 4 never bought/);
  const sent = JSON.stringify(aiCalls);
  assert.match(sent, /distinct status: (pending \| )?successful/, 'ENUM status values discovered');
  assert.match(sent, /wallet_credit/);
  for (const s of ['ada@example.com', '08031110001', 'Ada Obi', '$2y$10$']) assert.ok(!sent.includes(s), `AI must not see ${s}`);
});

test('mysql: sync, DECIMAL naira to kobo, TIMESTAMP history, deposits are not sales', { skip }, async () => {
  const r = await php(['sync', `--dir=${dir}`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Synced: 5 people/);
  const amounts = (email) => app.db.all('SELECT amount FROM purchases WHERE person_id = ?', personOf(email)).map((p) => p.amount);
  assert.deepEqual(amounts('ada@example.com'), [50000]);
  assert.deepEqual(amounts('dupe@example.com'), [100050]);
  assert.deepEqual(amounts('bayo@example.com'), []);
  assert.deepEqual(amounts('funmi@example.com'), []);
  const leads = Object.fromEntries(app.engine.leads(project.id, { minConfidence: 0 }).map((l) => [l.personId, l.stage]));
  assert.equal(leads[personOf('bayo@example.com')], 'funded_not_bought');
  assert.equal(leads[personOf('dupe@example.com')], 'bought_once');
  const log = readFileSync(join(dir, 'recoverkit-connector.log'), 'utf8').trim().split('\n');
  assert.ok(log.length > 5 && log.every((l) => / rows=\d+ SELECT /.test(l)), 'only SELECTs logged');
  assert.ok(!log.join('').includes('password'));
});

test('mysql: re-sync is idempotent and new rows arrive incrementally', { skip }, async () => {
  let r = await php(['sync', `--dir=${dir}`]);
  assert.match(r.out, / 0 new\./, r.out);
  await adminSql(`INSERT INTO transactions VALUES (5,2,'data',750.00,'successful','VTU-BBB-2','${lagos(Date.now() - 60e3)}');`, DB);
  r = await php(['sync', `--dir=${dir}`]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(app.db.all('SELECT amount FROM purchases WHERE person_id = ?', personOf('bayo@example.com')).map((p) => p.amount), [75000]);
});

test('mysql: the read-only user really cannot write', { skip }, async () => {
  const code = '$p = new PDO(getenv("RK_DB_DSN"), getenv("RK_DB_USER"), getenv("RK_DB_PASS"), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]); try { $p->exec("DELETE FROM users"); echo "WROTE"; } catch (PDOException $e) { echo "DENIED"; }';
  const out = await new Promise((res) => execFile('php', ['-r', code], { env: { PATH: process.env.PATH, RK_DB_DSN: `${DSN};dbname=${DB}`, RK_DB_USER: RO_USER, RK_DB_PASS: RO_PASS } }, (_e, o) => res(o)));
  assert.equal(out, 'DENIED');
});

test('mysql: schema change stops the sync', { skip }, async () => {
  await adminSql(`CREATE DATABASE ${DB}_b; GRANT SELECT ON ${DB}_b.* TO '${RO_USER}'@'%';
    CREATE TABLE ${DB}_b.users LIKE ${DB}.users; INSERT INTO ${DB}_b.users SELECT * FROM ${DB}.users;
    CREATE TABLE ${DB}_b.wallet_fundings LIKE ${DB}.wallet_fundings;
    CREATE TABLE ${DB}_b.transactions LIKE ${DB}.transactions;
    ALTER TABLE ${DB}_b.transactions CHANGE COLUMN reference ref_no VARCHAR(64);`);
  const d = join(dir, 'changed'); mkdirSync(d);
  copyFileSync(join(dir, 'recoverkit-connector.json'), join(d, 'recoverkit-connector.json'));
  const r = await php(['sync', `--dir=${d}`], { RK_DB_DSN: `${DSN};dbname=${DB}_b` });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /tables changed since setup/);
});

test('mysql: a WooCommerce store via --app=wp-config.php, guessed without AI, no double counting', { skip }, async () => {
  const W = `${DB}_wp`;
  const now = Date.now();
  await adminSql(`CREATE DATABASE ${W}; GRANT SELECT ON ${W}.* TO '${RO_USER}'@'%';
    CREATE TABLE ${W}.wp_users (ID BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_login VARCHAR(60), user_pass VARCHAR(255), user_email VARCHAR(100), user_registered DATETIME, display_name VARCHAR(250));
    CREATE TABLE ${W}.wp_usermeta (umeta_id BIGINT PRIMARY KEY, user_id BIGINT, meta_key VARCHAR(255), meta_value LONGTEXT);
    CREATE TABLE ${W}.wp_wc_orders (id BIGINT UNSIGNED PRIMARY KEY, status VARCHAR(20), currency VARCHAR(10), total_amount DECIMAL(26,8), customer_id BIGINT UNSIGNED, billing_email VARCHAR(320), date_created_gmt DATETIME, date_updated_gmt DATETIME);
    CREATE TABLE ${W}.wp_wc_order_stats (order_id BIGINT UNSIGNED PRIMARY KEY, customer_id BIGINT, date_created DATETIME, total_sales DOUBLE, status VARCHAR(20));
    INSERT INTO ${W}.wp_users VALUES (1,'ada','$P$hash','ada@shop.ng','${lagos(now - 90 * DAY)}','Ada'),(2,'bola','$P$hash','bola@shop.ng','${lagos(now - 40 * DAY)}','Bola'),(3,'chi','$P$hash','chi@shop.ng','${lagos(now - 2 * DAY)}','Chi');
    INSERT INTO ${W}.wp_wc_orders VALUES (10,'wc-completed','NGN',15000.00,1,'ada@shop.ng','${lagos(now - 80 * DAY)}',NULL),(11,'wc-processing','NGN',8000.00,1,'ada@shop.ng','${lagos(now - 70 * DAY)}',NULL),
      (12,'wc-failed','NGN',5000.00,2,'bola@shop.ng','${lagos(now - 30 * DAY)}',NULL),(13,'wc-pending','NGN',2500.00,3,'chi@shop.ng','${lagos(now - 1 * DAY)}',NULL);
    INSERT INTO ${W}.wp_wc_order_stats VALUES (10,1,'${lagos(now - 80 * DAY)}',15000,'wc-completed'),(11,1,'${lagos(now - 70 * DAY)}',8000,'wc-processing');`);
  const m = /host=([^;]+);port=(\d+)/.exec(DSN);
  const site = join(dir, 'woo'); mkdirSync(site);
  writeFileSync(join(site, 'wp-config.php'), `<?php\ndefine('DB_NAME', '${W}');\ndefine('DB_USER', '${RO_USER}');\ndefine('DB_PASSWORD', '${RO_PASS}');\ndefine('DB_HOST', '${m[1]}:${m[2]}');\n$table_prefix = 'wp_';\n`);
  const envNoDb = { RK_DB_DSN: undefined, RK_DB_USER: undefined, RK_DB_PASS: undefined };
  const clean = (e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined));
  const run = (args) => new Promise((resolve) => execFile('php', [CONNECTOR, ...args], {
    env: clean({ PATH: process.env.PATH, RK_PUBLIC_KEY: project.publicKey, RK_SECRET_KEY: project.secretKey, RK_ENDPOINT: base, RK_TIMEZONE: 'Africa/Lagos', ...envNoDb }), timeout: 60_000,
  }, (err, o, e) => resolve({ code: err ? err.code ?? 1 : 0, out: o + e })));

  let r = await run(['setup', '--yes', '--no-ai', `--app=${site}`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Found your database in wp-config\.php \(WordPress\)/);
  assert.match(r.out, /People:      table `wp_users`/);
  assert.match(r.out, /A SALE is:   a row in `wp_wc_orders` where status is wc-completed\/wc-processing, amount `total_amount` in naira/);
  assert.doesNotMatch(r.out, /wp_wc_order_stats/, 'the stats copy of orders is not counted');
  assert.match(r.out, /3 people · 1 have bought \(2 sales\) · 2 never bought/);
  r = await run(['sync', `--app=${site}`]);
  assert.equal(r.code, 0, r.out);
  const amounts = app.db.all('SELECT amount FROM purchases WHERE person_id = ? ORDER BY ts', app.people.findByHashes(project.id, identityHashes(project.publicKey, { email: 'ada@shop.ng' }))).map((p) => p.amount);
  assert.deepEqual(amounts, [1500000, 800000]);
  await adminSql(`DROP DATABASE ${W};`);
});

function wooRun(site, args) {
  return new Promise((resolve) => execFile('php', [CONNECTOR, ...args, `--app=${site}`], {
    env: { PATH: process.env.PATH, RK_PUBLIC_KEY: project.publicKey, RK_SECRET_KEY: project.secretKey, RK_ENDPOINT: base, RK_TIMEZONE: 'Africa/Lagos' }, timeout: 60_000,
  }, (err, o, e) => resolve({ code: err ? err.code ?? 1 : 0, out: o + e })));
}
function wooSite(name, dbName) {
  const m = /host=([^;]+);port=(\d+)/.exec(DSN);
  const site = join(dir, name); mkdirSync(site);
  writeFileSync(join(site, 'wp-config.php'), `<?php\ndefine('DB_NAME', '${dbName}');\ndefine('DB_USER', '${RO_USER}');\ndefine('DB_PASSWORD', '${RO_PASS}');\ndefine('DB_HOST', '${m[1]}:${m[2]}');\n$table_prefix = 'wp_';\n`);
  return site;
}
const WP_CORE = (W) => `
  CREATE TABLE ${W}.wp_users (ID BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_login VARCHAR(60), user_pass VARCHAR(255), user_email VARCHAR(100), user_registered DATETIME, display_name VARCHAR(250));
  CREATE TABLE ${W}.wp_usermeta (umeta_id BIGINT PRIMARY KEY, user_id BIGINT, meta_key VARCHAR(255), meta_value LONGTEXT);
  CREATE TABLE ${W}.wp_posts (ID BIGINT UNSIGNED PRIMARY KEY, post_author BIGINT, post_date DATETIME, post_date_gmt DATETIME, post_status VARCHAR(20), post_type VARCHAR(20), post_title TEXT, post_parent BIGINT DEFAULT 0);
  CREATE TABLE ${W}.wp_postmeta (meta_id BIGINT AUTO_INCREMENT PRIMARY KEY, post_id BIGINT UNSIGNED, meta_key VARCHAR(255), meta_value LONGTEXT, KEY post_id (post_id), KEY meta_key (meta_key(191)));`;
const order = (W, id, type, status, when, meta) => `INSERT INTO ${W}.wp_posts VALUES (${id}, 1, '${when}', '${when}', '${status}', '${type}', 'Order', 0);
  ${Object.entries(meta).map(([k, v]) => `INSERT INTO ${W}.wp_postmeta (post_id, meta_key, meta_value) VALUES (${id}, '${k}', '${v}');`).join('\n')}`;

test('mysql: older WooCommerce (wp_posts + wp_postmeta): guests, refunds, drafts, unpaid orders, Paystack dedupe', { skip }, async () => {
  const W = `${DB}_woo_old`;
  const now = Date.now();
  await adminSql(`CREATE DATABASE ${W}; GRANT SELECT ON ${W}.* TO '${RO_USER}'@'%'; ${WP_CORE(W)}
    CREATE TABLE ${W}.wp_wc_orders (id BIGINT UNSIGNED PRIMARY KEY, status VARCHAR(20), type VARCHAR(20), total_amount DECIMAL(26,8), customer_id BIGINT, billing_email VARCHAR(320), date_created_gmt DATETIME, transaction_id VARCHAR(100));
    INSERT INTO ${W}.wp_users VALUES (1,'ada','$P$h','ada@old.ng','${lagos(now - 120 * DAY)}','Ada'),(2,'bola','$P$h','bola@old.ng','${lagos(now - 40 * DAY)}','Bola'),(3,'chi','$P$h','chi@old.ng','${lagos(now - 2 * DAY)}','Chi');
    ${order(W, 100, 'shop_order', 'wc-completed', lagos(now - 80 * DAY), { _customer_user: 1, _billing_email: 'ada@old.ng', _order_total: '15000.00', _transaction_id: 'PSK-REF-100' })}
    ${order(W, 101, 'shop_order', 'wc-processing', lagos(now - 50 * DAY), { _customer_user: 0, _billing_email: 'guest@old.ng', _billing_phone: '08035550000', _order_total: '4500.00' })}
    ${order(W, 102, 'shop_order', 'wc-pending', lagos(now - 3 * DAY), { _customer_user: 2, _billing_email: 'bola@old.ng', _order_total: '9000.00' })}
    ${order(W, 103, 'shop_order_refund', 'wc-completed', lagos(now - 79 * DAY), { _order_total: '-15000.00', _refund_amount: '15000.00' })}
    ${order(W, 104, 'shop_order', 'wc-checkout-draft', '0000-00-00 00:00:00', { _customer_user: 1, _order_total: '100.00' })}
    INSERT INTO ${W}.wp_posts VALUES (105, 1, NOW(), NOW(), 'publish', 'page', 'About us', 0);`);
  // Paystack already told RecoverKit about order 100 through its webhook.
  const ada = app.people.resolve(project.id, identityHashes(project.publicKey, { email: 'ada@old.ng' }));
  app.engine.recordPurchase(project.id, { personId: ada, ref: 'PSK-REF-100', amount: 1500000, currency: 'NGN', source: 'paystack', ts: now - 80 * DAY });

  const site = wooSite('woo-old', W);
  let r = await wooRun(site, ['setup', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Recognised WooCommerce \(older order storage, wp_posts \+ wp_postmeta\)/);
  assert.match(r.out, /amount `_order_total` \(from `wp_postmeta`\) in naira · buyer: account `_customer_user` \(from `wp_postmeta`\) or guest `_billing_email` \(from `wp_postmeta`\)/);
  assert.match(r.out, /3 people · 1 have bought \(2 sales\) · 2 never bought/);
  assert.match(r.out, /\+ 1 guest buyers who checked out without an account/);

  r = await wooRun(site, ['sync']);
  assert.equal(r.code, 0, r.out);
  const p = (who) => app.people.findByHashes(project.id, identityHashes(project.publicKey, who));
  const adaRows = app.db.all('SELECT amount, sources FROM purchases WHERE person_id = ?', p({ email: 'ada@old.ng' }));
  assert.deepEqual(adaRows.map((x) => ({ ...x })), [{ amount: 1500000, sources: 'connector,paystack' }], 'Paystack webhook + WooCommerce order = one sale; refund and draft ignored');
  const guest = p({ email: 'guest@old.ng' });
  assert.ok(guest, 'guest checkout became a person');
  assert.equal(p({ phone: '08035550000' }), guest, 'matched by billing phone too');
  assert.deepEqual(app.db.all('SELECT amount FROM purchases WHERE person_id = ?', guest).map((x) => x.amount), [450000]);
  const stage = Object.fromEntries(app.engine.leads(project.id, { minConfidence: 0 }).map((l) => [l.personId, l.stage]));
  assert.equal(stage[guest], 'bought_once', 'a guest who bought 50 days ago is a "gone quiet" lead');
  assert.equal(stage[p({ email: 'bola@old.ng' })], 'checkout_abandoned', 'unpaid order = abandoned checkout');
  assert.equal(stage[p({ email: 'chi@old.ng' })], 'registered');
  await adminSql(`DROP DATABASE ${W};`);
});

test('mysql: WooCommerce mid-migration (orders in both layouts) is counted once, refunds excluded, guest phone from addresses', { skip }, async () => {
  const W = `${DB}_woo_hpos`;
  const now = Date.now();
  await adminSql(`CREATE DATABASE ${W}; GRANT SELECT ON ${W}.* TO '${RO_USER}'@'%'; ${WP_CORE(W)}
    CREATE TABLE ${W}.wp_wc_orders (id BIGINT UNSIGNED PRIMARY KEY, status VARCHAR(20), currency VARCHAR(10), type VARCHAR(20), total_amount DECIMAL(26,8), customer_id BIGINT UNSIGNED, billing_email VARCHAR(320), date_created_gmt DATETIME, transaction_id VARCHAR(100), parent_order_id BIGINT DEFAULT 0);
    CREATE TABLE ${W}.wp_wc_order_addresses (id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id BIGINT UNSIGNED, address_type VARCHAR(20), first_name TEXT, email VARCHAR(320), phone VARCHAR(100));
    INSERT INTO ${W}.wp_users VALUES (1,'ada','$P$h','ada@hpos.ng','${lagos(now - 120 * DAY)}','Ada');
    INSERT INTO ${W}.wp_wc_orders VALUES
      (200,'wc-completed','NGN','shop_order',20000.00,1,'ada@hpos.ng','${lagos(now - 60 * DAY)}','PSK-200',0),
      (201,'wc-completed','NGN','shop_order_refund',-20000.00,1,'ada@hpos.ng','${lagos(now - 59 * DAY)}','',200),
      (202,'wc-processing','NGN','shop_order',7000.00,0,'guest@hpos.ng','${lagos(now - 45 * DAY)}','PSK-202',0);
    INSERT INTO ${W}.wp_wc_order_addresses (order_id, address_type, first_name, email, phone) VALUES (202,'billing','Kemi','guest@hpos.ng','08036660000'),(202,'shipping','Kemi','', '');
    ${order(W, 200, 'shop_order', 'wc-completed', lagos(now - 60 * DAY), { _customer_user: 1, _billing_email: 'ada@hpos.ng', _order_total: '20000.00' })}
    ${order(W, 202, 'shop_order', 'wc-processing', lagos(now - 45 * DAY), { _customer_user: 0, _billing_email: 'guest@hpos.ng', _order_total: '7000.00' })}`);
  const site = wooSite('woo-hpos', W);
  let r = await wooRun(site, ['setup', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Recognised WooCommerce \(newer order storage, wp_wc_orders\)/);
  assert.match(r.out, /where type is shop_order and status is wc-completed\/wc-processing/);
  assert.match(r.out, /1 people · 1 have bought \(2 sales\) · 0 never bought/);
  r = await wooRun(site, ['sync']);
  assert.equal(r.code, 0, r.out);
  const p = (who) => app.people.findByHashes(project.id, identityHashes(project.publicKey, who));
  assert.deepEqual(app.db.all('SELECT amount FROM purchases WHERE person_id = ?', p({ email: 'ada@hpos.ng' })).map((x) => x.amount), [2000000], 'one sale, no refund, no copy from wp_posts');
  assert.equal(p({ phone: '08036660000' }), p({ email: 'guest@hpos.ng' }), 'guest phone read from wc_order_addresses');
  assert.deepEqual(app.db.all('SELECT amount FROM purchases WHERE person_id = ?', p({ email: 'guest@hpos.ng' })).map((x) => x.amount), [700000]);
  await adminSql(`DROP DATABASE ${W};`);
});
