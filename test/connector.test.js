// The PHP read-only connector against a real (SQLite) VTU-style database and a real RecoverKit server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { identityHashes } from '../sdk/core/identity.js';

const DAY = 864e5;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONNECTOR = join(root, 'sdk/php/recoverkit-connector.php');
let app, base, dir, project, dbFile;
const aiCalls = [];

// Lagos local time text, the way most PHP apps store it.
const lagos = (ms) => new Date(ms + 3600e3).toISOString().replace('T', ' ').slice(0, 19);
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

const MAPPING = {
  people: { table: 'users', id: 'id', email: 'email', phone: 'phone', firstName: 'fullname', createdAt: 'created_at' },
  conversions: [{ name: 'vtu_purchase', table: 'transactions', key: 'id', userColumn: 'user_id', timeColumn: 'created_at', amountColumn: 'amount', amountUnit: 'major', refColumn: 'reference',
    filters: [{ column: 'status', values: ['successful'] }, { column: 'service', values: ['data', 'airtime'] }] }],
  signals: [{ name: 'wallet_funding', kind: 'deposit', table: 'wallet_fundings', key: 'id', userColumn: 'user_id', timeColumn: 'created_at', amountColumn: 'amount', amountUnit: 'major',
    filters: [{ column: 'status', values: ['success'] }] }, { name: 'ghost', kind: 'deposit', table: 'no_such_table', key: '', userColumn: 'x', timeColumn: 'y', amountColumn: '', amountUnit: 'minor', filters: [] }],
  notes: 'transactions mixes wallet credits and purchases; only data and airtime count as sales.',
};

const fakeAnthropic = { beta: { messages: { create: async (req) => {
  aiCalls.push(req);
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(MAPPING) }] };
} } } };

function php(args, env = {}) {
  return new Promise((resolve) => {
    execFile('php', [CONNECTOR, ...args], {
      env: { PATH: process.env.PATH, RK_PUBLIC_KEY: project.publicKey, RK_SECRET_KEY: project.secretKey, RK_ENDPOINT: base, RK_DB_DSN: `sqlite:${dbFile}`, RK_TIMEZONE: 'Africa/Lagos', ...env },
      timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr }));
  });
}

