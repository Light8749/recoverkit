#!/usr/bin/env node
// RecoverKit Connector for MongoDB apps: a read-only helper that runs on YOUR server.
//
// It reads your MongoDB where it lives (nothing is exported), works out who signed up,
// who bought and who went quiet, hashes emails and phones on this machine, and sends
// RecoverKit only hashes, event types, dates and amounts. It only calls out.
//
//   npx recoverkit-connector setup  --app=/path/to/your/app    look at collections, map, dry run, save
//   npx recoverkit-connector sync   --app=/path/to/your/app    history first, then only what's new (cron)
//   npx recoverkit-connector status | detect /path/to/app
//
// Settings: RK_PUBLIC_KEY, RK_SECRET_KEY, RK_ENDPOINT, and MONGODB_URI (or found in your app's .env,
// Prisma schema, or the variable your code passes to mongoose.connect / MongoClient). RK_MONGO_DB picks
// the database when the URI has none. Use a login with only the "read" role.
import { MongoClient, ObjectId } from 'mongodb';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { identityHashes } from './lib/identity.js'; // copy of sdk/core/identity.js (npm run copy-core)

export const VERSION = '1.0.0';
const BATCH = 400;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,4}$/; // no "$": no operator injection
const COLL_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,119}$/;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const KINDS = ['deposit', 'checkout', 'login', 'custom'];

// ------------------------------------------------------------------ finding the database

export function readDotenv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2];
    const q = /^"(.*)"$/s.exec(v) || /^'(.*)'$/s.exec(v);
    v = q ? q[1] : v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** The env var a Node app passes to mongoose.connect / new MongoClient, found by reading its code. */
