// End-to-end: real HTTP server, real SQLite file, all three layers, dashboard and attacks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { RecoverKit } from '../sdk/node/index.js';
import { identityHashes } from '../sdk/core/identity.js';

const DAY = 864e5;
let app, base, dir, project, rk, logs = [];
let paystackGw, flwGw;
const sentSms = [];
const aiCalls = [];
let aiReply = { message: 'Hi {first_name}, your wallet is ready o. Finish your data purchase in seconds.', tactic: 'reduce_friction', send: true };
const PAYSTACK_SECRET = 'sk_test_' + randomBytes(16).toString('hex');
const FLW_HASH = 'flw-secret-hash-' + randomBytes(8).toString('hex');

const fakeAnthropic = { beta: { messages: { create: async (req) => {
  aiCalls.push(req);
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(aiReply) }] };
} } } };

const aiHttpCalls = [];
let aiHttpReply = null;
const fakeFetch = async (url, init) => {
  if (/openai|generativelanguage|example-llm/.test(url)) {
    aiHttpCalls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(aiHttpReply(url)), { status: 200 });
  }
  sentSms.push({ url, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ message_id: 'm' + sentSms.length }), { status: 200 });
};

const logger = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, headers: res.headers };
}

function paystack(body, secret = PAYSTACK_SECRET, gw = paystackGw) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha512', secret).update(raw).digest('hex');
  return post(`/v1/webhooks/${gw}`, raw, { 'x-paystack-signature': sig });
}

const charge = (ref, email, amount = 50000, extra = {}) => ({
  event: 'charge.success',
  data: { status: 'success', reference: ref, amount, currency: 'NGN', paid_at: new Date().toISOString(), customer: { email, first_name: 'Ada' }, ...extra },
});

const personOf = (user) => app.people.findByHashes(project.id, identityHashes(project.publicKey, user));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rk-e2e-'));
  const config = {
    masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 'test.db'), publicUrl: 'http://127.0.0.1',
    trustProxy: false, ai: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-test' }, allowPrivateAiUrls: false, attributionDays: 7, feePercent: 10, minDaysBetweenMessages: 7,
  };
  app = await createApp({ config, fetch: fakeFetch, anthropicFactory: () => fakeAnthropic, logger });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  config.publicUrl = base;
  project = app.projects.create({ name: 'Ada VTU', gatewayMode: 'sales' });
  paystackGw = app.projects.addGateway(project.id, { provider: 'paystack', secret: PAYSTACK_SECRET });
  flwGw = app.projects.addGateway(project.id, { provider: 'flutterwave', secret: FLW_HASH });
  app.projects.setChannel(project.id, 'sms', { apiKey: 'termii-test', senderId: 'AdaVTU' });
  app.projects.createUser(project.id, 'owner@adavtu.ng', 'a-very-long-password-1');
  rk = new RecoverKit({ publicKey: project.publicKey, secretKey: project.secretKey, endpoint: base, throwOnError: true });
});

after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

test('layer 1: anonymous browsing joins the person after identify', async () => {
  const anonId = 'a_' + randomBytes(8).toString('hex');
  let r = await post('/v1/collect', { key: project.publicKey, anonId, events: [{ type: 'page_view', path: '/pricing' }, { type: 'page_view', path: '/data-plans' }] });
  assert.equal(r.status, 202);
  assert.equal(r.json.accepted, 2);
  const ids = identityHashes(project.publicKey, { email: 'tunde@example.com' });
  r = await post('/v1/collect', { key: project.publicKey, anonId, ids, events: [{ type: 'checkout_started', name: 'button' }] });
  assert.equal(r.status, 202);
  const pid = personOf({ email: 'tunde@example.com' });
  assert.ok(pid);
  const n = app.db.get('SELECT COUNT(*) n FROM events WHERE person_id = ?', pid).n;
  assert.equal(n, 3, 'earlier anonymous page views are attached');
});

test('layer 1 cannot create purchases, and drops unknown fields', async () => {
  const anonId = 'a_' + randomBytes(8).toString('hex');
  const ids = identityHashes(project.publicKey, { email: 'faker@example.com' });
  const r = await post('/v1/collect', { key: project.publicKey, anonId, ids, events: [
    { type: 'purchase', amount: 999999 }, { type: 'payment_signal', name: 'success_text' }, { type: 'form_submit', name: 'signup', password: 'hunter2', email: 'faker@example.com' },
  ] });
  assert.equal(r.json.accepted, 2);
  const pid = personOf({ email: 'faker@example.com' });
  assert.equal(app.db.get('SELECT COUNT(*) n FROM purchases WHERE person_id = ?', pid).n, 0);
  const dump = JSON.stringify(app.db.all('SELECT * FROM events'));
  assert.ok(!dump.includes('hunter2') && !dump.includes('faker@example.com'));
});

