import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sha256 } from '../sdk/core/sha256.js';
import { normalizeEmail, normalizePhone, identityHashes } from '../sdk/core/identity.js';
import { createClient } from '../sdk/core/client.js';
import { deriveKeys, encrypt, decrypt, signToken, verifyToken, hashPassword, verifyPassword, safeEqual } from '../src/crypto.js';
import { sanitizePath, cleanBrowserEvent, cleanServerEvent } from '../src/validate.js';
import { checkDraft, templateDraft } from '../src/ai.js';
import { buildBrowserBundle } from '../scripts/build-browser.js';

const PK = 'rk_pub_' + 'a1'.repeat(12);

test('pure-JS sha256 matches node:crypto', () => {
  const inputs = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'ñandú 🇳🇬 ọmọ', 'x\u0000y'];
  for (let i = 0; i < 50; i++) inputs.push(randomBytes(i * 3).toString('base64'));
  for (const s of inputs) assert.equal(sha256(s), createHash('sha256').update(s, 'utf8').digest('hex'), s);
});

test('email and Nigerian phone normalisation', () => {
  assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('a b@c.com'), null);
  for (const p of ['08031234567', '+2348031234567', '2348031234567', '8031234567', '0803 123 4567', '+234 0803 123 4567', '002348031234567', '(0803) 123-4567']) {
    assert.equal(normalizePhone(p), '2348031234567', p);
  }
  assert.equal(normalizePhone('+447911123456'), '447911123456');
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone('080312345'), null);
});

test('identity hashes are project-scoped and never contain raw values', () => {
  const a = identityHashes(PK, { email: 'ada@example.com', phone: '08031234567' });
  const b = identityHashes('rk_pub_' + 'b2'.repeat(12), { email: 'ada@example.com' });
  assert.equal(a.length, 2);
  assert.notEqual(a[0], b[0]);
  assert.ok(a.every((h) => /^[0-9a-f]{64}$/.test(h)));
  assert.deepEqual(identityHashes(PK, { email: 'ADA@example.com ', phone: '+2348031234567' }), a);
});

test('PHP SDK produces identical hashes to the JS SDK', () => {
  const cases = [
    { email: 'Ada@Example.com', phone: '08031234567' }, { phone: '+234 0803 123 4567' }, { email: ' x.y+z@shop.ng ' },
    { phone: '8031234567' }, { phone: '002348031234567' }, { email: 'bad', phone: '12' }, { phone: '+447911123456' },
  ];
  const php = `require 'sdk/php/RecoverKit.php'; $rk = new RecoverKit('${PK}', 'rk_sec_x', 'http://localhost');
    $cases = json_decode($argv[1], true); $out = []; foreach ($cases as $c) { $out[] = $rk->hashes($c); } echo json_encode($out);`;
  const out = JSON.parse(execFileSync('php', ['-r', php, JSON.stringify(cases)], { encoding: 'utf8' }));
  assert.deepEqual(out, cases.map((c) => identityHashes(PK, c)));
});

test('AES-GCM encryption detects tampering', () => {
  const k = deriveKeys(randomBytes(32));
  const box = encrypt(k.enc, 'secret');
  assert.equal(decrypt(k.enc, box), 'secret');
  const parts = box.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decrypt(k.enc, parts.join('.')));
  assert.throws(() => decrypt(deriveKeys(randomBytes(32)).enc, box));
});

test('signed tokens reject tampering and expiry', () => {
  const k = deriveKeys(randomBytes(32));
  const t = signToken(k.sign, { p: 'prj', u: 'per' }, 60);
  assert.equal(verifyToken(k.sign, t).u, 'per');
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ p: 'prj', u: 'other', exp: 9e9 })).toString('base64url');
  assert.equal(verifyToken(k.sign, `${forged}.${sig}`), null);
  assert.equal(verifyToken(k.sign, signToken(k.sign, { p: 1 }, -1)), null);
  assert.equal(verifyToken(k.sign, body), null);
});

test('passwords and constant-time compare', () => {
  const h = hashPassword('correct horse battery');
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', 'garbage'));
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abcd'));
  assert.ok(!safeEqual('abc', undefined));
});

test('paths are reduced to templates; PII and ids removed', () => {
  assert.equal(sanitizePath('/orders/123456?email=a@b.com#x'), '/orders/:id');
  assert.equal(sanitizePath('/u/ada@example.com/profile'), '/u/:id/profile');
  assert.equal(sanitizePath('/reset/eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz'), '/reset/:id');
  assert.equal(sanitizePath('/pricing'), '/pricing');
  assert.equal(sanitizePath('/a/%3Cscript%3E'), '/a/:id');
});