const personOf = (email) => app.people.findByHashes(project.id, identityHashes(project.publicKey, { email }));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rk-conn-'));
  dbFile = join(dir, 'vtu.sqlite');
  const now = Date.now();
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, fullname TEXT, email TEXT, phone TEXT, password TEXT, created_at TEXT);
    CREATE TABLE wallet_fundings (id INTEGER PRIMARY KEY, user_id INTEGER, amount REAL, status TEXT, created_at TEXT);
    CREATE TABLE transactions (id INTEGER PRIMARY KEY, user_id INTEGER, service TEXT, amount REAL, status TEXT, reference TEXT, created_at TEXT);`);
  const u = db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)');
  u.run(1, 'Ada Obi', 'ada@example.com', '08031110001', '$2y$10$secret-hash', lagos(now - 60 * DAY));
  u.run(2, 'Bayo Ade', 'bayo@example.com', '08031110002', '$2y$10$secret-hash', lagos(now - 30 * DAY));
  u.run(3, 'Chidi Eze', 'chidi@example.com', null, '$2y$10$secret-hash', lagos(now - 5 * DAY));
  u.run(4, 'Dupe Bello', 'dupe@example.com', null, '$2y$10$secret-hash', lagos(now - 500 * DAY));
  u.run(5, 'No Contact', null, null, '$2y$10$secret-hash', lagos(now - 10 * DAY));
  u.run(6, 'Funmi Ojo', 'funmi@example.com', null, '$2y$10$secret-hash', lagos(now - 3 * DAY));
  db.prepare('INSERT INTO wallet_fundings VALUES (?,?,?,?,?)').run(1, 2, 2000.0, 'success', lagos(now - 20 * DAY));
  const t = db.prepare('INSERT INTO transactions VALUES (?,?,?,?,?,?,?)');
  t.run(1, 1, 'data', 500.0, 'successful', 'VTU-AAA-1', lagos(now - 10 * DAY));
  t.run(2, 2, 'wallet_credit', 2000.0, 'successful', 'WAL-BBB-1', lagos(now - 20 * DAY)); // a deposit, NOT a sale
  t.run(3, 4, 'airtime', 1000.5, 'successful', 'VTU-DDD-1', lagos(now - 400 * DAY));
  t.run(4, 6, 'data', 300.0, 'failed', 'VTU-FFF-1', lagos(now - 2 * DAY));
  db.close();

  const config = {
    masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 'rk.db'), publicUrl: 'http://127.0.0.1', trustProxy: false,
    ai: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-test' }, allowPrivateAiUrls: false,
    attributionDays: 7, feePercent: 10, minDaysBetweenMessages: 7, retentionDays: 3650,
  };
  app = await createApp({ config, anthropicFactory: () => fakeAnthropic, logger: { log() {}, warn() {}, error() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  config.publicUrl = base;
  project = app.projects.create({ name: 'Ada VTU', gatewayMode: 'deposits' });
});

after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

test('setup: AI maps the schema from names only, dry run counts are right, nothing is written to the database', async () => {
  const before = sha(dbFile);
  const r = await php(['setup', '--yes', `--dir=${dir}`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Read-only session/);
  assert.match(r.out, /A SALE is:   a row in `transactions` where status is successful and service is data\/airtime/);
  assert.match(r.out, /6 people · 2 have bought \(2 sales\) · 4 never bought/);
  assert.equal(sha(dbFile), before, 'database file untouched');

  // What the AI saw: names, counts and status labels. Never emails, phones, names or password hashes.
  const sent = JSON.stringify(aiCalls);
  for (const secret of ['ada@example.com', '08031110001', 'Ada Obi', '$2y$10$', 'VTU-AAA-1']) assert.ok(!sent.includes(secret), `AI must not see ${secret}`);
  assert.match(sent, /wallet_credit/);
  assert.match(sent, /distinct status: successful \| failed/);

  const cfg = JSON.parse(readFileSync(join(dir, 'recoverkit-connector.json'), 'utf8'));
  assert.equal(cfg.shareContact, false, 'contact sharing is off unless the business says yes');
  assert.equal(cfg.mapping.signals.length, 1, 'the made-up table from the AI was dropped');
  assert.ok(!JSON.stringify(cfg).includes(project.secretKey), 'no secrets in the config file');
});

test('sync: history arrives, deposits are not sales, and only hashes leave', async () => {
  const r = await php(['sync', `--dir=${dir}`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Synced: 5 people/); // user 5 has no email or phone

  const purchases = (email) => app.db.all('SELECT amount, sources, ts FROM purchases WHERE person_id = ?', personOf(email));
  assert.deepEqual(purchases('ada@example.com').map((p) => p.amount), [50000]);
  assert.deepEqual(purchases('dupe@example.com').map((p) => p.amount), [100050], 'naira converted to kobo, 400-day-old history kept');
  assert.equal(purchases('bayo@example.com').length, 0, 'wallet credit is not a sale');
  assert.equal(purchases('funmi@example.com').length, 0, 'failed payment is not a sale');

  const leads = Object.fromEntries(app.engine.leads(project.id, { minConfidence: 0 }).map((l) => [l.personId, l]));
  assert.equal(leads[personOf('bayo@example.com')].stage, 'funded_not_bought');
  assert.equal(leads[personOf('chidi@example.com')].stage, 'registered');
  assert.equal(leads[personOf('dupe@example.com')].stage, 'bought_once');
  assert.equal(leads[personOf('ada@example.com')], undefined, 'recent buyer is not a lead');
  const first = app.db.get('SELECT first_seen FROM persons WHERE id = ?', personOf('dupe@example.com')).first_seen;
  assert.ok(Date.now() - first > 499 * DAY, 'signup date comes from their database, not today');

  assert.equal(app.db.get('SELECT COUNT(*) n FROM persons WHERE contact_enc IS NOT NULL AND project_id = ?', project.id).n, 0, 'no contact details stored');
  const log = readFileSync(join(dir, 'recoverkit-connector.log'), 'utf8').trim().split('\n');
  assert.ok(log.length > 5 && log.every((l) => / rows=\d+ SELECT /.test(l)), 'every logged query is a SELECT');
  assert.ok(!log.join('').includes('password'), 'the password column is never read');
  assert.ok(app.db.get('SELECT * FROM connector_runs WHERE project_id = ?', project.id));
});

test('sync again: nothing is duplicated', async () => {
  const count = () => app.db.get('SELECT COUNT(*) n FROM events WHERE project_id = ?', project.id).n;
  const n = count();
  const r = await php(['sync', `--dir=${dir}`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, / 0 new\./);
  assert.equal(count(), n);
  assert.equal(app.db.get('SELECT COUNT(*) n FROM purchases WHERE project_id = ?', project.id).n, 2);
});

test('new rows in their database show up on the next sync', async () => {
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO transactions VALUES (?,?,?,?,?,?,?)').run(5, 2, 'data', 750, 'successful', 'VTU-BBB-2', lagos(Date.now() - 60e3));
  db.close();
  const r = await php(['sync', `--dir=${dir}`]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(app.db.all('SELECT amount FROM purchases WHERE person_id = ?', personOf('bayo@example.com')).map((p) => p.amount), [75000]);
});

test('safety: stops if their tables change, and when the key is revoked', async () => {
  const changed = join(dir, 'changed');
  mkdirSync(changed);
  copyFileSync(join(dir, 'recoverkit-connector.json'), join(changed, 'recoverkit-connector.json'));
  const copy = join(changed, 'vtu.sqlite');
  copyFileSync(dbFile, copy);
  const db = new DatabaseSync(copy);
  db.exec('ALTER TABLE transactions RENAME COLUMN reference TO ref_no');
  db.close();
  let r = await php(['sync', `--dir=${changed}`], { RK_DB_DSN: `sqlite:${copy}` });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /tables changed since setup/);

  const keyId = project.secretKey.split('_').slice(2, 4).join('_');
  app.projects.revokeSecretKey(project.id, keyId);
  r = await php(['sync', `--dir=${dir}`]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /secret key was rejected/);
  project.secretKey = app.projects.createSecretKey(project.id, 'connector');
});

test('setup without AI uses built-in guesses and refuses to run unattended without --yes', async () => {
  const d2 = join(dir, 'noai');
  mkdirSync(d2);
  let r = await php(['setup', '--no-ai', `--dir=${d2}`]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /run it in a terminal, or pass --yes/);
  r = await php(['setup', '--no-ai', '--yes', `--dir=${d2}`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /People:      table `users`/);
  assert.match(r.out, /Not a sale:  `wallet_fundings`/);
  assert.ok(existsSync(join(d2, 'recoverkit-connector.json')));
});

test('sync endpoint validates input and needs the secret key', async () => {
  const post = (body, key = project.secretKey) => fetch(base + '/v1/connector/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const ids = identityHashes(project.publicKey, { email: 'x@example.com' });
  assert.equal((await post({ events: [] }, 'rk_sec_nope')).status, 401);
  assert.equal((await post({ events: [{ kind: 'conversion', name: 'x', ids, key: 'short', ts: Date.now(), amount: 1 }] })).status, 400);
  assert.equal((await post({ events: [{ kind: 'conversion', name: 'x', ids, key: 'a'.repeat(64), ts: Date.now() - 6 * 365 * DAY, amount: 1 }] })).status, 400);
  assert.equal((await post({ events: [{ kind: 'signal', signal: '__proto__', name: 'x', ids, key: 'b'.repeat(64), ts: Date.now() }] })).status, 400);
  assert.equal((await post({ events: Array(501).fill({}) })).status, 400);
  assert.equal((await post({ people: [{ ids, key: 'c'.repeat(64), contact: { email: 'x@example.com' } }] })).status, 200);
  assert.equal(app.people.getContact(project.id, personOf('x@example.com')).email, undefined, 'contact ignored unless shareContact is true');
});

test('dashboard shows the connector status', async () => {
  app.projects.createUser(project.id, 'owner@adavtu.ng', 'a-very-long-password-1');
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=owner%40adavtu.ng&password=a-very-long-password-1' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const html = await (await fetch(base + '/dashboard/settings', { headers: { Cookie: cookie } })).text();
  assert.match(html, /Existing data \(read-only connector\)/);
  assert.match(html, /Synced just now/);
});