test('collect rejects bad keys, bad origins, oversize and oversized batches', async () => {
  const anonId = 'a_' + randomBytes(8).toString('hex');
  assert.equal((await post('/v1/collect', { key: 'rk_pub_' + '0'.repeat(24), anonId, events: [] })).status, 401);
  assert.equal((await post('/v1/collect', { key: project.publicKey, anonId: 'x', events: [] })).status, 400);
  assert.equal((await post('/v1/collect', { key: project.publicKey, anonId, events: Array(51).fill({ type: 'click' }) })).status, 400);
  assert.equal((await post('/v1/collect', 'x'.repeat(70 * 1024))).status, 413);
  assert.equal((await post('/v1/collect', '{not json')).status, 400);
  app.projects.update(project.id, { allowedOrigins: 'https://adavtu.ng' });
  assert.equal((await post('/v1/collect', { key: project.publicKey, anonId, events: [] }, { Origin: 'https://evil.example' })).status, 403);
  const ok = await post('/v1/collect', { key: project.publicKey, anonId, events: [] }, { Origin: 'https://adavtu.ng' });
  assert.equal(ok.status, 202);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://adavtu.ng');
  app.projects.update(project.id, { allowedOrigins: '' });
});

test('layer 3: server SDK auth, identify with contact, purchase', async () => {
  const bad = new RecoverKit({ publicKey: project.publicKey, secretKey: 'rk_sec_key_' + '0'.repeat(24) + '_' + 'x'.repeat(43), endpoint: base, throwOnError: true });
  await assert.rejects(bad.trackPurchase({ email: 'x@example.com', amount: 100 }), /401/);
  const quiet = new RecoverKit({ publicKey: project.publicKey, secretKey: 'rk_sec_nope', endpoint: base });
  assert.equal((await quiet.trackPurchase({ email: 'x@example.com', amount: 100 })).ok, false, 'never throws by default');

  await rk.identify({ email: 'chioma@example.com', phone: '08031112222', firstName: 'Chioma' });
  await rk.walletFunded({ email: 'chioma@example.com', amount: 200000 });
  const pid = personOf({ phone: '+2348031112222' });
  assert.ok(pid, 'phone and email map to the same person');
  assert.equal(pid, personOf({ email: 'CHIOMA@example.com' }));
  const row = app.db.get('SELECT contact_enc FROM persons WHERE id = ?', pid);
  assert.ok(!row.contact_enc.includes('chioma'), 'contact is encrypted at rest');
  assert.equal(app.people.getContact(project.id, pid).firstName, 'Chioma');

  await assert.rejects(rk.track('refund', { email: 'chioma@example.com' }), /400/);
  const r = await post('/v1/server/events', { events: [{ type: 'purchase', amount: 100 }] }, { Authorization: `Bearer ${project.secretKey}` });
  assert.equal(r.status, 400, 'purchase without identity is refused');
});

test('revoked secret keys stop working', async () => {
  const key = app.projects.createSecretKey(project.id, 'temp');
  const temp = new RecoverKit({ publicKey: project.publicKey, secretKey: key, endpoint: base, throwOnError: true });
  await temp.track('custom', { email: 'tmp@example.com', name: 'ping' });
  app.projects.revokeSecretKey(project.id, key.split('_').slice(2, 4).join('_'));
  await assert.rejects(temp.track('custom', { email: 'tmp@example.com', name: 'ping' }), /401/);
});

test('layer 2: Paystack signature, replay protection and dedupe with layer 3', async () => {
  assert.equal((await paystack(charge('ref-1', 'bola@example.com'), 'wrong-secret')).status, 401);
  const unsigned = await post(`/v1/webhooks/${paystackGw}`, charge('ref-1', 'bola@example.com'));
  assert.equal(unsigned.status, 401);
  assert.equal((await paystack(charge('ref-1', 'bola@example.com'), PAYSTACK_SECRET, 'gw_' + 'f'.repeat(24))).status, 401);
  assert.equal((await paystack(charge('ref-1', 'bola@example.com'), PAYSTACK_SECRET, flwGw)).status, 401, 'one gateway\'s signature is not valid for another');

  let r = await paystack(charge('ref-1', 'bola@example.com'));
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, 'sale');
  r = await paystack(charge('ref-1', 'bola@example.com'));
  assert.equal(r.json.duplicate, true, 'replayed webhook is ignored');

  await rk.trackPurchase({ email: 'bola@example.com', amount: 50000, ref: 'ref-1' });
  const pid = personOf({ email: 'bola@example.com' });
  const rows = app.db.all('SELECT * FROM purchases WHERE person_id = ?', pid);
  assert.equal(rows.length, 1, 'webhook + server call = one purchase');
  assert.equal(rows[0].sources, 'paystack,server');

  // Without a shared ref, same person + amount within 15 minutes still merges.
  await paystack(charge('ref-2', 'bola@example.com', 70000));
  await rk.trackPurchase({ email: 'bola@example.com', amount: 70000 });
  assert.equal(app.db.all('SELECT * FROM purchases WHERE person_id = ?', pid).length, 2);

  r = await paystack({ event: 'transfer.success', data: { status: 'success' } });
  assert.equal(r.json.ignored, 'event type not tracked');
});

