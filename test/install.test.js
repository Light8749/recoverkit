// One-command install, end to end: the Developers page makes a one-time code, a developer runs the
// downloaded installer in their app folder, and it connects, maps a PadiConnect-style database and syncs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { identityHashes } from '../sdk/core/identity.js';

let app, base, dir, project, cookie, appDir, home, dbFile;
const PW = 'owner-password-long-1';
const run = (args, cwd) => new Promise((resolve) => execFile('php', args, { cwd, env: { PATH: process.env.PATH, HOME: home, RK_TIMEZONE: 'Africa/Lagos' }, timeout: 60_000 },
  (err, o, e) => resolve({ code: err ? err.code ?? 1 : 0, out: o + e })));
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 19).replace('T', ' ');

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rk-install-'));
  const config = { masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 'rk.db'), publicUrl: 'http://127.0.0.1', trustProxy: false, ai: { provider: 'none' }, attributionDays: 7, feePercent: 0, minDaysBetweenMessages: 7, scheduler: false };
  app = await createApp({ config, logger: { log() {}, warn() {}, error() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  config.publicUrl = base;
  project = app.projects.create({ name: 'PadiConnect', gatewayMode: 'deposits' });
  app.projects.createUser(project.id, 'owner@padi.ng', PW);
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'owner@padi.ng', password: PW }) });
  cookie = r.headers.get('set-cookie').split(';')[0];

  // A PadiConnect-shaped app: plain PHP, .env with DB_* settings, users + wallet_transactions.
  home = join(dir, 'home'); mkdirSync(home);
  appDir = join(dir, 'public_html'); mkdirSync(appDir);
  dbFile = join(dir, 'padi.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, api_key TEXT, first_name TEXT NOT NULL, email TEXT NOT NULL, phone_number TEXT NOT NULL,
    banned TINYINT NOT NULL DEFAULT 0, wallet_balance DECIMAL(10,2) NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE wallet_transactions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, transaction_type VARCHAR(100) NOT NULL, amount DECIMAL(10,2) NOT NULL,
    transaction_reference VARCHAR(255), status VARCHAR(20) DEFAULT 'pending', created_at TEXT NOT NULL);`);
  const u = db.prepare('INSERT INTO users (id, api_key, first_name, email, phone_number, banned, created_at) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'k1', 'Ada', 'ada@x.ng', '08031110001', 0, iso(40));
  u.run(2, 'k2', 'Bola', 'bola@x.ng', '08031110002', 0, iso(35));
  u.run(3, 'k3', 'Chidi', 'chidi@x.ng', '08031110003', 0, iso(30));
  u.run(4, 'k4', 'Gone', 'deleted_4_1700000000@removed.local', '08031110004', 1, iso(25));
  u.run(5, 'k5', 'Emeka', 'emeka@x.ng', '08031110005', 0, iso(20));
  const t = db.prepare('INSERT INTO wallet_transactions (user_id, transaction_type, amount, transaction_reference, status, created_at) VALUES (?,?,?,?,?,?)');
  t.run(1, 'deposit', 5000, 'DEP-1', 'completed', iso(20));
  t.run(1, 'Data Purchase', 1000, 'DATA-F', 'failed', iso(19));
  t.run(2, 'deposit', 3000, 'DEP-2', 'completed', iso(18));
  t.run(2, 'Data Purchase', 1500, 'DATA-2', 'completed', iso(17));
  t.run(4, 'deposit', 2000, 'DEP-4', 'completed', iso(16));
  t.run(5, 'Withdrawal', 500, 'WD-5', 'completed', iso(15));
  t.run(5, 'Agent Commission', 200, 'AC-5', 'completed', iso(14));
  db.close();
  writeFileSync(join(appDir, '.env'), `DB_CONNECTION=sqlite\nDB_NAME=${dbFile}\nAPP_NAME=padi\n`);
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

test('one command: create the code, download the installer, run it, customers arrive', async () => {
  // 1. The owner clicks "Create install command".
  const page = await (await fetch(base + '/dashboard/developers', { headers: { Cookie: cookie } })).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)[1];
  const made = await (await fetch(base + '/dashboard/developers/install-code', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf }) })).text();
  const cmd = /curl -fsSLo recoverkit-install\.php (\S+)\/install\.php &amp;&amp; php recoverkit-install\.php ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(made);
  assert.ok(cmd, 'the command is shown');
  const code = cmd[2];
  assert.equal(app.db.get('SELECT COUNT(*) n FROM install_codes WHERE code_hash = ?', code).n, 0, 'only a hash is stored');

  // 2. The developer downloads the installer into the app folder and runs it.
  const installer = await fetch(base + '/install.php');
  assert.match(installer.headers.get('content-disposition'), /recoverkit-install\.php/);
  const src = await installer.text();
  assert.ok(src.startsWith('<?php') && src.includes(`'"${base}"'`), 'this server\'s address is built in');
  writeFileSync(join(appDir, 'recoverkit-install.php'), src);
  const envBefore = readFileSync(join(appDir, '.env'), 'utf8');
  const r = await run(['recoverkit-install.php', code, '--yes', '--no-cron'], appDir);
  assert.equal(r.code, 0, r.out);
  if (process.env.SHOW_INSTALL) console.log(r.out);
  assert.match(r.out, /Connected to PadiConnect/);
  assert.match(r.out, /Found your database in \.env/);
  assert.match(r.out, /where banned is 0/, 'banned and deleted accounts left out');
  assert.match(r.out, /A SALE is:   a row in `wallet_transactions` where status is completed and transaction_type is Data Purchase/);
  assert.match(r.out, /Not a sale:  `wallet_transactions` where status is completed and transaction_type is deposit → deposit/);
  assert.match(r.out, /4 people · 1 have bought \(1 sales\) · 3 never bought/);
  assert.match(r.out, /3 people funded their wallet/);
  assert.match(r.out, /Done\. Open your RecoverKit dashboard/);
  assert.match(r.out, /cron job/i);

  // 3. Nothing secret was left in the app folder; the installer removed itself.
  assert.ok(!existsSync(join(appDir, 'recoverkit-install.php')), 'installer deleted itself');
  assert.equal(readFileSync(join(appDir, '.env'), 'utf8'), envBefore, 'the app .env is untouched');
  assert.deepEqual(readdirSync(appDir).sort(), ['.env']);
  const connDir = readdirSync(home).find((d) => d.startsWith('recoverkit-connector-'));
  assert.ok(connDir);
  const keyFile = join(home, connDir, '.recoverkit-keys.json');
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(keyFile, 'utf8')).RK_PUBLIC_KEY, project.publicKey);

  // 4. RecoverKit has the right people: banned one out, buyer counted, funder is a lead.
  const pid = (email) => app.people.findByHashes(project.id, identityHashes(project.publicKey, { email }));
  assert.ok(pid('ada@x.ng') && pid('bola@x.ng') && pid('chidi@x.ng') && pid('emeka@x.ng'));
  assert.equal(pid('deleted_4_1700000000@removed.local'), null, 'banned account not sent');
  assert.equal(app.db.get('SELECT COUNT(*) n FROM purchases WHERE project_id = ?', project.id).n, 1, 'withdrawals, commissions and failed purchases are not sales');
  const f = app.engine.funnel(project.id);
  assert.equal(f.funded_not_bought, 1, 'Ada funded and never bought');
  assert.equal(app.db.get("SELECT label FROM api_keys WHERE project_id = ? AND label = 'connector (installed)'", project.id)?.label, 'connector (installed)');

  // 5. The cron line works on its own (no --app, no keys in the environment), and only sends what's new.
  const again = await run([join(home, connDir, 'recoverkit-connector.php'), 'sync', `--dir=${join(home, connDir)}`], home);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /Synced: .* 0 new\./);

  // 6. A kind of purchase that didn't exist on install day still counts later ("auto" type lists).
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO wallet_transactions (user_id, transaction_type, amount, transaction_reference, status, created_at) VALUES (?,?,?,?,?,?)').run(1, 'Airtime Purchase', 800, 'AIR-1', 'completed', iso(0));
  db.close();
  const later = await run([join(home, connDir, 'recoverkit-connector.php'), 'sync', `--dir=${join(home, connDir)}`], home);
  assert.equal(later.code, 0, later.out);
  assert.equal(app.db.get('SELECT COUNT(*) n FROM purchases WHERE project_id = ?', project.id).n, 2, 'the new Airtime Purchase is a sale');

  // 7. A code works once.
  const reuse = await fetch(base + '/v1/connector/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(reuse.status, 401);
  assert.match((await reuse.json()).error, /expired or was already used/);
});

test('run where the database can\'t be reached: it stops before using the code', async () => {
  const wrong = join(dir, 'laptop-copy'); mkdirSync(wrong);
  writeFileSync(join(wrong, '.env'), 'DB_HOST=127.0.0.1\nDB_PORT=1\nDB_NAME=padi_connect\nDB_USER=root\nDB_PASS=x\n');
  const { createInstall } = await import('../src/install.js');
  const inst = createInstall({ db: app.db, config: { publicUrl: base }, projects: app.projects, limiter: app.limiter });
  const code = inst.createCode(project.id, 'test');
  writeFileSync(join(wrong, 'recoverkit-install.php'), await (await fetch(base + '/install.php')).text());
  const r = await run(['recoverkit-install.php', code, '--yes', '--no-cron'], wrong);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /could not connect to the database/);
  assert.match(r.out, /on the server where the app and its database live/);
  assert.ok(!/Connected to PadiConnect/.test(r.out), 'the code was not used');
  assert.equal(app.db.get('SELECT used_at FROM install_codes WHERE used_at IS NULL AND expires_at > ? LIMIT 1', Date.now()) !== undefined, true, 'still usable');
});

test('install codes expire, and bad codes are refused and rate limited', async () => {
  const code = 'ABCD-EFGH-JKMN';
  const claim = (c) => fetch(base + '/v1/connector/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: c }) });
  assert.equal((await claim('short')).status, 400);
  assert.equal((await claim(code)).status, 401);
  // An expired code.
  const { createInstall } = await import('../src/install.js');
  const inst = createInstall({ db: app.db, config: { publicUrl: base }, projects: app.projects, limiter: app.limiter });
  const real = inst.createCode(project.id, 'test');
  app.db.run('UPDATE install_codes SET expires_at = ? WHERE used_at IS NULL', Date.now() - 1);
  assert.equal((await claim(real)).status, 401);
  let limited = false;
  for (let i = 0; i < 12; i++) if ((await claim(code)).status === 429) limited = true;
  assert.ok(limited, 'rate limited');
});

test('the installer refuses to run from a web request', async () => {
  const src = await (await fetch(base + '/install.php')).text();
  assert.match(src, /PHP_SAPI !== 'cli'/);
});
