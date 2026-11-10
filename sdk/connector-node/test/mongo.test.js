// The MongoDB connector against a real mongod (downloaded by mongodb-memory-server) and a real RecoverKit server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, Decimal128 } from 'mongodb';
import { Connector, detectMongo } from '../recoverkit-connector.mjs';
import { createApp } from '../../../src/server.js';
import { identityHashes } from '../../core/identity.js';

const here = dirname(fileURLToPath(import.meta.url));
const DAY = 864e5;
let mongo, admin, app, base, dir, project, roUri, openMongo;
const aiCalls = [];
const ids = { ada: new ObjectId(), bayo: new ObjectId(), chidi: new ObjectId(), dupe: new ObjectId(), none: new ObjectId(), funmi: new ObjectId() };

const MAPPING = {
  people: { table: 'users', id: '_id', email: 'email', phone: 'phone', firstName: 'name', createdAt: 'createdAt' },
  conversions: [
    { name: 'vtu_purchase', table: 'transactions', key: '_id', userColumn: 'userId', emailColumn: '', phoneColumn: '', timeColumn: 'createdAt', amountColumn: 'amount', amountUnit: 'major', refColumn: 'reference',
      filters: [{ column: 'status', values: ['success'] }, { column: 'type', values: ['data', 'airtime'] }], meta: null },
    { name: 'guest_order', table: 'orders', key: '_id', userColumn: '', emailColumn: 'customerEmail', phoneColumn: 'customerPhone', timeColumn: 'createdAt', amountColumn: 'total', amountUnit: 'major', refColumn: '',
      filters: [{ column: 'status', values: ['paid'] }], meta: null },
  ],
  signals: [{ name: 'wallet_funding', kind: 'deposit', table: 'transactions', key: '_id', userColumn: 'userId', emailColumn: '', phoneColumn: '', timeColumn: 'createdAt', amountColumn: 'amount', amountUnit: 'major',
    filters: [{ column: 'status', values: ['success'] }, { column: 'type', values: ['deposit'] }], meta: null }],
  notes: 'transactions mixes wallet deposits and purchases.',
};
const fakeAnthropic = { beta: { messages: { create: async (req) => { aiCalls.push(req); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(MAPPING) }] }; } } } };

function connector(extraEnv = {}, opts = {}) {
  const lines = [];
  const c = new Connector({
    env: { RK_PUBLIC_KEY: project.publicKey, RK_SECRET_KEY: project.secretKey, RK_ENDPOINT: base, MONGODB_URI: roUri, ...extraEnv },
    dir: opts.dir || dir, assumeYes: opts.yes ?? true, out: (s) => lines.push(s),
  });
  return { c, lines, text: () => lines.join('\n') };
}
async function run(cmd, extraEnv, opts) {
  const k = connector(extraEnv, opts);
  try { await (cmd === 'setup' ? k.c.setup({ useAi: opts?.ai ?? true }) : k.c.sync()); return { ok: true, out: k.text() }; }
  catch (e) { return { ok: false, out: k.text() + '\n' + e.message }; }
  finally { await k.c.close(); }
}
const personOf = (who) => app.people.findByHashes(project.id, identityHashes(project.publicKey, who));