test('deposits mode: gateway payments are wallet funding, not sales (VTU)', async () => {
  app.projects.update(project.id, { gatewayMode: 'deposits' });
  const r = await paystack(charge('dep-1', 'emeka@example.com', 100000, { customer: { email: 'emeka@example.com', phone: '08044443333', first_name: 'Emeka' } }));
  assert.equal(r.json.kind, 'deposit');
  const pid = personOf({ email: 'emeka@example.com' });
  assert.equal(app.db.get('SELECT COUNT(*) n FROM purchases WHERE person_id = ?', pid).n, 0);
  assert.equal(app.db.get("SELECT COUNT(*) n FROM events WHERE person_id = ? AND type = 'wallet_funded'", pid).n, 1);
  // A per-payment tag overrides the project default.
  await paystack(charge('sale-1', 'emeka@example.com', 30000, { metadata: { recoverkit_kind: 'sale' } }));
  assert.equal(app.db.get('SELECT COUNT(*) n FROM purchases WHERE person_id = ?', pid).n, 1);
  app.projects.update(project.id, { gatewayMode: 'sales' });
  app.db.run('DELETE FROM purchases WHERE person_id = ?', pid); // keep emeka as a funded-not-bought lead
});

test('layer 2: Flutterwave verif-hash and HMAC signatures', async () => {
  const body = (id) => ({ event: 'charge.completed', data: { id, tx_ref: `flw-${id}`, status: 'successful', amount: 1500.5, currency: 'NGN', customer: { email: 'ngozi@example.com', phone_number: '08055556666', name: 'Ngozi Okafor' } } });
  assert.equal((await post(`/v1/webhooks/${flwGw}`, body(1), { 'verif-hash': 'wrong' })).status, 401);
  assert.equal((await post(`/v1/webhooks/${flwGw}`, body(1))).status, 401);
  let r = await post(`/v1/webhooks/${flwGw}`, body(1), { 'verif-hash': FLW_HASH });
  assert.equal(r.json.kind, 'sale');
  const raw = JSON.stringify(body(2));
  r = await post(`/v1/webhooks/${flwGw}`, raw, { 'flutterwave-signature': createHmac('sha256', FLW_HASH).update(raw).digest('base64') });
  assert.equal(r.status, 200);
  const pid = personOf({ phone: '08055556666' });
  const amounts = app.db.all('SELECT amount FROM purchases WHERE person_id = ?', pid).map((p) => p.amount);
  assert.deepEqual(amounts, [150050, 150050], 'naira converted to kobo');
});

test('leads: non-buyers ranked, buyers excluded, payment signals lower confidence', () => {
  const now = Date.now() + 3 * DAY;
  const leads = app.engine.leads(project.id, { now, minConfidence: 0 });
  const byPerson = Object.fromEntries(leads.map((l) => [l.personId, l]));
  const chioma = byPerson[personOf({ email: 'chioma@example.com' })];
  assert.equal(chioma.stage, 'funded_not_bought');
  assert.ok(chioma.confidence >= 0.9);
  assert.equal(byPerson[personOf({ email: 'tunde@example.com' })].stage, 'checkout_abandoned');
  assert.equal(byPerson[personOf({ email: 'bola@example.com' })], undefined, 'recent buyer is not a lead');
  const faker = byPerson[personOf({ email: 'faker@example.com' })];
  assert.ok(faker.confidence < 0.6, 'browser success screen means maybe paid: do not chase');
  assert.ok(!app.engine.leads(project.id, { now }).some((l) => l.personId === faker.personId));

  // Lapsed customer: bought 40 days ago.
  const pid = app.people.resolve(project.id, identityHashes(project.publicKey, { email: 'old@example.com' }), Date.now() - 45 * DAY);
  app.engine.recordPurchase(project.id, { personId: pid, ref: 'old-1', amount: 1000, currency: 'NGN', source: 'server', ts: Date.now() - 40 * DAY });
  const lapsed = app.engine.leads(project.id, { now, minConfidence: 0 }).find((l) => l.personId === pid);
  assert.equal(lapsed.leadType, 'lapsed');
});

test('AI drafting: no PII sent to the model, unsafe output falls back to a template', async () => {
  app.projects.update(project.id, { voiceProfile: 'We talk like friends. Pidgin is fine.', paymentLink: 'https://adavtu.ng/pay' });
  aiCalls.length = 0;
  const r = await app.outreach.generateDrafts(project.id, { now: Date.now() + 3 * DAY });
  assert.ok(r.drafted >= 2);
  assert.ok(aiCalls.length >= 2);
  const sentToModel = JSON.stringify(aiCalls);
  for (const pii of ['chioma@example.com', '2348031112222', 'Chioma', 'tunde@example.com']) assert.ok(!sentToModel.includes(pii), pii);
  assert.equal(aiCalls[0].model, 'claude-opus-5-5');
  assert.equal(aiCalls[0].fallbacks, 'default');

  const chiomaId = personOf({ email: 'chioma@example.com' });
  const m = app.db.get("SELECT * FROM messages WHERE person_id = ? AND status = 'draft'", chiomaId);
  assert.match(m.body, /^Hi Chioma, your wallet is ready o\..* https:\/\/adavtu\.ng\/pay$/);

  // A model trying to inject its own link is rejected.
  aiReply = { message: 'Hi {first_name}, pay here: https://evil.example/pay', tactic: 'reminder', send: true };
  const pid = app.people.resolve(project.id, identityHashes(project.publicKey, { email: 'new@example.com' }));
  app.people.setContact(project.id, pid, { phone: '08099990000' });
  app.engine.recordEvent(project.id, { personId: pid, layer: 3, type: 'checkout_started', ts: Date.now() });
  await app.outreach.generateDrafts(project.id, { now: Date.now() + 3 * DAY });
  const injected = app.db.get('SELECT * FROM messages WHERE person_id = ?', pid);
  assert.equal(injected.drafted_by, 'template');
  assert.ok(!injected.body.includes('evil'));
  aiReply = { message: 'Hi {first_name}, still dey wait for you.', tactic: 'reminder', send: true };
});

