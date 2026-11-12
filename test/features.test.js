// WhatsApp replies, team, deleting a business, first-steps checklist and automation settings, over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { identityHashes } from '../sdk/core/identity.js';
import { isStop } from '../src/whatsapp.js';

let app, base, dir, p, other, owner, csrf;
const mails = [];
const sentWa = [];
const mailer = { enabled: true, mode: 'test', send: async (m) => { mails.push(m); return { ok: true }; } };
const fakeFetch = async (url, init) => {
  if (String(url).includes('graph.facebook.com')) { sentWa.push(JSON.parse(init.body)); return new Response('{"messages":[{"id":"w1"}]}', { status: 200 }); }
  return new Response('{}', { status: 200 });
};
const APP_SECRET = 'meta-app-secret-' + randomBytes(6).toString('hex');
const PW = 'owner-password-long-1';

async function login(email, password = PW) {
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }) });
  return r.headers.get('set-cookie')?.split(';')[0];
}
const get = (path, c) => fetch(base + path, { redirect: 'manual', headers: c ? { Cookie: c } : {} });
const post = (path, body, c) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: c }, body: new URLSearchParams(body) });
const loc = (r) => decodeURIComponent(r.headers.get('location') || '');
const csrfOf = async (c) => /name="_csrf" value="([^"]+)"/.exec(await (await get('/dashboard/settings', c)).text())[1];

