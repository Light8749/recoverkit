// The PHP connector against a real PostgreSQL server (embedded-postgres runs one in a temp folder).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createApp } from '../src/server.js';
import { identityHashes } from '../sdk/core/identity.js';

let EmbeddedPostgres = null;
try { ({ default: EmbeddedPostgres } = await import('embedded-postgres')); } catch { /* optional */ }
const skip = EmbeddedPostgres ? false : 'npm install (dev dependencies) to run the PostgreSQL tests';
const DAY = 864e5;
const CONNECTOR = join(dirname(fileURLToPath(import.meta.url)), '../sdk/php/recoverkit-connector.php');
const PORT = 54000 + Math.floor(Math.random() * 1000);
let pg, sql, app, base, dir, project;
const lagos = (ms) => new Date(ms + 3600e3).toISOString().replace('T', ' ').slice(0, 19);

function php(args, env = {}) {
  return new Promise((resolve) => execFile('php', [CONNECTOR, ...args], {
    env: { PATH: process.env.PATH, RK_PUBLIC_KEY: project.publicKey, RK_SECRET_KEY: project.secretKey, RK_ENDPOINT: base, RK_TIMEZONE: 'Africa/Lagos',
      RK_DB_DSN: `pgsql:host=127.0.0.1;port=${PORT};dbname=vtu`, RK_DB_USER: 'rk_reader', RK_DB_PASS: 'reader-pw', ...env },
    timeout: 60_000,
  }, (err, o, e) => resolve({ code: err ? err.code ?? 1 : 0, out: o + e })));
}
const personOf = (who) => app.people.findByHashes(project.id, identityHashes(project.publicKey, who));

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'rk-pg-'));
  pg = new EmbeddedPostgres({ databaseDir: join(dir, 'pgdata'), user: 'postgres', password: 'admin-pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('vtu');
  sql = pg.getPgClient('vtu');
  await sql.connect();
  const now = Date.now();
  await sql.query(`
    CREATE TYPE txn_status AS ENUM ('pending', 'successful', 'failed');
    CREATE TABLE users (id SERIAL PRIMARY KEY, fullname TEXT, email VARCHAR(190) UNIQUE, phone VARCHAR(20), password TEXT, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE wallet_fundings (id BIGSERIAL PRIMARY KEY, user_id INT REFERENCES users(id), amount NUMERIC(12,2), status VARCHAR(20), created_at TIMESTAMP);
    CREATE TABLE transactions (id BIGSERIAL PRIMARY KEY, user_id INT REFERENCES users(id), service VARCHAR(20), amount NUMERIC(12,2), status txn_status, reference VARCHAR(64), created_at TIMESTAMP);
    INSERT INTO users (id, fullname, email, phone, password, created_at) VALUES
      (1,'Ada Obi','ada@pg.ng','08031110001','$2y$secret','${new Date(now - 60 * DAY).toISOString()}'),
      (2,'Bayo Ade','bayo@pg.ng','08031110002','$2y$secret','${new Date(now - 30 * DAY).toISOString()}'),
      (3,'Chidi Eze','chidi@pg.ng',NULL,'$2y$secret','${new Date(now - 5 * DAY).toISOString()}'),
      (4,'Dupe Bello','dupe@pg.ng',NULL,'$2y$secret','${new Date(now - 500 * DAY).toISOString()}');
    INSERT INTO wallet_fundings (user_id, amount, status, created_at) VALUES (2, 2000.00, 'success', '${lagos(now - 20 * DAY)}');
    INSERT INTO transactions (user_id, service, amount, status, reference, created_at) VALUES
      (1,'data',500.00,'successful','VTU-A1','${lagos(now - 10 * DAY)}'),
      (2,'wallet_credit',2000.00,'successful','WAL-B1','${lagos(now - 20 * DAY)}'),
      (4,'airtime',1000.50,'successful','VTU-D1','${lagos(now - 400 * DAY)}'),
      (3,'data',300.00,'failed','VTU-C1','${lagos(now - 2 * DAY)}');
    CREATE ROLE rk_reader LOGIN PASSWORD 'reader-pw';
    GRANT CONNECT ON DATABASE vtu TO rk_reader;
    GRANT USAGE ON SCHEMA public TO rk_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO rk_reader;`);

  const MAPPING = {
    people: { table: 'users', id: 'id', email: 'email', phone: 'phone', firstName: 'fullname', createdAt: 'created_at' },
    conversions: [{ name: 'vtu_purchase', table: 'transactions', key: 'id', userColumn: 'user_id', emailColumn: '', phoneColumn: '', timeColumn: 'created_at', amountColumn: 'amount', amountUnit: 'major', refColumn: 'reference',
      filters: [{ column: 'status', values: ['successful'] }, { column: 'service', values: ['data', 'airtime'] }], meta: null }],
    signals: [{ name: 'wallet_funding', kind: 'deposit', table: 'wallet_fundings', key: 'id', userColumn: 'user_id', emailColumn: '', phoneColumn: '', timeColumn: 'created_at', amountColumn: 'amount', amountUnit: 'major',
      filters: [{ column: 'status', values: ['success'] }], meta: null }],
    notes: '',
  };
  const fakeAnthropic = { beta: { messages: { create: async (req) => {
    fakeAnthropic.last = req;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(MAPPING) }] };
  } } } };
  const config = {
    masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 'rk.db'), publicUrl: 'http://127.0.0.1', trustProxy: false,
    ai: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-test' }, allowPrivateAiUrls: false,
    attributionDays: 7, feePercent: 10, minDaysBetweenMessages: 7, retentionDays: 3650,
  };
  app = await createApp({ config, anthropicFactory: () => fakeAnthropic, logger: { log() {}, warn() {}, error() {} } });
  app.fakeAnthropic = fakeAnthropic;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  config.publicUrl = base;
  project = app.projects.create({ name: 'Ada VTU (PostgreSQL)', gatewayMode: 'deposits' });
}, { timeout: 180_000 });