test('send: skips anyone who paid or opted out, then attributes recovered revenue', async () => {
  const drafts = app.db.all("SELECT * FROM messages WHERE project_id = ? AND status = 'draft'", project.id);
  for (const d of drafts) app.outreach.approve(project.id, d.id, 'test');

  const tundeId = personOf({ email: 'tunde@example.com' });
  const tunde = drafts.find((d) => d.person_id === tundeId);
  // Tunde has no contact (browser only), so he was never drafted.
  assert.equal(tunde, undefined);

  // Ngozi... not a lead. Emeka pays before we send: must be skipped.
  const emekaId = personOf({ email: 'emeka@example.com' });
  const emekaMsg = drafts.find((d) => d.person_id === emekaId);
  assert.ok(emekaMsg, 'emeka was drafted (contact from webhook)');
  await rk.trackPurchase({ email: 'emeka@example.com', amount: 20000, ref: 'emeka-late' });

  // The "new" person opts out via the unsubscribe link.
  const newId = personOf({ email: 'new@example.com' });
  const token = app.outreach.unsubscribeUrl(project.id, newId).split('/u/')[1];
  const page = await fetch(`${base}/u/${token}`);
  assert.equal(page.status, 200);
  assert.equal(app.db.get('SELECT opted_out FROM persons WHERE id = ?', newId).opted_out, 0, 'GET alone does not unsubscribe');
  assert.equal((await post(`/u/${token}`, '')).status, 200);
  assert.equal((await post(`/u/${token.slice(0, -3)}abc`, '')).status, 400, 'forged token rejected');

  const res = await app.outreach.sendApproved(project.id);
  assert.ok(res.sent >= 1);
  assert.equal(app.db.get('SELECT status, status_reason FROM messages WHERE id = ?', emekaMsg.id).status_reason, 'person has purchased');
  assert.equal(app.db.get("SELECT status FROM messages WHERE person_id = ? ORDER BY created_at DESC", newId).status, 'rejected');
  const sms = sentSms.find((s) => s.body.to === '2348031112222');
  assert.ok(sms, 'chioma got an SMS');
  assert.match(sms.body.sms, /Stop: http/);

  // A second send does nothing (no double sends).
  assert.equal((await app.outreach.sendApproved(project.id)).sent, 0);

  // Chioma buys 2 days later: recovered revenue.
  await rk.trackPurchase({ email: 'chioma@example.com', amount: 150000, ref: 'chioma-1' });
  const rev = app.engine.revenue(project.id);
  assert.equal(rev.recoveredAmount, 150000);
  assert.equal(rev.fee, 15000);

  // Messaged recently: not a lead again for 7 days.
  assert.ok(!app.engine.leads(project.id, { minConfidence: 0 }).some((l) => l.personId === personOf({ email: 'chioma@example.com' })));
});

test('erasure removes the person but keeps anonymous revenue', async () => {
  await rk.identify({ email: 'gone@example.com', phone: '08070000000' });
  await rk.trackPurchase({ email: 'gone@example.com', amount: 500, ref: 'gone-1' });
  const pid = personOf({ email: 'gone@example.com' });
  const r = await rk.erase({ phone: '08070000000' });
  assert.equal(r.erased, true);
  assert.equal(app.db.get('SELECT COUNT(*) n FROM persons WHERE id = ?', pid).n, 0);
  assert.equal(app.db.get('SELECT COUNT(*) n FROM identities WHERE person_id = ?', pid).n, 0);
  assert.equal(app.db.get('SELECT COUNT(*) n FROM events WHERE person_id = ?', pid).n, 0);
  assert.equal(app.db.get("SELECT person_id FROM purchases WHERE amount = 500").person_id, null);
});

// ---------------- dashboard ----------------
async function login(email = 'owner@adavtu.ng', password = 'a-very-long-password-1') {
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }) });
  return { status: r.status, location: r.headers.get('location'), cookie: r.headers.get('set-cookie') };
}
const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];