function envNameFromCode(root) {
  const re = /(?:mongoose\.connect|createConnection|new\s+MongoClient|MongoClient\.connect)\(\s*process\.env\.([A-Z0-9_]+)/;
  let seen = 0;
  const walk = (d, depth) => {
    if (depth > 4 || seen > 800) return null;
    let entries = [];
    try { entries = readdirSync(d); } catch { return null; }
    for (const f of entries) {
      if (f === 'node_modules' || f.startsWith('.') || f === 'dist' || f === 'build') continue;
      const p = join(d, f);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { const r = walk(p, depth + 1); if (r) return r; continue; }
      if (!['.js', '.mjs', '.cjs', '.ts'].includes(extname(f)) || st.size > 500_000) continue;
      seen++;
      const m = re.exec(readFileSync(p, 'utf8'));
      if (m) return m[1];
    }
    return null;
  };
  return walk(root, 0);
}

export function detectMongo(root, env = process.env) {
  const vars = { ...readDotenv(join(root, '.env')), ...env };
  const tryVar = (name, source) => {
    const v = vars[name];
    if (typeof v === 'string' && /^mongodb(\+srv)?:\/\//.test(v)) return { uri: v, source };
    return null;
  };
  const fromCode = envNameFromCode(root);
  if (fromCode && tryVar(fromCode, `${fromCode} (used by your code)`)) return tryVar(fromCode, `${fromCode} (used by your code)`);
  const prisma = join(root, 'prisma/schema.prisma');
  if (existsSync(prisma)) {
    const src = readFileSync(prisma, 'utf8');
    const m = /provider\s*=\s*"mongodb"[\s\S]*?url\s*=\s*env\("([A-Za-z0-9_]+)"\)/.exec(src);
    if (m && tryVar(m[1], `prisma/schema.prisma (${m[1]})`)) return tryVar(m[1], `prisma/schema.prisma (${m[1]})`);
  }
  for (const n of ['MONGODB_URI', 'MONGO_URI', 'MONGO_URL', 'MONGODB_URL', 'DATABASE_URL', 'DB_URI', 'DB_URL']) {
    const r = tryVar(n, n);
    if (r) return r;
  }
  return { error: 'could not find a MongoDB connection string (mongodb://...). Set MONGODB_URI.' };
}

const hideCreds = (uri) => uri.replace(/\/\/([^@/]+)@/, '//***@');

// ------------------------------------------------------------------ helpers

export function getPath(doc, path) {
  let cur = doc;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

const typeOf = (v) => (v instanceof ObjectId ? 'objectId' : v instanceof Date ? 'date' : v?._bsontype === 'Decimal128' ? 'decimal' : Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/** Field paths seen in sample documents (names and types only), plus the fields of arrays of sub-documents. */
function fieldsOf(docs) {
  const columns = flatFields(docs);
  const arrays = {};
  for (const c of columns) {
    if (c.type !== 'array' || c.name.includes('.')) continue;
    const elems = docs.flatMap((d) => (Array.isArray(d[c.name]) ? d[c.name].slice(0, 20) : [])).filter((e) => e && typeof e === 'object' && !Array.isArray(e) && !(e instanceof ObjectId) && !(e instanceof Date));
    if (elems.length) arrays[c.name] = flatFields(elems.slice(0, 100));
  }
  return { columns, arrays };
}

function flatFields(docs) {
  const seen = new Map();
  const walk = (o, prefix, depth) => {
    for (const [k, v] of Object.entries(o)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) continue;
      const p = prefix ? `${prefix}.${k}` : k;
      const t = typeOf(v);
      if (t === 'object' && depth < 2) { walk(v, p, depth + 1); continue; }
      if (!seen.has(p)) seen.set(p, t);
    }
  };
  for (const d of docs) walk(d, '', 0);
  return [...seen].slice(0, 150).map(([name, type]) => ({ name, type }));
}

export function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (v instanceof ObjectId) return v.getTimestamp().getTime();
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') { const t = /^\d{9,13}$/.test(v) ? (Number(v) < 1e12 ? Number(v) * 1000 : Number(v)) : Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

function toMinor(v, unit) {
  let n = v;
  if (v?._bsontype === 'Decimal128' || (typeof v === 'object' && v !== null && typeof v.toString === 'function' && !(v instanceof Date))) n = Number(v.toString());
  n = Number(n);
  if (!Number.isFinite(n) || n < 0 || n > 1e13) return null;
  return Math.round(unit === 'major' ? n * 100 : n);
}

/** Filter values are plain strings in the mapping; match the same value stored as a number or boolean too. */
const variants = (vals) => vals.flatMap((v) => [v, ...(v === 'true' ? [true] : v === 'false' ? [false] : /^-?\d+(\.\d+)?$/.test(v) ? [Number(v)] : [])]);

// ------------------------------------------------------------------ mapping

const SUCCESS = /^(success|successful|succeeded|completed?|paid|delivered|approved|done|fulfilled|confirmed|active|won|settled|captured)$/i;
const pick = (fields, patterns) => { for (const p of patterns) { const f = fields.find((x) => p.test(x.name)); if (f) return f.name; } return ''; };

export function guessMapping(colls) {
  const mapping = { people: { table: '', id: '_id', email: '', phone: '', firstName: '', createdAt: '' }, conversions: [], signals: [], notes: 'Built-in guess from collection and field names. Check it carefully.' };
  let best = null; let score = -1;
  for (const c of colls) {
    let sc = /^(users?|customers?|members?|accounts?|clients?|profiles?)$/i.test(c.name) ? 3 : 0;
    if (pick(c.columns, [/(^|\.)e-?mail$/i])) sc += 2;
    if (pick(c.columns, [/(^|\.)(phone|mobile|msisdn|phoneNumber|phone_number)$/i])) sc += 1;
    if (sc > score && sc >= 2) { score = sc; best = c; }
  }
  if (!best) return mapping;
  mapping.people = {
    table: best.name, id: '_id',
    email: pick(best.columns, [/^e-?mail$/i, /(^|\.)e-?mail$/i]),
    phone: pick(best.columns, [/^(phone|mobile|msisdn|phoneNumber|phone_number)$/i, /(^|\.)(phone|mobile|phoneNumber)$/i]),
    firstName: pick(best.columns, [/^(firstName|first_name|fname)$/i, /(^|\.)(firstName|first_name)$/i, /^(name|fullName|full_name|username)$/i]),
    createdAt: pick(best.columns.filter((f) => ['date', 'string', 'number'].includes(f.type)), [/^(createdAt|created_at|dateJoined|registeredAt|signupDate|created)$/i]),
  };
  // Orders (or wallet top-ups) stored as a list inside each user document.
  for (const [arr, fields] of Object.entries(best.arrays || {})) {
    const amount = pick(fields.filter((f) => ['number', 'decimal', 'string'].includes(f.type)), [/^(amount|total|totalAmount|amountPaid|price|grandTotal|value)$/i, /(amount|total|price)$/i]);
    if (!amount) continue;
    const status = pick(fields, [/^(status|state|paymentStatus)$/i]);
    const ok = status ? ((best.arrayValues || {})[arr]?.[status] || []).filter((v) => SUCCESS.test(v)) : [];
    const base = { name: `${best.name}.${arr}`, table: best.name, arrayField: arr, key: fields.some((f) => f.name === '_id') ? '_id' : '', userColumn: '', emailColumn: '', phoneColumn: '',
      timeColumn: pick(fields.filter((f) => ['date', 'string', 'number'].includes(f.type)), [/^(paidAt|completedAt|createdAt|created_at|date|timestamp)$/i, /(At|_at|Date|date)$/]),
      amountColumn: amount, amountUnit: fields.find((f) => f.name === amount)?.type === 'decimal' ? 'major' : 'minor', filters: ok.length ? [{ column: status, values: ok }] : [] };
    if (/deposit|fund|top_?up|wallet|credit/i.test(arr)) mapping.signals.push({ ...base, kind: 'deposit' });
    else if (/^(orders|purchases|transactions|payments|subscriptions|bookings|sales|bets|recharges)$/i.test(arr)) mapping.conversions.push({ ...base, refColumn: pick(fields, [/^(reference|ref|paymentReference|txRef|orderNumber)$/i]) });
  }
  for (const c of colls) {
    if (c.name === best.name || /(_stats|_lookup|_logs?|_history|_audit|sessions?)$/i.test(c.name)) continue;
    const user = pick(c.columns, [/^(userId|user_id|customerId|customer_id|memberId|accountId|ownerId|buyerId)$/i, /^(user|customer|owner|buyer|member|account)$/i, /(^|\.)(userId|customerId)$/i]);
    const email = pick(c.columns, [/^(email|customerEmail|billingEmail|buyerEmail)$/i, /^(billing|customer|buyer)\.e-?mail$/i]);
    if (!user && !email) continue;
    const time = pick(c.columns.filter((f) => ['date', 'string', 'number'].includes(f.type)), [/^(paidAt|completedAt|createdAt|created_at|date|timestamp|transactionDate)$/i, /(At|_at|Date|date)$/]);
    const amount = pick(c.columns.filter((f) => ['number', 'decimal', 'string'].includes(f.type)), [/^(amount|total|totalAmount|amountPaid|price|grandTotal|value)$/i, /(amount|total|price)$/i]);
    const status = pick(c.columns, [/^(status|state|paymentStatus|payment_status|transactionStatus)$/i]);
    const ok = status ? (c.values[status] || []).filter((v) => SUCCESS.test(v)) : [];
    const base = { name: c.name.toLowerCase(), table: c.name, key: '_id', userColumn: user, emailColumn: email, phoneColumn: '', timeColumn: time, amountColumn: amount,
      amountUnit: c.columns.find((f) => f.name === amount)?.type === 'decimal' ? 'major' : 'minor', filters: ok.length ? [{ column: status, values: ok }] : [] };
    if (/wallet|fund|deposit|top_?up|credit/i.test(c.name)) mapping.signals.push({ ...base, kind: 'deposit' });
    else if (/cart|checkout|pending|basket/i.test(c.name)) mapping.signals.push({ ...base, kind: 'checkout' });
    else if (amount && /order|transaction|purchase|sale|bill|subscription|recharge|bet|payment|invoice|booking/i.test(c.name)) mapping.conversions.push({ ...base, refColumn: pick(c.columns, [/^(reference|ref|paymentReference|txRef|tx_ref|transactionRef|orderNumber)$/i]) });
  }
  return mapping;
}

/** Keep only collections and fields that exist. colls = null gives the expected shape without checking. */
export function checkMapping(m, colls) {
  const by = new Map((colls || []).map((c) => [c.name, new Set(c.columns.map((f) => f.name).concat('_id'))]));
  const arrBy = new Map((colls || []).map((c) => [c.name, Object.fromEntries(Object.entries(c.arrays || {}).map(([a, fs]) => [a, new Set(fs.map((f) => f.name))]))]));
  const collOk = (t) => typeof t === 'string' && COLL_RE.test(t) && (colls === null || by.has(t));
  const has = (t, f) => (typeof f === 'string' && f !== '' && PATH_RE.test(f) && (colls === null || by.get(t)?.has(f)) ? f : '');
  const pt = collOk(m?.people?.table) ? m.people.table : '';
  const people = { table: pt, ...Object.fromEntries(['id', 'email', 'phone', 'firstName', 'createdAt'].map((k) => [k, has(pt, m?.people?.[k])])) };
  if (!people.id && pt) people.id = '_id';
  const src = (s, isSignal) => {
    if (!collOk(s?.table)) return null;
    // arrayField: each element of this list (inside every document) is one record; fields refer to the element.
    const arrayField = typeof s.arrayField === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s.arrayField) && (colls === null || arrBy.get(s.table)?.[s.arrayField]) ? s.arrayField : '';
    if (s.arrayField && !arrayField) return null;
    const f = arrayField
      ? (x) => (typeof x === 'string' && x !== '' && PATH_RE.test(x) && (colls === null || arrBy.get(s.table)[arrayField].has(x)) ? x : '')
      : (x) => has(s.table, x);
    const o = {
      name: /^[A-Za-z0-9_.:/-]{1,64}$/.test(s.name || '') ? s.name : s.table.toLowerCase(), table: s.table, arrayField,
      key: f(s.key) || (arrayField ? '' : '_id'),
      userColumn: f(s.userColumn), emailColumn: f(s.emailColumn), phoneColumn: f(s.phoneColumn),
      timeColumn: f(s.timeColumn), amountColumn: f(s.amountColumn), amountUnit: s.amountUnit === 'major' ? 'major' : 'minor',
      filters: (Array.isArray(s.filters) ? s.filters : []).slice(0, 3).map((x) => ({ column: f(x?.column), values: (Array.isArray(x?.values) ? x.values : []).filter((v) => typeof v === 'string' && v.length <= 64).slice(0, 20) })).filter((x) => x.column && x.values.length),
    };
    // The buyer: an account reference, the email/phone on the record, or (embedded lists in the people collection) the parent document.
    const parentIsBuyer = arrayField && s.table === pt;
    if (!o.userColumn && !o.emailColumn && !o.phoneColumn && !parentIsBuyer) return null;
    if (isSignal) o.kind = KINDS.includes(s.kind) ? s.kind : 'custom';
    else { if (!o.amountColumn) return null; o.refColumn = f(s.refColumn); }
    return o;
  };
  return {
    people,
    conversions: (Array.isArray(m?.conversions) ? m.conversions : []).slice(0, 5).map((s) => src(s, false)).filter(Boolean),
    signals: (Array.isArray(m?.signals) ? m.signals : []).slice(0, 10).map((s) => src(s, true)).filter(Boolean),
    notes: typeof m?.notes === 'string' ? m.notes.slice(0, 500) : '',
  };
}

// ------------------------------------------------------------------ the connector

export class Connector {
  constructor({ env = process.env, dir = process.cwd(), assumeYes = false, out = (s) => process.stdout.write(s + '\n'), fetchFn = globalThis.fetch } = {}) {
    this.env = env; this.dir = dir; this.yes = assumeYes; this.say = out; this.fetch = fetchFn; this.client = null; this.db = null;
  }

  need(k) { const v = this.env[k]; if (!v) throw new Error(`${k} is not set`); return v; }
  path(f) { return join(this.dir, f); }
  endpoint() { return String(this.env.RK_ENDPOINT || 'https://api.recoverkit.app').replace(/\/+$/, ''); }
  hashes(user) { return identityHashes(this.need('RK_PUBLIC_KEY'), user); }

  log(op, coll, detail, rows) {
    appendFileSync(this.path('recoverkit-connector.log'), `${new Date().toISOString()} rows=${rows} ${op} ${coll} ${JSON.stringify(detail, (k, v) => (Array.isArray(v) && v.length > 10 ? `(${v.length} ids)` : typeof v === 'string' && (v.includes('@') || v.length > 40) ? '(hidden)' : v))}\n`);
  }

  async ask(q, def = true) {
    if (this.yes) { this.say(`${q} ${def ? '[Y/n] y' : '[y/N] n'} (--yes)`); return def; }
    if (!process.stdin.isTTY) throw new Error('setup asks questions: run it in a terminal, or pass --yes to accept the suggested answers');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`${q} ${def ? '[Y/n] ' : '[y/N] '}`)).trim().toLowerCase();
    rl.close();
    return a === '' ? def : ['y', 'yes'].includes(a);
  }

  async connect() {
    if (this.db) return;
    const uri = this.need('MONGODB_URI');
    this.client = new MongoClient(uri, { appName: `recoverkit-connector/${VERSION}`, serverSelectionTimeoutMS: 10_000, readPreference: 'primaryPreferred' });
    await this.client.connect();
    const name = this.env.RK_MONGO_DB || (() => { try { return decodeURIComponent(new URL(uri.replace(/^mongodb\+srv:/, 'mongodb:')).pathname.slice(1)); } catch { return ''; } })();
    if (!name) throw new Error('the connection string has no database name: add it (…/mydb) or set RK_MONGO_DB');
    this.db = this.client.db(name);
  }

  async close() { if (this.client) await this.client.close(); }

  /** Only reads ever run. Aggregations are built here and can never contain $out or $merge. */
  async aggregate(coll, pipeline) {
    if (JSON.stringify(pipeline).match(/"\$(out|merge)"/)) throw new Error('refusing a writing pipeline');
    const rows = await this.db.collection(coll).aggregate(pipeline, { allowDiskUse: false }).toArray();
    this.log('aggregate', coll, pipeline.map((st) => Object.keys(st)[0]), rows.length);
    return rows;
  }

  async checkReadOnly() {
    let st;
    try { st = await this.db.command({ connectionStatus: 1, showPrivileges: true }); } catch { this.say("? Couldn't check this login's permissions."); return; }
    const users = st.authInfo?.authenticatedUsers || [];
    const writes = (st.authInfo?.authenticatedUserPrivileges || []).some((p) => (p.actions || []).some((a) => ['insert', 'update', 'remove', 'dropCollection', 'dropDatabase', 'createCollection'].includes(a)));
    if (users.length && !writes) { this.say('✓ This login can only read.'); return; }
    this.say(users.length ? '⚠ This MongoDB login can also WRITE. The connector itself only reads, but for safety create a read-only login and use that:'
      : '⚠ This MongoDB server has no login at all (anyone who can reach it can write). Turn on authentication, then use a read-only login:');
    this.say(`    use ${this.db.databaseName}`);
    this.say(`    db.createUser({ user: "recoverkit", pwd: "<a long random password>", roles: [{ role: "read", db: "${this.db.databaseName}" }] })`);
  }

  /** Collection and field NAMES, counts, and short status labels. Never document data. */
  async scan() {
    const out = [];
    const list = await this.db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray();
    for (const { name } of list) {
      if (name.startsWith('system.') || !COLL_RE.test(name)) continue;
      const coll = this.db.collection(name);
      const rows = await coll.estimatedDocumentCount();
      const sample = await this.aggregate(name, [{ $sample: { size: 50 } }]);
      const { columns, arrays } = fieldsOf(sample);
      const arrayValues = {};
      for (const [arr, fields] of Object.entries(arrays)) {
        for (const f of fields) {
          if (!/(status|state|type|kind)$/i.test(f.name) || f.type !== 'string') continue;
          const vals = await this.aggregate(name, [{ $unwind: `$${arr}` }, { $group: { _id: `$${arr}.${f.name}` } }, { $limit: 26 }]);
          if (vals.length > 25) continue;
          const clean = vals.map((v) => v._id).filter((x) => typeof x === 'string' && /^[A-Za-z0-9 _.-]{1,32}$/.test(x) && !/@|\d{7,}/.test(x));
          if (clean.length) (arrayValues[arr] ||= {})[f.name] = clean;
        }
      }
      const values = {};
      for (const f of columns) {
        if (!/(status|state|type|kind|category|service|product|network|channel|plan)$/i.test(f.name) || f.type !== 'string') continue;
        const vals = await this.aggregate(name, [{ $group: { _id: `$${f.name}` } }, { $limit: 26 }]);
        if (vals.length > 25) continue;
        const clean = vals.map((v) => v._id).filter((s) => typeof s === 'string' && /^[A-Za-z0-9 _.-]{1,32}$/.test(s) && !/@|\d{7,}/.test(s));
        if (clean.length) values[f.name] = clean;
      }
      out.push({ name, rows, columns, values, arrays, arrayValues });
    }
    return out;
  }

  async post(path, body, timeoutMs = 60_000) {
    const url = this.endpoint() + path;
    const u = new URL(url);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('RK_ENDPOINT must use https');
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.need('RK_SECRET_KEY')}`, 'User-Agent': `recoverkit-connector-node/${VERSION}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch (e) { return { error: `could not reach RecoverKit: ${e.message}` }; }
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) return { error: 'the secret key was rejected (revoked or wrong)' };
    if (!res.ok) return { error: `HTTP ${res.status}: ${json.error || 'request failed'}` };
    return json;
  }

  describe(m) {
    const p = m.people;
    this.say(`  People:      collection \`${p.table}\` (email \`${p.email || '—'}\`, phone \`${p.phone || '—'}\`, signed up \`${p.createdAt || 'from _id'}\`)`);
    const f = (s) => (s.filters.length ? ` where ${s.filters.map((x) => `${x.column} is ${x.values.join('/')}`).join(' and ')}` : ' (every document)');
    const who = (s) => ` · buyer: ${[s.userColumn && `account \`${s.userColumn}\``, !s.userColumn && s.arrayField && 'the user it belongs to', (s.emailColumn || s.phoneColumn) && `guest \`${[s.emailColumn, s.phoneColumn].filter(Boolean).join('` `')}\``].filter(Boolean).join(' or ')}`;
    const where = (s) => (s.arrayField ? `an item in \`${s.table}.${s.arrayField}\` (a list inside each document)` : `a document in \`${s.table}\``);
    for (const s of m.conversions) this.say(`  A SALE is:   ${where(s)}${f(s)}, amount \`${s.amountColumn}\` in ${s.amountUnit === 'major' ? 'naira' : 'kobo'}${who(s)}`);
    if (!m.conversions.length) this.say('  A SALE is:   (nothing found — sales will only come from webhooks or trackPurchase)');
    for (const s of m.signals) this.say(`  Not a sale:  \`${s.table}${s.arrayField ? '.' + s.arrayField : ''}\`${f(s)} → ${s.kind}`);
    if (m.notes) this.say(`  Note: ${m.notes}`);
  }

  /** For embedded lists: one document per element, with the parent's _id and the element's position. */
  unwind(s) {
    if (!s.arrayField) return [];
    const a = s.arrayField;
    return [{ $unwind: { path: `$${a}`, includeArrayIndex: '__idx' } }, { $match: { [a]: { $type: 'object' } } },
      { $replaceRoot: { newRoot: { $mergeObjects: [`$${a}`, { __parent: '$_id', __idx: '$__idx' }] } } }];
  }

  async *readSource(s, filter, projection) {
    if (!s.arrayField) {
      yield* this.db.collection(s.table).find(filter, { projection }).batchSize(500);
      return;
    }
    const pipeline = [...this.unwind(s), { $match: filter }, { $project: { ...projection, __parent: 1, __idx: 1 } }];
    if (JSON.stringify(pipeline).match(/"\$(out|merge)"/)) throw new Error('refusing a writing pipeline');
    yield* this.db.collection(s.table).aggregate(pipeline).batchSize(500);
  }

  matchFor(s) {
    const and = s.filters.map((f) => ({ [f.column]: { $in: variants(f.values) } }));
    return and.length ? { $and: and } : {};
  }

  async dryRun(m) {
    const out = { people: await this.db.collection(m.people.table).countDocuments({}), buyers: 0, guests: 0, sales: 0, signals: {} };
    for (const s of m.conversions) {
      const buyer = s.userColumn ? `$${s.userColumn}` : s.arrayField ? '$__parent' : null;
      const [r] = await this.aggregate(s.table, [...this.unwind(s), { $match: this.matchFor(s) }, { $group: { _id: null, n: { $sum: 1 },
        users: { $addToSet: buyer },
        guests: { $addToSet: { $cond: [{ $ifNull: [buyer, false] }, null, s.emailColumn ? `$${s.emailColumn}` : s.phoneColumn ? `$${s.phoneColumn}` : null] } } } }]);
      if (!r) continue;
      out.sales += r.n;
      out.buyers = Math.max(out.buyers, r.users.filter((x) => x !== null && x !== undefined && x !== '').length);
      out.guests += r.guests.filter((x) => x !== null && x !== undefined && x !== '').length;
    }
    for (const s of m.signals) {
      const [r] = await this.aggregate(s.table, [...this.unwind(s), { $match: this.matchFor(s) }, { $group: { _id: null, who: { $addToSet: s.userColumn || s.emailColumn || s.phoneColumn ? `$${s.userColumn || s.emailColumn || s.phoneColumn}` : '$__parent' } } }]);
      out.signals[s.name] = r ? r.who.filter((x) => x != null && x !== '').length : 0;
    }
    return out;
  }

  async setup({ useAi = true } = {}) {
    this.say(`RecoverKit Connector (MongoDB) ${VERSION} — setup`);
    this.need('RK_PUBLIC_KEY'); this.need('RK_SECRET_KEY');
    await this.connect();
    this.say('Looking at your collection and field names (not your data)...');
    const colls = await this.scan();
    if (!colls.length) throw new Error('no collections found');
    this.say(`Found ${colls.length} collections.`);
    await this.checkReadOnly();
    let mapping = null;
    if (useAi && await this.ask('Ask your AI model to suggest the mapping? It will see collection names, field names and status values like "paid", never customer data.')) {
      this.say('Asking...');
      const res = await this.post('/v1/connector/suggest', { schema: { dialect: 'mongodb', tables: colls.map((c) => ({ name: c.name, rows: c.rows, columns: c.columns.map((f) => ({ name: f.name, type: f.type })), values: c.values })) } }, 90_000);
      if (res.mapping) mapping = checkMapping({ ...res.mapping, people: { ...res.mapping.people, id: res.mapping.people?.id || '_id' } }, colls);
      else this.say(`  ${res.reason || res.error || 'No AI suggestion.'}`);
    }
    const guessed = checkMapping(guessMapping(colls), colls);
    if (!mapping?.people.table) mapping = guessed;
    else {
      // The AI only sees top-level fields; add embedded lists the built-in guesses found.
      for (const k of ['conversions', 'signals']) for (const g of guessed[k]) if (g.arrayField && !mapping[k].some((x) => x.table === g.table && x.arrayField === g.arrayField)) mapping[k].push(g);
    }
    if (!mapping.people.table || (!mapping.people.email && !mapping.people.phone)) throw new Error('could not find a users collection with an email or phone field. Edit recoverkit-connector.json by hand.');
    this.say(''); this.say('Here is what I understood:'); this.describe(mapping);
    const d = await this.dryRun(mapping);
    this.say(''); this.say('Dry run (counted on your server, nothing sent):');
    this.say(`  ${d.people} people · ${d.buyers} have bought (${d.sales} sales) · ${Math.max(0, d.people - d.buyers)} never bought`);
    if (d.guests) this.say(`  + ${d.guests} guest buyers who checked out without an account`);
    for (const [n, c] of Object.entries(d.signals)) this.say(`  ${c} people with ${n}`);
    if (!await this.ask('Does that look right?')) throw new Error('not saved. Edit recoverkit-connector.json by hand, or run setup again.');
    const share = await this.ask('Let RecoverKit keep encrypted email/phone/first name so it can send follow-ups for you? (No = only hashes leave this server.)', false);
    writeFileSync(this.path('recoverkit-connector.json'), JSON.stringify({ version: 1, database: 'mongodb', mapping, shareContact: share, historyDays: Number(this.env.RK_HISTORY_DAYS || 730), savedAt: new Date().toISOString() }, null, 2) + '\n');
    try { chmodSync(this.path('recoverkit-connector.json'), 0o640); } catch { /* windows */ }
    this.say(''); this.say('Saved recoverkit-connector.json. Next: npx recoverkit-connector sync (and add it to cron every 15 minutes).');
  }

  loadConfig() {
    const f = this.path('recoverkit-connector.json');
    if (!existsSync(f)) throw new Error('no recoverkit-connector.json yet. Run: npx recoverkit-connector setup');
    const c = JSON.parse(readFileSync(f, 'utf8'));
    if (!c?.mapping) throw new Error('recoverkit-connector.json is not valid');
    return c;
  }

  /** A $gte filter on the time field, in the same type the documents use. */
  async since(coll, field, ms, s = null) {
    if (!field) return s?.arrayField ? {} : { _id: { $gte: ObjectId.createFromTime(Math.floor(Math.max(0, ms) / 1000)) } };
    const [latest] = s?.arrayField
      ? await this.aggregate(coll, [...this.unwind(s), { $match: { [field]: { $exists: true } } }, { $project: { [field]: 1 } }, { $limit: 1 }])
      : await this.db.collection(coll).find({ [field]: { $exists: true } }, { projection: { [field]: 1 } }).limit(1).toArray();
    const v = latest ? getPath(latest, field) : undefined;
    if (v instanceof Date) return { [field]: { $gte: new Date(ms) } };
    if (typeof v === 'number') return { [field]: { $gte: v >= 1e12 ? ms : Math.floor(ms / 1000) } };
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return { [field]: { $gte: new Date(ms).toISOString().slice(0, 19) } };
    return {}; // unknown format: read everything; re-sending is harmless (every record has a stable key)
  }

  async sync() {
    const config = this.loadConfig();
    await this.connect();
    const colls = await this.scan();
    const m = checkMapping(config.mapping, colls);
    if (JSON.stringify(m) !== JSON.stringify(checkMapping(config.mapping, null))) throw new Error('your collections or fields changed since setup (something in the mapping is gone). Run setup again. Nothing was sent.');
    const stateFile = this.path('.recoverkit-connector-state.json');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
    const now = Date.now();
    const sinceMs = (k) => (state[k] ? state[k] - 864e5 : now - 864e5 * Number(config.historyDays || 730));
    const share = config.shareContact === true;
    const p = m.people;
    const cache = new Map();
    const totals = { people: 0, events: 0, newEvents: 0 };
    const next = { ...state };
    let buffer = { people: [], events: [] };
    const flush = async (final = false) => {
      if (!final && buffer.people.length + buffer.events.length < BATCH) return;
      const body = { ...buffer, shareContact: share, source: 'node-connector', version: VERSION, ...(final ? { final: true, totals } : {}) };
      const res = await this.post('/v1/connector/sync', body);
      if (!res.ok) throw new Error(`sync failed: ${res.error || 'unknown error'}. The next run will retry.`);
      totals.newEvents += res.newEvents || 0;
      buffer = { people: [], events: [] };
    };
    const personIds = (doc) => this.hashes({ email: p.email ? getPath(doc, p.email) : null, phone: p.phone ? getPath(doc, p.phone) : null });
    const proj = Object.fromEntries([p.email, p.phone, p.firstName, p.createdAt].filter(Boolean).map((f) => [f, 1]));

    // 1. People.
    const pFilter = state.people ? await this.since(p.table, p.createdAt, sinceMs('people')) : {};
    const pCursor = this.db.collection(p.table).find(pFilter, { projection: proj }).sort({ _id: 1 });
    let pRows = 0;
    for await (const doc of pCursor) {
      pRows++;
      const ids = personIds(doc);
      cache.set(String(doc._id), ids);
      if (!ids.length) continue;
      const created = toMs(p.createdAt ? getPath(doc, p.createdAt) : doc._id);
      const item = { ids, key: sha256(`person|${p.table}|${doc._id}`) };
      if (created && created <= now && created > now - 5 * 365 * 864e5) { item.createdAt = created; next.people = Math.max(next.people || 0, created); }
      if (share) item.contact = { email: p.email ? getPath(doc, p.email) ?? null : null, phone: p.phone ? getPath(doc, p.phone) ?? null : null, firstName: p.firstName ? getPath(doc, p.firstName) ?? null : null };
      buffer.people.push(item); totals.people++;
      await flush();
    }
    this.log('find', p.table, { filter: Object.keys(pFilter) }, pRows);
    next.people = next.people || now;

    const lookup = async (refs) => {
      const missing = [...new Set(refs.filter((r) => r != null && r !== '' && r !== 0 && !cache.has(String(r))).map(String))];
      for (let i = 0; i < missing.length; i += 500) {
        const chunk = missing.slice(i, i + 500);
        const ids = chunk.flatMap((r) => (/^[0-9a-f]{24}$/i.test(r) ? [new ObjectId(r), r] : /^\d+$/.test(r) ? [r, Number(r)] : [r]));
        const docs = await this.db.collection(p.table).find({ _id: { $in: ids } }, { projection: proj }).toArray();
        this.log('find', p.table, { _id: chunk }, docs.length);
        for (const d of docs) cache.set(String(d._id), personIds(d));
        for (const r of chunk) if (!cache.has(r)) cache.set(r, []);
      }
    };

    // 2. Sales and signals, oldest first.
    const sources = [...m.conversions.map((s) => ({ ...s, _kind: 'conversion' })), ...m.signals.map((s) => ({ ...s, _kind: 'signal' }))];
    for (const s of sources) {
      const ck = `${s._kind}:${s.name}:${s.table}`;
      const filter = { $and: [this.matchFor(s), await this.since(s.table, s.timeColumn, sinceMs(ck), s)] };
      const fields = [s.key, s.userColumn, s.emailColumn, s.phoneColumn, s.timeColumn, s.amountColumn, s.refColumn].filter(Boolean);
      // No sort: order doesn't matter (the cursor keeps the newest time seen), and sorting big collections can hit memory limits.
      const cursor = this.readSource(s, filter, Object.fromEntries(fields.map((f) => [f, 1])));
      let page = []; let rows = 0;
      const handle = async (docs) => {
        const buyerOf = (d) => (s.userColumn ? getPath(d, s.userColumn) : s.arrayField ? d.__parent : null);
        await lookup(docs.map(buyerOf));
        for (const d of docs) {
          const u = buyerOf(d);
          const own = this.hashes({ email: s.emailColumn ? getPath(d, s.emailColumn) : null, phone: s.phoneColumn ? getPath(d, s.phoneColumn) : null });
          const ids = [...new Set([...(u != null && u !== '' ? cache.get(String(u)) || [] : []), ...own])].slice(0, 4);
          const ts = toMs(s.timeColumn ? getPath(d, s.timeColumn) : s.arrayField ? (d._id instanceof ObjectId ? d._id : null) : d._id);
          if (!ids.length || !ts || ts < now - 5 * 365 * 864e5) continue;
          const amount = s.amountColumn ? toMinor(getPath(d, s.amountColumn), s.amountUnit) : null;
          if (s._kind === 'conversion' && amount === null) continue;
          // Embedded records are keyed by their own _id (Mongoose adds one) or, failing that, parent + position.
          const recKey = s.arrayField ? (s.key && getPath(d, s.key) != null ? `${d.__parent}|${getPath(d, s.key)}` : `${d.__parent}|#${d.__idx}`) : String(d._id);
          const ev = { kind: s._kind, name: s.name, ids, ts: Math.min(ts, now), amount, key: sha256(`${ck}|${recKey}`) };
          if (s._kind === 'signal') ev.signal = s.kind;
          const ref = s.refColumn ? getPath(d, s.refColumn) : undefined;
          if (typeof ref === 'string' && /^[\x21-\x7e]{1,128}$/.test(ref)) ev.ref = ref;
          buffer.events.push(ev); totals.events++;
          next[ck] = Math.max(next[ck] || 0, ev.ts);
          await flush();
        }
      };
      for await (const d of cursor) { rows++; page.push(d); if (page.length >= 500) { await handle(page); page = []; } }
      if (page.length) await handle(page);
      this.log('find', s.table, { filters: s.filters.map((f) => f.column) }, rows);
      next[ck] = next[ck] || now;
    }
    await flush(true);
    next.lastSyncAt = Date.now();
    writeFileSync(stateFile, JSON.stringify(next, null, 2) + '\n');
    this.say(`Synced: ${totals.people} people, ${totals.events} sales and signals checked, ${totals.newEvents} new.`);
  }

  status() {
    const c = this.loadConfig();
    this.say(`RecoverKit Connector (MongoDB) ${VERSION}`);
    this.describe(c.mapping);
    this.say(`Contact details shared: ${c.shareContact ? 'yes (encrypted at RecoverKit)' : 'no (hashes only)'}`);
    const st = existsSync(this.path('.recoverkit-connector-state.json')) ? JSON.parse(readFileSync(this.path('.recoverkit-connector-state.json'), 'utf8')) : null;
    this.say(`Last sync: ${st?.lastSyncAt ? new Date(st.lastSyncAt).toISOString() : 'never'}`);
  }
}