function waPost(projectId, payload, secret = APP_SECRET) {
  const raw = JSON.stringify(payload);
  return fetch(`${base}/v1/whatsapp/${projectId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex') }, body: raw });
}
const waMsg = (from, text, id) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '1234567890' }, messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rk-feat-'));
  const config = { masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 't.db'), publicUrl: 'http://127.0.0.1', trustProxy: false, ai: { provider: 'none' }, attributionDays: 7, feePercent: 0, minDaysBetweenMessages: 7, scheduler: false };
  app = await createApp({ config, mailer, fetch: fakeFetch, logger: { log() {}, warn() {}, error() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  config.publicUrl = base;
  const made = app.projects.create({ name: 'Ada Data' });
  p = { ...app.projects.byId(made.id) };
  app.projects.createUser(p.id, 'owner@ada.ng', PW);
  other = app.projects.create({ name: 'Other' });
  app.projects.createUser(other.id, 'boss@other.ng', PW);
  owner = await login('owner@ada.ng');
  csrf = await csrfOf(owner);
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

test('STOP words', () => {
  for (const w of ['STOP', 'stop.', ' Unsubscribe ', 'opt out', 'STOP ALL']) assert.ok(isStop(w), w);
  for (const w of ['stop sending me the wrong plan?', 'hello', '']) assert.ok(!isStop(w), w);
});

test('WhatsApp webhook: Meta handshake, signatures, replies, STOP opt-out, answering', async () => {
  const token = app.whatsapp?.verifyToken?.(p.id) || /value="([0-9a-f]{32})" aria-label="Verify token"/.exec(await (await get('/dashboard/channels', owner)).text())[1];
  const ok = await fetch(`${base}/v1/whatsapp/${p.id}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');
  assert.equal((await fetch(`${base}/v1/whatsapp/${p.id}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);

  // Not set up yet: every POST is refused.
  assert.equal((await waPost(p.id, waMsg('2348031112222', 'hi', 'w-a'))).status, 401);
  await post('/dashboard/channels', { _csrf: csrf, wa_accessToken: 'EAAtoken', wa_phoneNumberId: '1234567890', wa_templateName: 'followup', wa_appSecret: APP_SECRET }, owner);
  assert.equal((await waPost(p.id, waMsg('2348031112222', 'hi', 'w-b'), 'wrong-secret')).status, 401, 'bad signature');

  // A known customer replies.
  const pid = app.people.resolve(p.id, identityHashes(p.public_key, { phone: '08031112222' }), Date.now());
  const r1 = await waPost(p.id, waMsg('2348031112222', 'Is MTN data working now?', 'wamid.1'));
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).stored, 1);
  assert.equal((await (await waPost(p.id, waMsg('2348031112222', 'Is MTN data working now?', 'wamid.1'))).json()).stored, 0, 'Meta retries are de-duplicated');
  const row = app.db.get('SELECT * FROM inbound WHERE provider_id = ?', 'wamid.1');
  assert.equal(row.person_id, pid);
  assert.ok(!row.body_enc.includes('MTN') && !row.from_enc.includes('2348031112222'), 'stored encrypted');
  const page = await (await get('/dashboard/messages?view=replies', owner)).text();
  assert.match(page, /Is MTN data working now\?/);
  assert.match(page, /Replies \(1\)/);

  // Answer it on WhatsApp.
  const inId = row.id;
  assert.match(loc(await post(`/dashboard/replies/${inId}`, { _csrf: csrf, body: 'Yes, it is working now!' }, owner)), /ok=Reply sent/);
  assert.deepEqual(sentWa.at(-1), { messaging_product: 'whatsapp', to: '2348031112222', type: 'text', text: { body: 'Yes, it is working now!' } });
  assert.match(await (await get('/dashboard/messages?view=replies', owner)).text(), /You:<\/b> Yes, it is working now!/);
  // Outside the 24-hour window.
  await waPost(p.id, waMsg('2348031112222', 'old one', 'wamid.old'));
  app.db.run('UPDATE inbound SET received_at = ? WHERE provider_id = ?', Date.now() - 25 * 3600e3, 'wamid.old');
  const oldId = app.db.get('SELECT id FROM inbound WHERE provider_id = ?', 'wamid.old').id;
  assert.match(loc(await post(`/dashboard/replies/${oldId}`, { _csrf: csrf, body: 'late' }, owner)), /within 24 hours/);

  // STOP opts them out, cancels pending messages and confirms on WhatsApp.
  app.db.run("INSERT INTO messages (id, project_id, person_id, lead_type, channel, body, score, confidence, status, drafted_by, created_at) VALUES ('msg_pending', ?, ?, 'never_bought', 'whatsapp', 'hi', 50, .9, 'approved', 'template', ?)", p.id, pid, Date.now());
  await waPost(p.id, waMsg('2348031112222', 'STOP', 'wamid.stop'));
  assert.equal(app.db.get('SELECT opted_out FROM persons WHERE id = ?', pid).opted_out, 1);
  assert.equal(app.db.get("SELECT status FROM messages WHERE id = 'msg_pending'").status, 'rejected');
  assert.match(sentWa.at(-1).text.body, /won't get any more messages from Ada Data/);

  // Messages for another business's WhatsApp number are ignored.
  const elsewhere = waMsg('2348039999999', 'hi', 'wamid.x'); elsewhere.entry[0].changes[0].value.metadata.phone_number_id = '999';
  assert.equal((await (await waPost(p.id, elsewhere)).json()).stored, 0);
  // Another business can't answer this business's replies.
  const boss = await login('boss@other.ng');
  const bossCsrf = await csrfOf(boss);
  assert.match(loc(await post(`/dashboard/replies/${inId}`, { _csrf: bossCsrf, body: 'x' }, boss)), /not found/);
});

test('the scheduler emails the owner about new replies', async () => {
  mails.length = 0;
  app.db.run('UPDATE projects SET last_reply_notice_at = 0 WHERE id = ?', p.id);
  await app.scheduler.tick({ now: Date.now() });
  assert.ok(mails.some((m) => /new repl/.test(m.subject) && m.to === 'owner@ada.ng'));
});

test('team: invite, resend, remove; never yourself, the admin, or another business\'s people', async () => {
  mails.length = 0;
  assert.match(loc(await post('/dashboard/team', { _csrf: csrf, email: 'staff@ada.ng' }, owner)), /ok=Invite emailed to staff@ada\.ng/);
  assert.equal(mails[0].to, 'staff@ada.ng');
  assert.match(loc(await post('/dashboard/team', { _csrf: csrf, email: 'boss@other.ng' }, owner)), /already has a RecoverKit login/);
  const staff = app.accounts.byEmail('staff@ada.ng');
  assert.equal(staff.project_id, p.id);
  const resent = await post(`/dashboard/team/${staff.id}/resend`, { _csrf: csrf }, owner);
  assert.match(await resent.text(), /\/reset\//, 'the invite link is shown too');
  const me = app.accounts.byEmail('owner@ada.ng');
  assert.match(loc(await post(`/dashboard/team/${me.id}/remove`, { _csrf: csrf }, owner)), /can't remove yourself/);
  const bossUser = app.accounts.byEmail('boss@other.ng');
  assert.equal((await post(`/dashboard/team/${bossUser.id}/remove`, { _csrf: csrf }, owner)).status, 404);
  assert.match(loc(await post(`/dashboard/team/${staff.id}/remove`, { _csrf: csrf }, owner)), /ok=staff@ada\.ng was removed/);
  assert.equal(app.accounts.byEmail('staff@ada.ng'), null);

  // The server admin's login can't be removed by their colleagues.
  app.projects.createUser(p.id, 'colleague@ada.ng', PW);
  app.accounts.setAdmin('owner@ada.ng');
  const col = await login('colleague@ada.ng');
  assert.match(loc(await post(`/dashboard/team/${me.id}/remove`, { _csrf: await csrfOf(col), email: '' }, col)), /server admin can't be removed/);
  app.accounts.setAdmin('owner@ada.ng', false);
});

test('delete business: needs the exact name and password; removes everything; not the admin\'s', async () => {
  const boss = await login('boss@other.ng');
  const c = await csrfOf(boss);
  assert.match(loc(await post('/dashboard/delete-business', { _csrf: c, confirmName: 'other', password: PW }, boss)), /doesn't match/);
  assert.match(loc(await post('/dashboard/delete-business', { _csrf: c, confirmName: 'Other', password: 'wrong-password-123' }, boss)), /password is wrong/);
  const r = await post('/dashboard/delete-business', { _csrf: c, confirmName: 'Other', password: PW }, boss);
  assert.match(loc(r), /^\/login\?ok=Other and all its data were deleted/);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(app.projects.byId(other.id), null);
  assert.equal(app.accounts.byEmail('boss@other.ng'), null);
  assert.equal((await get('/dashboard', boss)).headers.get('location'), '/login', 'signed out');

  app.accounts.setAdmin('owner@ada.ng');
  const o = await login('owner@ada.ng');
  assert.ok(!(await (await get('/dashboard/settings', o)).text()).includes('Delete this business'), 'no delete option for the admin\'s own business');
  assert.match(loc(await post('/dashboard/delete-business', { _csrf: await csrfOf(o), confirmName: 'Ada Data', password: PW }, o)), /belongs to the server admin/);
  assert.ok(app.projects.byId(p.id));
  app.accounts.setAdmin('owner@ada.ng', false);
});

test('first-steps checklist and automation settings', async () => {
  const fresh = app.projects.create({ name: 'New Shop' });
  app.projects.createUser(fresh.id, 'new@shop.ng', PW);
  const s = await login('new@shop.ng');
  const html = await (await get('/dashboard', s)).text();
  assert.match(html, /Get set up · 0 of 6 done/);
  assert.match(html, /Add the RecoverKit script to your website/);
  const c = await csrfOf(s);
  await post('/dashboard/settings', { _csrf: c, voiceProfile: 'Friendly', paymentLink: '', allowedOrigins: '', requireApproval: '1' }, s);
  assert.match(await (await get('/dashboard', s)).text(), /Get set up · 1 of 6 done/);

  assert.match(loc(await post('/dashboard/automation', { _csrf: c, autoDraft: '1', notifyEmail: '1', sendFrom: '8', sendTo: '20' }, s)), /ok=Saved/);
  const row = app.projects.byId(fresh.id);
  assert.deepEqual([row.auto_draft, row.auto_send, row.notify_email, row.send_from, row.send_to], [1, 0, 1, 8, 20]);
  assert.match(loc(await post('/dashboard/automation', { _csrf: c, sendFrom: '8', sendTo: '8' }, s)), /at least one hour/);
});

test('discard all waiting drafts, then those people can be drafted again', async () => {
  const s = await login('owner@ada.ng');
  const c = await csrfOf(s);
  const pid = app.people.resolve(p.id, identityHashes(p.public_key, { email: 'redraft@ada.ng' }), Date.now());
  app.db.run("INSERT INTO messages (id, project_id, person_id, lead_type, channel, body, score, confidence, status, drafted_by, created_at) VALUES ('msg_d1', ?, ?, 'never_bought', 'console', 'old style', 50, .9, 'draft', 'template', ?)", p.id, pid, Date.now());
  assert.match(await (await get('/dashboard/messages', s)).text(), /Discard all \d+ waiting drafts/);
  assert.match(loc(await post('/dashboard/drafts/discard', { _csrf: c }, s)), /ok=Discarded \d+ draft/);
  assert.equal(app.db.get("SELECT status FROM messages WHERE id = 'msg_d1'").status, 'rejected');
  assert.equal(app.db.get("SELECT COUNT(*) n FROM messages WHERE project_id = ? AND status = 'draft'", p.id).n, 0);
  assert.equal((await post('/dashboard/drafts/discard', { _csrf: 'x' }, s)).status, 403);
});