test('dashboard: login, session cookie flags, auth required', async () => {
  assert.equal((await get('/dashboard')).headers.get('location'), '/login');
  const bad = await login('owner@adavtu.ng', 'wrong-password-123');
  assert.match(bad.location, /err=/);
  assert.equal(bad.cookie, null);
  const unknown = await login('nobody@adavtu.ng', 'wrong-password-123');
  assert.match(unknown.location, /err=Wrong/, 'same message for unknown users');
  const ok = await login();
  assert.equal(ok.location, '/dashboard');
  assert.match(ok.cookie, /HttpOnly/);
  assert.match(ok.cookie, /SameSite=Strict/);
  const cookie = ok.cookie.split(';')[0];
  const page = await get('/dashboard', cookie);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Recovered revenue/);
  assert.match(html, /₦1,500/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(app.db.get('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?', cookie.split('=')[1]).n, 0, 'raw session tokens are not stored');
});

test('dashboard: CSRF, XSS escaping and settings', async () => {
  const cookie = (await login()).cookie.split(';')[0];
  const html = await (await get('/dashboard/settings', cookie)).text();
  const csrf = csrfOf(html);
  assert.ok(csrf);
  const form = (o) => ({ method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });

  const noCsrf = await fetch(base + '/dashboard/settings', form({ voiceProfile: 'hacked', gatewayMode: 'sales' }));
  assert.equal(noCsrf.status, 403);
  const crossSite = await fetch(base + '/dashboard/settings', { ...form({ _csrf: csrf, voiceProfile: 'x', gatewayMode: 'sales' }), headers: { ...form({}).headers, Origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);

  const xss = '</textarea><script>alert(1)</script>"\'><img src=x onerror=alert(1)>';
  const saved = await fetch(base + '/dashboard/settings', form({ _csrf: csrf, voiceProfile: xss, paymentLink: 'https://adavtu.ng/pay', gatewayMode: 'sales', allowedOrigins: '', requireApproval: '1' }));
  assert.equal(saved.status, 303);
  const after = await (await get('/dashboard/settings', cookie)).text();
  assert.ok(!after.includes('<script>alert(1)</script>'));
  assert.ok(!after.includes('<img src=x'));
  assert.ok(after.includes('&lt;/textarea&gt;&lt;script&gt;'));

  const badLink = await fetch(base + '/dashboard/settings', form({ _csrf: csrf, paymentLink: 'javascript:alert(1)', gatewayMode: 'sales' }));
  assert.match(badLink.headers.get('location'), /err=/);

  // Secrets are write-only: never echoed back into the page.
  assert.ok(!after.includes(PAYSTACK_SECRET));
  assert.ok(!after.includes('termii-test'));

  // Cross-project access: a message id from another project cannot be approved.
  const other = app.projects.create({ name: 'Other' });
  const otherPerson = app.people.resolve(other.id, identityHashes(other.publicKey, { email: 'z@example.com' }));
  app.db.run("INSERT INTO messages (id, project_id, person_id, lead_type, channel, body, score, confidence, status, drafted_by, created_at) VALUES ('msg_other', ?, ?, 'never_bought', 'sms', 'hi', 1, 1, 'draft', 't', 0)", other.id, otherPerson);
  await fetch(base + '/dashboard/messages/msg_other/approve', form({ _csrf: csrf }));
  assert.equal(app.db.get("SELECT status FROM messages WHERE id = 'msg_other'").status, 'draft');
});

test('dashboard: login brute force is rate limited', async () => {
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await login('owner@adavtu.ng', 'guess-' + i + '-xxxxxxx');
    if (/Too%20many|Too\+many/.test(r.location || '')) { limited = true; break; }
  }
  assert.ok(limited);
  app.limiter.reset('login-email:owner@adavtu.ng');
});

test('misc: health, 404, 405, security headers, SDK script served', async () => {
  const h = await fetch(base + '/health');
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.equal((await fetch(base + '/v1/collect')).status, 405);
  const icon = await fetch(base + '/static/kobo.svg');
  assert.match(icon.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(icon.headers.get('content-security-policy'), /default-src 'none'/);
  const js = await fetch(base + '/sdk/recoverkit.js');
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /RecoverKit/);
  assert.ok(!logs.some((l) => /chioma@example\.com|2348031112222/.test(String(l))), 'logs never contain raw contacts');
});

test('attack: public key cannot merge two people or hijack an identity', async () => {
  await rk.identify({ email: 'victim1@example.com', phone: '08011110001' });
  await rk.identify({ email: 'victim2@example.com', phone: '08011110002' });
  const v1 = personOf({ email: 'victim1@example.com' });
  const v2 = personOf({ email: 'victim2@example.com' });
  const anonId = 'a_' + randomBytes(8).toString('hex');
  const ids = [...identityHashes(project.publicKey, { email: 'victim1@example.com' }), ...identityHashes(project.publicKey, { email: 'victim2@example.com' })];
  await post('/v1/collect', { key: project.publicKey, anonId, ids, events: [{ type: 'click' }] });
  assert.notEqual(personOf({ email: 'victim1@example.com' }), personOf({ email: 'victim2@example.com' }));
  assert.ok(app.db.get('SELECT 1 FROM persons WHERE id = ?', v2), 'victim2 still exists');
  // Attaching the attacker's own email to victim1 from the browser is refused.
  const hijack = [identityHashes(project.publicKey, { email: 'victim1@example.com' })[0], identityHashes(project.publicKey, { email: 'attacker@example.com' })[0]];
  await post('/v1/collect', { key: project.publicKey, anonId: 'a_' + randomBytes(8).toString('hex'), ids: hijack, events: [] });
  assert.equal(personOf({ email: 'attacker@example.com' }), null);
  assert.equal(personOf({ email: 'victim1@example.com' }), v1);
});

test('dashboard: leads and messages pages, draft, approve and send over HTTP', async () => {
  const cookie = (await login()).cookie.split(';')[0];
  const form = (csrf, o = {}) => ({ method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...o }) });
  const pid = app.people.resolve(project.id, identityHashes(project.publicKey, { email: 'httplead@example.com' }));
  app.people.setContact(project.id, pid, { phone: '08022223333', firstName: 'Kemi' });
  app.engine.recordEvent(project.id, { personId: pid, layer: 3, type: 'wallet_funded', amount: 5000, ts: Date.now() - 3 * DAY });

  const leadsHtml = await (await get('/dashboard/leads', cookie)).text();
  assert.match(leadsHtml, /Funded wallet, never bought/);
  assert.ok(!leadsHtml.includes('08022223333') && !leadsHtml.includes('2348022223333'), 'contacts are masked');
  const csrf = csrfOf(leadsHtml);
  const d = await fetch(base + '/dashboard/drafts', form(csrf));
  assert.equal(d.status, 303);
  const msgsHtml = await (await get('/dashboard/messages', cookie)).text();
  assert.match(msgsHtml, /Hi Kemi/);
  const id = app.db.get("SELECT id FROM messages WHERE person_id = ? AND status = 'draft'", pid).id;
  await fetch(base + `/dashboard/messages/${id}/approve`, form(csrf, { body: 'Hi Kemi, your wallet is ready <b>now</b>.' }));
  assert.equal(app.db.get('SELECT status FROM messages WHERE id = ?', id).status, 'approved');
  const s = await fetch(base + '/dashboard/send', form(csrf));
  assert.match(decodeURIComponent(s.headers.get('location')), /Sent 1/);
  assert.equal(app.db.get('SELECT status FROM messages WHERE id = ?', id).status, 'sent');
  const hist = await (await get('/dashboard/messages?view=history', cookie)).text();
  assert.ok(hist.includes('&lt;b&gt;now&lt;/b&gt;'), 'message bodies are escaped');

  const k = await fetch(base + '/dashboard/keys', form(csrf));
  assert.match(await k.text(), /rk_sec_key_[0-9a-f]{24}_/);
  const lo = await fetch(base + '/logout', form(csrf));
  assert.equal(lo.headers.get('location'), '/login');
  assert.equal((await get('/dashboard', cookie)).headers.get('location'), '/login', 'session ended');
});