test('browser events: allowlist only, cannot be a purchase, extra fields dropped', () => {
  const now = Date.now();
  assert.equal(cleanBrowserEvent({ type: 'purchase', amount: 100 }, now, 'NGN'), null);
  const e = cleanBrowserEvent({ type: 'form_submit', name: 'signup', value: 'ada@example.com', card: '4111' }, now, 'NGN');
  assert.deepEqual(Object.keys(e).sort(), ['amount', 'currency', 'layer', 'name', 'ts', 'type']);
  assert.equal(cleanBrowserEvent({ type: 'custom', name: '<img src=x>' }, now, 'NGN'), null);
  assert.equal(cleanBrowserEvent({ type: 'click', ts: now + 864e5 }, now, 'NGN').ts, now);
  assert.throws(() => cleanServerEvent({ type: 'purchase' }, now, 'NGN'), /amount/);
  assert.throws(() => cleanServerEvent({ type: 'purchase', amount: 1.5 }, now, 'NGN'), /integer/);
  assert.throws(() => cleanServerEvent({ type: 'refund', amount: 1 }, now, 'NGN'), /unknown event type/);
  assert.throws(() => cleanServerEvent({ type: 'purchase', amount: 1, ref: 'has space' }, now, 'NGN'), /ref/);
});

test('draft checker blocks links, numbers and stray placeholders', () => {
  assert.equal(checkDraft('Hi {first_name}, your order is waiting for you.', 'sms'), null);
  assert.match(checkDraft('Pay at https://evil.example now please', 'sms'), /link/);
  assert.match(checkDraft('Visit paystack-secure.com to finish', 'sms'), /link/);
  assert.match(checkDraft('Call us on 0803 123 4567 today ok', 'sms'), /phone/);
  assert.match(checkDraft('Hi {email}, come back and buy', 'sms'), /placeholder/);
  assert.match(checkDraft('x'.repeat(400), 'sms'), /too long/);
  assert.equal(templateDraft({ stage: 'funded_not_bought' }, {}).tactic, 'reduce_friction');
});

test('client SDK sends only hashes, never the raw email', async () => {
  const sent = [];
  const store = new Map();
  const c = createClient({
    key: PK, endpoint: 'http://localhost:1',
    storage: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) },
    transport: async (_url, body) => { sent.push(body); return true; },
  });
  await c.identify({ email: 'ada@example.com', phone: '08031234567' });
  c.track('page_view', { path: '/pricing?ref=ada@example.com' });
  c.track('custom', { name: 'bad name with spaces' });
  await c.flush();
  const all = sent.join('');
  assert.ok(!all.includes('ada@example.com'));
  assert.ok(!all.includes('08031234567'));
  const body = JSON.parse(sent[0]);
  assert.deepEqual(body.ids.sort(), identityHashes(PK, { email: 'ada@example.com', phone: '08031234567' }).sort());
  assert.equal(body.events.length, 2); // registered + page_view; invalid name dropped
  assert.equal(body.events[1].path, '/pricing');
  assert.throws(() => createClient({ key: 'nope', storage: {}, transport: async () => true }));
});

test('browser bundle is a self-contained script', () => {
  const src = buildBrowserBundle();
  assert.ok(!/^\s*(import|export)\s/m.test(src));
  assert.doesNotThrow(() => new Function(src));
});

test('Kobo mascot: CSP-safe markup and self-contained brand files', async () => {
  const { kobo } = await import('../src/dashboard/mascot.js');
  const { brandSvg } = await import('../scripts/build-brand.js');
  for (const mode of ['hero', 'mark', 'still']) {
    const svg = kobo({ mode });
    assert.ok(!/style=/.test(svg), 'no inline style attributes');
    assert.match(svg, /role="img" aria-label="/);
  }
  assert.match(kobo({ mode: 'hero' }), /kobo-coin/);
  const file = brandSvg('hero');
  assert.match(file, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(file, /@keyframes kobo-flight/);
  assert.match(file, /prefers-reduced-motion/);
  // Standalone SVGs must be well-formed XML or browsers show a broken image: no raw '&' outside CDATA.
  for (const mode of ['hero', 'mark', 'still']) {
    const f = brandSvg(mode);
    assert.ok(!/&(?![a-z]+;|#\d+;)/.test(f.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')), `${mode}: stray & outside CDATA`);
    assert.match(f, /<style><!\[CDATA\[/);
  }
});