// ------------------------------------------------------------------ CLI
export async function main(argv = process.argv.slice(2), env = { ...process.env }) {
  const cmd = argv[0] || 'help';
  let dir = process.cwd();
  for (const a of argv) {
    if (a.startsWith('--app=')) {
      const root = resolve(a.slice(6));
      const dotenv = readDotenv(join(root, '.env'));
      for (const k of ['RK_PUBLIC_KEY', 'RK_SECRET_KEY', 'RK_ENDPOINT', 'RK_MONGO_DB', 'RK_HISTORY_DAYS']) if (!env[k] && dotenv[k]) env[k] = dotenv[k];
      if (!env.MONGODB_URI || !/^mongodb/.test(env.MONGODB_URI)) {
        const found = detectMongo(root, env);
        if (found.error) throw new Error(found.error);
        env.MONGODB_URI = found.uri;
        process.stdout.write(`Found your database in ${found.source}: ${hideCreds(found.uri)}\n`);
      }
      dir = root;
    }
    if (a.startsWith('--dir=')) dir = resolve(a.slice(6));
  }
  if (cmd === 'detect') {
    const r = detectMongo(resolve(argv[1] && !argv[1].startsWith('--') ? argv[1] : dir), env);
    process.stdout.write(JSON.stringify(r.uri ? { ...r, uri: hideCreds(r.uri) } : r, null, 2) + '\n');
    return;
  }
  const c = new Connector({ env, dir, assumeYes: argv.includes('--yes') });
  try {
    if (cmd === 'setup') await c.setup({ useAi: !argv.includes('--no-ai') });
    else if (cmd === 'sync') await c.sync();
    else if (cmd === 'status') c.status();
    else process.stdout.write('Usage: recoverkit-connector setup|sync|status [--app=/path/to/app] [--yes] [--no-ai]\n       recoverkit-connector detect /path/to/app\n');
  } finally { await c.close(); }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('recoverkit-connector.mjs') || process.argv[1]?.endsWith('/recoverkit-connector')) {
  main().catch((e) => { process.stderr.write(`Error: ${e.message}\n`); process.exit(1); });
}