test('dashboard: cross-origin login is blocked', async () => {
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' }, body: 'email=owner%40adavtu.ng&password=x' });
  assert.equal(r.status, 403);
});

test('dashboard: connect a custom gateway, then receive its webhook', async () => {
  const cookie = (await login()).cookie.split(';')[0];
  const html = await (await get('/dashboard/payments/new?provider=custom', cookie)).text();
  assert.match(html, /Connect Other gateway/);
  const csrf = csrfOf(html);
  const form = (o) => ({ method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...o }) });
  const secret = 'remita-secret-' + randomBytes(6).toString('hex');
  const r = await fetch(base + '/dashboard/payments', form({
    provider: 'custom', label: 'Remita', secret, sig1_scheme: 'hmac', sig1_header: 'x-remita-sig', sig1_algorithm: 'sha256', sig1_encoding: 'hex', sig1_signs: 'body', sig2_scheme: '',
    eventPath: 'type', eventValues: 'paid', statusPath: '', statusValues: '', amountUnit: 'major', f_ref: 'rrr', f_amount: 'amt', f_email: 'email', f_eventId: '', f_currency: '', f_phone: '', f_name: '', f_time: '', f_kind: '',
  }));
  const loc = r.headers.get('location');
  const gwId = /\/dashboard\/payments\/(gw_[0-9a-f]{24})/.exec(loc)?.[1];
  assert.ok(gwId, loc);
  const page = await (await get(`/dashboard/payments/${gwId}`, cookie)).text();
  assert.ok(page.includes(`/v1/webhooks/${gwId}`));
  assert.ok(!page.includes(secret), 'secret never shown');

  const raw = JSON.stringify({ type: 'paid', rrr: 'RRR-1', amt: 99.5, email: 'remita.buyer@example.com' });
  const ok = await post(`/v1/webhooks/${gwId}`, raw, { 'x-remita-sig': createHmac('sha256', secret).update(raw).digest('hex') });
  assert.equal(ok.json.kind, 'sale');
  const pid = personOf({ email: 'remita.buyer@example.com' });
  assert.equal(app.db.get('SELECT amount FROM purchases WHERE person_id = ?', pid).amount, 9950);
  assert.match(app.db.get('SELECT last_result FROM gateways WHERE id = ?', gwId).last_result, /^ok/);

  // Disable it: webhooks are refused.
  await fetch(base + `/dashboard/payments/${gwId}`, form({ label: 'Remita', secret: '', sig1_scheme: 'hmac', sig1_header: 'x-remita-sig', sig1_algorithm: 'sha256', sig1_encoding: 'hex', sig1_signs: 'body', eventPath: 'type', eventValues: 'paid', amountUnit: 'major', f_ref: 'rrr', f_amount: 'amt', f_email: 'email' }));
  assert.equal((await post(`/v1/webhooks/${gwId}`, raw, { 'x-remita-sig': createHmac('sha256', secret).update(raw).digest('hex') })).status, 401);

  // A bad spec is refused with a readable message.
  const bad = await fetch(base + '/dashboard/payments', form({ provider: 'custom', secret, sig1_scheme: 'hmac', sig1_header: 'x-sig', sig1_algorithm: 'md5', sig1_encoding: 'hex', amountUnit: 'major', f_amount: 'amt', f_ref: 'r' }));
  assert.match(decodeURIComponent(bad.headers.get('location')), /algorithm must be/);
  const proto = await fetch(base + '/dashboard/payments', form({ provider: '__proto__', secret }));
  assert.match(decodeURIComponent(proto.headers.get('location')), /unknown gateway type/);
  // Another project's gateway can't be edited.
  const other = app.projects.create({ name: 'Other2' });
  const otherGw = app.projects.addGateway(other.id, { provider: 'paystack', secret: 'sk_test_other_123' });
  assert.equal((await get(`/dashboard/payments/${otherGw}`, cookie)).headers.get('location'), '/dashboard/payments');
  await fetch(base + `/dashboard/payments/${otherGw}/delete`, form({}));
  assert.ok(app.projects.getGateway(otherGw), 'cross-project delete refused');
});