after(async () => {
  if (skip) return;
  await sql?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('postgres: the superuser login gets a warning; the reader role passes', { skip }, async () => {
  const d = join(dir, 'admin'); mkdirSync(d);
  let r = await php(['setup', '--yes', '--no-ai', `--dir=${d}`], { RK_DB_USER: 'postgres', RK_DB_PASS: 'admin-pw' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /This database login can also WRITE/);
  assert.match(r.out, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO recoverkit;/);
  r = await php(['setup', '--yes', `--dir=${dir}`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ Read-only session/);
  assert.match(r.out, /4 people · 2 have bought \(2 sales\) · 2 never bought/);
  const sent = JSON.stringify(app.fakeAnthropic.last);
  assert.match(sent, /distinct status: [a-z |]*successful/, 'Postgres ENUM values discovered');
  assert.ok(!/ada@pg\.ng|Ada Obi|\$2y\$/.test(sent));
});

test('postgres: NUMERIC, TIMESTAMPTZ and TIMESTAMP history; deposits are not sales; idempotent', { skip }, async () => {
  let r = await php(['sync', `--dir=${dir}`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Synced: 4 people/);
  const amounts = (email) => app.db.all('SELECT amount FROM purchases WHERE person_id = ?', personOf({ email })).map((x) => x.amount);
  assert.deepEqual(amounts('ada@pg.ng'), [50000]);
  assert.deepEqual(amounts('dupe@pg.ng'), [100050]);
  assert.deepEqual(amounts('bayo@pg.ng'), []);
  const stage = Object.fromEntries(app.engine.leads(project.id, { minConfidence: 0 }).map((l) => [l.personId, l.stage]));
  assert.equal(stage[personOf({ email: 'bayo@pg.ng' })], 'funded_not_bought');
  assert.equal(stage[personOf({ email: 'dupe@pg.ng' })], 'bought_once');
  assert.ok(Date.now() - app.db.get('SELECT first_seen FROM persons WHERE id = ?', personOf({ email: 'dupe@pg.ng' })).first_seen > 499 * DAY, 'TIMESTAMPTZ signup kept');
  r = await php(['sync', `--dir=${dir}`]);
  assert.match(r.out, / 0 new\./, r.out);
  await sql.query(`INSERT INTO transactions (user_id, service, amount, status, reference, created_at) VALUES (2,'data',750.00,'successful','VTU-B2','${lagos(Date.now() - 60e3)}')`);
  r = await php(['sync', `--dir=${dir}`]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(amounts('bayo@pg.ng'), [75000]);
  const log = readFileSync(join(dir, 'recoverkit-connector.log'), 'utf8').trim().split('\n');
  assert.ok(log.every((l) => / rows=\d+ SELECT /.test(l)));
});

test('postgres: the reader role really cannot write', { skip }, async () => {
  const code = '$p = new PDO(getenv("RK_DB_DSN"), getenv("RK_DB_USER"), getenv("RK_DB_PASS"), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]); try { $p->exec("DELETE FROM users"); echo "WROTE"; } catch (PDOException $e) { echo "DENIED"; }';
  const out = await new Promise((res) => execFile('php', ['-r', code], { env: { PATH: process.env.PATH, RK_DB_DSN: `pgsql:host=127.0.0.1;port=${PORT};dbname=vtu`, RK_DB_USER: 'rk_reader', RK_DB_PASS: 'reader-pw' } }, (_e, o) => res(o)));
  assert.equal(out, 'DENIED');
});

test('postgres: found automatically from a Django project via --app', { skip }, async () => {
  const site = join(dir, 'django'); mkdirSync(join(site, 'shop'), { recursive: true });
  writeFileSync(join(site, 'manage.py'), '');
  writeFileSync(join(site, 'shop/settings.py'), `import os\nDATABASES = {\n    'default': {\n        'ENGINE': 'django.db.backends.postgresql',\n        'NAME': 'vtu',\n        'USER': os.environ.get('DB_USER'),\n        'PASSWORD': os.environ.get('DB_PASSWORD'),\n        'HOST': '127.0.0.1',\n        'PORT': '${PORT}',\n    }\n}\n`);
  writeFileSync(join(site, '.env'), 'DB_USER=rk_reader\nDB_PASSWORD=reader-pw\n');
  const r = await php(['setup', '--yes', '--no-ai', `--app=${site}`], { RK_DB_DSN: undefined, RK_DB_USER: undefined, RK_DB_PASS: undefined });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Found your database in shop\/settings\.py \(Django\): pgsql:host=127\.0\.0\.1;port=\d+;dbname=vtu/);
  assert.match(r.out, /People:      table `users`/);
});