before(async () => {
  mongo = await MongoMemoryServer.create({ auth: { enable: true, customRootName: 'root', customRootPwd: 'root-pw' } });
  const host = new URL(mongo.getUri()).host;
  admin = new MongoClient(`mongodb://root:root-pw@${host}/?authSource=admin`);
  await admin.connect();
  const db = admin.db('vtu');
  const now = Date.now();
  const at = (d) => new Date(now - d * DAY);
  await db.collection('users').insertMany([
    { _id: ids.ada, name: 'Ada Obi', email: 'ada@m.ng', phone: '08031110001', password: '$2b$10$hash', createdAt: at(60), orders: [] },
    { _id: ids.bayo, name: 'Bayo Ade', email: 'bayo@m.ng', phone: '08031110002', password: '$2b$10$hash', createdAt: at(30) },
    { _id: ids.chidi, name: 'Chidi Eze', email: 'chidi@m.ng', password: '$2b$10$hash', createdAt: at(5) },
    { _id: ids.dupe, name: 'Dupe Bello', email: 'dupe@m.ng', password: '$2b$10$hash', createdAt: at(500) },
    { _id: ids.none, name: 'No Contact', password: '$2b$10$hash', createdAt: at(10) },
    { _id: ids.funmi, name: 'Funmi Ojo', email: 'funmi@m.ng', password: '$2b$10$hash', createdAt: at(3) },
  ]);
  await db.collection('transactions').insertMany([
    { userId: ids.ada, type: 'data', amount: 500, status: 'success', reference: 'VTU-A1', createdAt: at(10) },
    { userId: ids.bayo, type: 'deposit', amount: 2000, status: 'success', reference: 'DEP-B1', createdAt: at(20) },
    { userId: ids.dupe, type: 'airtime', amount: Decimal128.fromString('1000.50'), status: 'success', reference: 'VTU-D1', createdAt: at(400) },
    { userId: ids.funmi, type: 'data', amount: 300, status: 'failed', reference: 'VTU-F1', createdAt: at(2) },
  ]);
  await db.collection('orders').insertMany([
    { customerEmail: 'guest@m.ng', customerPhone: '+234 803 555 0000', total: 3500, status: 'paid', createdAt: at(40) },
    { customerEmail: 'abandoned@m.ng', total: 1200, status: 'pending', createdAt: at(1) },
  ]);
  await db.command({ createUser: 'reader', pwd: 'reader-pw', roles: [{ role: 'read', db: 'vtu' }] });
  roUri = `mongodb://reader:reader-pw@${host}/vtu?authSource=vtu`;

  // A second server with no login at all (common on small VPS setups).
  openMongo = await MongoMemoryServer.create();
  const open = new MongoClient(openMongo.getUri()); await open.connect();
  await open.db('shop').collection('customers').insertOne({ email: 'x@open.ng', createdAt: new Date() });
  await open.close();

  dir = mkdtempSync(join(tmpdir(), 'rk-mongo-'));
  const config = {
    masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 'rk.db'), publicUrl: 'http://127.0.0.1', trustProxy: false,
    ai: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-test' }, allowPrivateAiUrls: false,
    attributionDays: 7, feePercent: 10, minDaysBetweenMessages: 7, retentionDays: 3650,
  };
  app = await createApp({ config, anthropicFactory: () => fakeAnthropic, logger: { log() {}, warn() {}, error() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  config.publicUrl = base;
  project = app.projects.create({ name: 'Ada VTU (MongoDB)', gatewayMode: 'deposits' });
}, { timeout: 240_000 });

after(async () => {
  await admin?.close();
  await mongo?.stop(); await openMongo?.stop();
  await app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('a server with no login gets a clear warning and a read-only user recipe', async () => {
  const d = join(dir, 'open'); mkdirSync(d);
  const r = await run('setup', { MONGODB_URI: openMongo.getUri('shop') }, { dir: d, ai: false });
  assert.match(r.out, /has no login at all/);
  assert.match(r.out, /roles: \[\{ role: "read", db: "shop" \}\]/);
});

test('setup with a read-only login: names only to the AI, guest buyers counted, correct dry run', async () => {
  const r = await run('setup');
  assert.ok(r.ok, r.out);
  assert.match(r.out, /✓ This login can only read\./);
  assert.match(r.out, /A SALE is:   a document in `transactions` where status is success and type is data\/airtime, amount `amount` in naira · buyer: account `userId`/);
  assert.match(r.out, /buyer: guest `customerEmail` `customerPhone`/);
  assert.match(r.out, /6 people · 2 have bought \(3 sales\) · 4 never bought/);
  assert.match(r.out, /\+ 1 guest buyers/);
  const sent = JSON.stringify(aiCalls);
  for (const s of ['ada@m.ng', '08031110001', 'Ada Obi', '$2b$10$', 'VTU-A1', 'guest@m.ng']) assert.ok(!sent.includes(s), `AI must not see ${s}`);
  assert.match(sent, /distinct type: /);
  assert.match(sent, /deposit/);
  assert.ok(!JSON.stringify(JSON.parse(readFileSync(join(dir, 'recoverkit-connector.json'), 'utf8'))).includes('reader-pw'), 'no password in config');
});

test('the read-only login really cannot write', async () => {
  const c = new MongoClient(roUri); await c.connect();
  await assert.rejects(c.db('vtu').collection('users').deleteMany({}), /not authorized|Unauthorized/i);
  await c.close();
});

test('sync: ObjectId references, Decimal128 naira, guests, deposits not sales, nothing written', async () => {
  const before = await admin.db('vtu').collection('users').countDocuments();
  const r = await run('sync');
  assert.ok(r.ok, r.out);
  assert.match(r.out, /Synced: 5 people/);
  const amounts = (who) => app.db.all('SELECT amount FROM purchases WHERE person_id = ?', personOf(who)).map((x) => x.amount);
  assert.deepEqual(amounts({ email: 'ada@m.ng' }), [50000]);
  assert.deepEqual(amounts({ email: 'dupe@m.ng' }), [100050]);
  assert.deepEqual(amounts({ email: 'bayo@m.ng' }), []);
  assert.deepEqual(amounts({ email: 'funmi@m.ng' }), []);
  assert.deepEqual(amounts({ email: 'guest@m.ng' }), [350000]);
  assert.equal(personOf({ phone: '08035550000' }), personOf({ email: 'guest@m.ng' }), 'guest matched by phone too');
  assert.equal(personOf({ email: 'abandoned@m.ng' }), null, 'unpaid guest order is not a sale and not mapped as a signal');
  const stage = Object.fromEntries(app.engine.leads(project.id, { minConfidence: 0 }).map((l) => [l.personId, l.stage]));
  assert.equal(stage[personOf({ email: 'bayo@m.ng' })], 'funded_not_bought');
  assert.equal(stage[personOf({ email: 'dupe@m.ng' })], 'bought_once');
  assert.equal(stage[personOf({ email: 'guest@m.ng' })], 'bought_once');
  assert.equal(stage[personOf({ email: 'chidi@m.ng' })], 'registered');
  assert.ok(Date.now() - app.db.get('SELECT first_seen FROM persons WHERE id = ?', personOf({ email: 'dupe@m.ng' })).first_seen > 499 * DAY);
  assert.equal(await admin.db('vtu').collection('users').countDocuments(), before);
  const log = readFileSync(join(dir, 'recoverkit-connector.log'), 'utf8');
  assert.ok(!/ada@m\.ng|reader-pw/.test(log), 'no emails or passwords in the local log');
  assert.ok(log.split('\n').filter(Boolean).every((l) => / (find|aggregate) /.test(l)), 'only reads logged');
});

test('re-sync is idempotent; new documents arrive incrementally', async () => {
  let r = await run('sync');
  assert.match(r.out, / 0 new\./, r.out);
  await admin.db('vtu').collection('transactions').insertOne({ userId: ids.bayo, type: 'data', amount: 750, status: 'success', reference: 'VTU-B2', createdAt: new Date(Date.now() - 60e3) });
  r = await run('sync');
  assert.ok(r.ok, r.out);
  assert.deepEqual(app.db.all('SELECT amount FROM purchases WHERE person_id = ?', personOf({ email: 'bayo@m.ng' })).map((x) => x.amount), [75000]);
});

test('built-in guesses without AI', async () => {
  const d = join(dir, 'noai'); mkdirSync(d);
  const r = await run('setup', {}, { dir: d, ai: false });
  assert.ok(r.ok, r.out);
  assert.match(r.out, /People:      collection `users`/);
  assert.match(r.out, /A SALE is:   a document in `orders` where status is paid, amount `total`.* · buyer: guest `customerEmail`/);
});

test('detect: the env var a Node app passes to mongoose.connect, and Prisma', async () => {
  const appDir = join(dir, 'node-app'); mkdirSync(join(appDir, 'src'), { recursive: true });
  writeFileSync(join(appDir, '.env'), 'PORT=3000\nMONGO_DB_LINK=mongodb://u:p@db.internal:27017/shop\nDATABASE_URL=postgres://other\n');
  writeFileSync(join(appDir, 'src/db.js'), "import mongoose from 'mongoose';\nawait mongoose.connect(process.env.MONGO_DB_LINK);\n");
  let r = detectMongo(appDir, {});
  assert.equal(r.uri, 'mongodb://u:p@db.internal:27017/shop');
  assert.match(r.source, /MONGO_DB_LINK \(used by your code\)/);
  const prismaDir = join(dir, 'prisma-app'); mkdirSync(join(prismaDir, 'prisma'), { recursive: true });
  writeFileSync(join(prismaDir, 'prisma/schema.prisma'), 'datasource db {\n  provider = "mongodb"\n  url = env("MONGO_URL")\n}\n');
  r = detectMongo(prismaDir, { MONGO_URL: 'mongodb+srv://a:b@cluster0.example.net/app' });
  assert.match(r.source, /prisma\/schema\.prisma/);
  const out = await new Promise((res) => execFile(process.execPath, [join(here, '../recoverkit-connector.mjs'), 'detect', appDir], { env: { PATH: process.env.PATH } }, (_e, o) => res(o)));
  assert.match(out, /mongodb:\/\/\*\*\*@db\.internal/, 'credentials hidden');
});

test('schema change stops the sync, and a revoked key is refused', async () => {
  await admin.db('vtu').collection('transactions').updateMany({}, { $rename: { reference: 'ref' } });
  let r = await run('sync');
  assert.equal(r.ok, false);
  assert.match(r.out, /changed since setup/);
  await admin.db('vtu').collection('transactions').updateMany({}, { $rename: { ref: 'reference' } });
  app.projects.revokeSecretKey(project.id, project.secretKey.split('_').slice(2, 4).join('_'));
  r = await run('sync');
  assert.equal(r.ok, false);
  assert.match(r.out, /secret key was rejected/);
  project.secretKey = app.projects.createSecretKey(project.id, 'connector');
});

test('setup refuses to run unattended without --yes', async () => {
  const d = join(dir, 'tty'); mkdirSync(d);
  const r = await run('setup', {}, { dir: d, yes: false });
  assert.equal(r.ok, false);
  assert.match(r.out, /run it in a terminal, or pass --yes/);
  assert.ok(!existsSync(join(d, 'recoverkit-connector.json')));
});

test('orders stored INSIDE each user document (embedded lists) are read, keyed by their own _id', async () => {
  const db = admin.db('mall');
  const now = Date.now();
  const at = (d) => new Date(now - d * DAY);
  const g1 = new ObjectId(); const g2 = new ObjectId();
  await db.collection('users').insertMany([
    { email: 'gbenga@mall.ng', phone: '08037770001', createdAt: at(200), orders: [
      { _id: g1, item: 'gas refill', total: 9000, status: 'paid', createdAt: at(60) },
      { _id: g2, item: 'gas refill', total: 9000, status: 'failed', createdAt: at(59) },
      'not-a-document',
    ], walletTopups: [{ amount: 5000, status: 'success', createdAt: at(61) }] },
    { email: 'hauwa@mall.ng', createdAt: at(30), orders: [], walletTopups: [{ amount: 2000, status: 'success', createdAt: at(10) }] },
    { email: 'ife@mall.ng', createdAt: at(3), orders: [{ item: 'cylinder', total: 25000, status: 'paid', createdAt: at(2) }] },
  ]);
  await admin.db('vtu').command({ grantRolesToUser: 'reader', roles: [{ role: 'read', db: 'mall' }] });
  const uri = roUri.replace('/vtu?', '/mall?');
  const d = join(dir, 'mall'); mkdirSync(d);
  let r = await run('setup', { MONGODB_URI: uri }, { dir: d, ai: false });
  assert.ok(r.ok, r.out);
  assert.match(r.out, /A SALE is:   an item in `users\.orders` \(a list inside each document\) where status is paid, amount `total`.* · buyer: the user it belongs to/);
  assert.match(r.out, /Not a sale:  `users\.walletTopups` where status is success → deposit/);
  assert.match(r.out, /3 people · 2 have bought \(2 sales\) · 1 never bought/);
  r = await run('sync', { MONGODB_URI: uri }, { dir: d });
  assert.ok(r.ok, r.out);
  const amounts = (email) => app.db.all('SELECT amount FROM purchases WHERE person_id = ?', personOf({ email })).map((x) => x.amount);
  assert.deepEqual(amounts('gbenga@mall.ng'), [9000], 'paid order read; failed order and the non-document item ignored');
  assert.deepEqual(amounts('ife@mall.ng'), [25000], 'an embedded order without its own _id still counts');
  const stage = Object.fromEntries(app.engine.leads(project.id, { minConfidence: 0 }).map((l) => [l.personId, l.stage]));
  assert.equal(stage[personOf({ email: 'hauwa@mall.ng' })], 'funded_not_bought', 'embedded wallet top-up, never bought');
  assert.equal(stage[personOf({ email: 'gbenga@mall.ng' })], 'bought_once');
  // Adding a new embedded order: picked up once, older ones not duplicated.
  await db.collection('users').updateOne({ email: 'gbenga@mall.ng' }, { $push: { orders: { $each: [{ _id: new ObjectId(), item: 'gas refill', total: 9000, status: 'paid', createdAt: new Date(now - 60e3) }], $position: 0 } } });
  r = await run('sync', { MONGODB_URI: uri }, { dir: d });
  assert.ok(r.ok, r.out);
  assert.deepEqual(amounts('gbenga@mall.ng').sort(), [9000, 9000], 'new order added at the front of the list: no duplicates of the old one');
});