test('dashboard: choose a different AI provider and test it', async () => {
  const cookie = (await login()).cookie.split(';')[0];
  const html = await (await get('/dashboard/ai', cookie)).text();
  assert.match(html, /Server default \(Anthropic Claude · claude-opus-5-5\)/);
  const csrf = csrfOf(html);
  const form = (o) => ({ method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...o }) });
  await fetch(base + '/dashboard/ai', form({ provider: 'gemini', model: 'gemini-test-model', apiKey: 'gem-key-123', baseUrl: '' }));
  const saved = app.projects.getAiSettings(app.projects.byId(project.id));
  assert.equal(saved.provider, 'gemini');
  assert.ok(!app.db.get('SELECT ai_enc FROM projects WHERE id = ?', project.id).ai_enc.includes('gem-key-123'), 'API key encrypted at rest');
  const after = await (await get('/dashboard/ai', cookie)).text();
  assert.ok(!after.includes('gem-key-123'), 'API key never shown');

  aiHttpReply = () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ message: 'Hi {first_name}, wetin happen? Your wallet dey ready.', tactic: 'reminder', send: true }) }] } }] });
  const t = await fetch(base + '/dashboard/ai/test', form({}));
  assert.match(decodeURIComponent(t.headers.get('location')), /It works\. Sample: "Hi Ada, wetin happen/);
  assert.match(aiHttpCalls.at(-1).url, /gemini-test-model:generateContent/);
  assert.ok(!JSON.stringify(aiHttpCalls).includes('@example.com'), 'no PII sent to the provider');

  // SSRF via dashboard: a compatible provider pointing at the server's own network fails the test.
  await fetch(base + '/dashboard/ai', form({ provider: 'openai-compatible', model: 'llama', apiKey: '', baseUrl: 'https://127.0.0.1:8080/v1' }));
  const ssrf = await fetch(base + '/dashboard/ai/test', form({}));
  assert.match(decodeURIComponent(ssrf.headers.get('location')), /private network/);

  await fetch(base + '/dashboard/ai/reset', form({}));
  assert.equal(app.projects.getAiSettings(app.projects.byId(project.id)), null);
});

test('dashboard: every page renders for a signed-in user', async () => {
  const cookie = (await login()).cookie.split(';')[0];
  for (const path of ['/dashboard', '/dashboard/leads', '/dashboard/leads?type=lapsed', '/dashboard/messages', '/dashboard/messages?view=approved', '/dashboard/messages?view=history', '/dashboard/payments', '/dashboard/payments/new?provider=stripe', '/dashboard/ai', '/dashboard/channels', '/dashboard/settings']) {
    const r = await get(path, cookie);
    assert.equal(r.status, 200, path);
    const html = await r.text();
    assert.ok(!/style="/.test(html), `${path}: no inline styles (CSP)`);
    assert.ok(!/<script/i.test(html), `${path}: no scripts`);
  }
  assert.equal((await get('/dashboard/payments/new?provider=__proto__', cookie)).headers.get('location'), '/dashboard/payments');
});

test('dashboard: real-browser origin headers (Origin: null + Sec-Fetch-Site)', async () => {
  const body = new URLSearchParams({ email: 'owner@adavtu.ng', password: 'a-very-long-password-1' });
  const h = (extra) => ({ method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extra }, body });
  assert.equal((await fetch(base + '/login', h({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }))).headers.get('location'), '/dashboard');
  assert.equal((await fetch(base + '/login', h({ Origin: 'null' }))).status, 403);
  assert.equal((await fetch(base + '/login', h({ 'Sec-Fetch-Site': 'cross-site' }))).status, 403);
  const blocked = await fetch(base + '/login', h({ Origin: 'https://evil.example' }));
  assert.match(blocked.headers.get('content-type'), /text\/html/);
});

test('developers: setup page, secret key shown once, share link, docs and downloads', async () => {
  const cookie = (await login()).cookie.split(';')[0];
  assert.equal((await get('/dashboard/developers')).headers.get('location'), '/login', 'needs a session');
  const r = await get('/dashboard/developers', cookie);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes(project.publicKey), 'public key filled in');
  assert.ok(html.includes(`${base}/sdk/php/recoverkit-connector.php`), 'download commands point at this server');
  assert.ok(!/rk_sec_key_/.test(html), 'no secret key on the page by default');
  assert.ok(!/<script/i.test(html) && !/style="/.test(html), 'CSP-safe');

  // Create a key for the developer: shown once, works, and is labelled.
  const form = (o) => ({ method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
  assert.equal((await fetch(base + '/dashboard/developers/key', form({ _csrf: 'wrong' }))).status, 403);
  const made = await (await fetch(base + '/dashboard/developers/key', form({ _csrf: csrfOf(html) }))).text();
  const key = /RK_SECRET_KEY=(rk_sec_[A-Za-z0-9_-]+)/.exec(made)?.[1];
  assert.ok(key, 'secret key shown in the .env block');
  const dev = new RecoverKit({ publicKey: project.publicKey, secretKey: key, endpoint: base, throwOnError: true });
  assert.equal((await dev.identify({ email: 'dev-check@adavtu.ng' })).ok, true);
  assert.equal(app.db.get("SELECT COUNT(*) n FROM api_keys WHERE project_id = ? AND label = 'developer'", project.id).n, 1);
  assert.ok(!(await (await get('/dashboard/developers', cookie)).text()).includes(key), 'not shown again');

  // Share link: public key and endpoint only, no session; tampered links fail.
  const link = /value="(http[^"]+\/dev\/[^"]+)"/.exec(html)?.[1];
  assert.ok(link);
  const shared = await fetch(link);
  assert.equal(shared.status, 200);
  const sharedHtml = await shared.text();
  assert.ok(sharedHtml.includes(project.publicKey) && sharedHtml.includes('Ada VTU'));
  assert.ok(!/rk_sec_key_|_csrf/.test(sharedHtml), 'no secrets or forms');
  assert.equal(shared.headers.get('x-robots-tag'), 'noindex');
  const token = link.split('/dev/')[1];
  assert.equal((await fetch(`${base}/dev/${token.slice(0, -2)}xx`)).status, 404);
  const { signToken } = await import('../src/crypto.js');
  const unsub = signToken(app.keys.sign, { p: project.id, u: 'p_x' }, 3600);
  assert.equal((await fetch(`${base}/dev/${unsub}`)).status, 404, 'an unsubscribe token is not a guide link');
  const expired = signToken(app.keys.sign, { g: project.id }, -10);
  assert.equal((await fetch(`${base}/dev/${expired}`)).status, 404, 'expired links stop working');

  // Public docs.
  const docs = await fetch(base + '/docs');
  assert.equal(docs.status, 200);
  const docsHtml = await docs.text();
  assert.match(docsHtml, /API reference/);
  assert.match(docsHtml, /rk_pub_YOUR_PUBLIC_KEY/);

  // Downloads: exact files, saved not run, and a valid zip.
  const php = await fetch(base + '/sdk/php/recoverkit-connector.php');
  assert.equal(php.status, 200);
  assert.match(php.headers.get('content-type'), /^text\/plain/);
  assert.match(php.headers.get('content-disposition'), /attachment; filename="recoverkit-connector.php"/);
  assert.match(await php.text(), /MIT License/);
  assert.equal((await fetch(base + '/sdk/php/..%2F..%2Fsrc%2Fconfig.js')).status, 404);
  assert.equal((await fetch(base + '/sdk/php/RecoverKitXphp')).status, 404, 'dots are literal in routes');
  const zip = Buffer.from(await (await fetch(base + '/sdk/recoverkit-php.zip')).arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'php.zip'), zip);
  const listing = execFileSync('unzip', ['-l', join(dir, 'php.zip')], { encoding: 'utf8' });
  for (const f of ['RecoverKit.php', 'recoverkit-connector.php', 'recoverkit-detect.php', 'LICENSE', 'README.txt']) assert.match(listing, new RegExp(`recoverkit-php/${f.replace('.', '\\.')}`));
  execFileSync('unzip', ['-tq', join(dir, 'php.zip')]);
});

test('SDKs require an explicit endpoint', () => {
  assert.throws(() => new RecoverKit({ publicKey: project.publicKey, secretKey: 'rk_sec_x' }), /endpoint required/);
});
