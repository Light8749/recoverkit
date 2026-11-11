// Password change, forgot/reset links, invites and the Admin pages, over real HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { buildMessage, createMailer } from '../src/mailer.js';

let app, base, dir, owner, other, cfg;
const mails = [];
const mailer = { enabled: true, mode: 'test', send: async (m) => { mails.push(m); return { ok: true }; } };
const PW = 'owner-password-long-1';
const linkIn = (text) => /\/reset\/([A-Za-z0-9_-]+)/.exec(text)?.[1];

async function login(email, password) {
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }) });
  const c = r.headers.get('set-cookie');
  return { location: r.headers.get('location'), cookie: c ? c.split(';')[0] : null };
}
const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
const csrfOf = async (path, cookie) => /name="_csrf" value="([^"]+)"/.exec(await (await get(path, cookie)).text())?.[1];
const post = (path, body, cookie) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(body) });
const msg = (r) => decodeURIComponent(r.headers.get('location') || '');

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rk-acct-'));
  const config = { masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 't.db'), publicUrl: 'http://127.0.0.1', trustProxy: false, ai: { provider: 'none' }, attributionDays: 7, feePercent: 10, minDaysBetweenMessages: 7 };
  cfg = config;
  app = await createApp({ config, mailer, logger: { log() {}, warn() {}, error() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  config.publicUrl = base;
  const p = app.projects.create({ name: 'Padi VTU', gatewayMode: 'deposits' });
  owner = { email: 'admin@padi.ng', id: app.projects.createUser(p.id, 'admin@padi.ng', PW), project: p.id };
  const q = app.projects.create({ name: 'Other Shop' });
  other = { email: 'shop@other.ng', id: app.projects.createUser(q.id, 'shop@other.ng', 'other-password-long-1'), project: q.id };
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

test('forgot password: same answer for any email, one-time link, signs out everywhere', async () => {
  const s1 = (await login(other.email, 'other-password-long-1')).cookie;
  assert.ok(s1);
  mails.length = 0;
  const unknown = await post('/forgot', { email: 'nobody@nowhere.ng' });
  const known = await post('/forgot', { email: 'Shop@Other.ng ' });
  assert.equal(msg(unknown), msg(known), 'no account enumeration');
  assert.ok(!msg(known).includes('@'), 'no email address in the URL');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, other.email);
  const token = linkIn(mails[0].text);
  assert.ok(token);
  assert.equal(app.db.get('SELECT COUNT(*) n FROM password_tokens WHERE token_hash = ?', token).n, 0, 'only the hash is stored');

  assert.equal((await get(`/reset/${token}`)).status, 200);
  assert.match(msg(await post(`/reset/${token}`, { password: 'short', confirm: 'short' })), /12 characters/);
  assert.match(msg(await post(`/reset/${token}`, { password: 'a-new-password-123', confirm: 'different-password-1' })), /match/);
  assert.equal((await post(`/reset/${token}`, { password: 'a-new-password-123', confirm: 'a-new-password-123' }, null)).headers.get('location').startsWith('/login?ok='), true);
  assert.equal((await get('/dashboard', s1)).headers.get('location'), '/login', 'old session signed out');
  assert.equal((await login(other.email, 'other-password-long-1')).cookie, null, 'old password gone');
  assert.ok((await login(other.email, 'a-new-password-123')).cookie);
  assert.equal((await get(`/reset/${token}`)).status, 410, 'link works once');
  assert.match(mails.at(-1).subject, /was changed/);

  // A newer link cancels the older one; links expire; garbage is rejected; cross-site posts blocked.
  await app.limiter.reset?.('forgot-email:shop@other.ng');
  const t1 = app.accounts.issue(other.id, 'reset');
  const t2 = app.accounts.issue(other.id, 'reset');
  assert.equal(app.accounts.lookup(t1), null);
  assert.ok(app.accounts.lookup(t2));
  app.db.run('UPDATE password_tokens SET expires_at = ? WHERE user_id = ?', Date.now() - 1, other.id);
  assert.equal(app.accounts.lookup(t2), null);
  assert.equal((await get('/reset/not-a-token')).status, 410);
  const evil = await fetch(base + '/forgot', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' }, body: 'email=shop@other.ng' });
  assert.equal(evil.status, 403);
});

test('forgot password is rate limited per email', async () => {
  mails.length = 0;
  for (let i = 0; i < 5; i++) await post('/forgot', { email: 'admin@padi.ng' });
  assert.equal(mails.length, 3);
});

test('change password: needs the current one, keeps this session, signs out others', async () => {
  const a = (await login(owner.email, PW)).cookie;
  const b = (await login(owner.email, PW)).cookie;
  const csrf = await csrfOf('/dashboard/settings', a);
  assert.match(msg(await post('/dashboard/password', { _csrf: csrf, currentPassword: 'wrong-password-123', newPassword: 'owner-password-new-2', confirm: 'owner-password-new-2' }, a)), /current password is wrong/);
  assert.equal((await post('/dashboard/password', { _csrf: 'bad', currentPassword: PW, newPassword: 'owner-password-new-2', confirm: 'owner-password-new-2' }, a)).status, 403);
  assert.match(msg(await post('/dashboard/password', { _csrf: csrf, currentPassword: PW, newPassword: 'owner-password-new-2', confirm: 'owner-password-new-2' }, a)), /ok=Password changed/);
  assert.equal((await get('/dashboard', a)).status, 200, 'this session stays');
  assert.equal((await get('/dashboard', b)).headers.get('location'), '/login', 'other sessions signed out');
  assert.ok((await login(owner.email, 'owner-password-new-2')).cookie);
  owner.password = 'owner-password-new-2';
});

test('admin: only admins, add a business with an invite, invite sets the first password', async () => {
  const pw = owner.password || PW;
  let s = (await login(owner.email, pw)).cookie;
  assert.equal((await get('/admin', s)).status, 403, 'not an admin yet');
  const csrf0 = await csrfOf('/dashboard/settings', s);
  assert.equal((await post('/admin/businesses', { _csrf: csrf0, name: 'Sneaky', mode: 'sales', email: 'x@y.ng' }, s)).status, 403);

  app.accounts.setAdmin(owner.email);
  s = (await login(owner.email, pw)).cookie;
  const page = await (await get('/admin', s)).text();
  assert.match(page, /Add a business/);
  assert.match(page, /Padi VTU/);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)[1];

  mails.length = 0;
  const made = await post('/admin/businesses', { _csrf: csrf, name: 'Bola Data <b>', mode: 'deposits', email: 'Bola@BolaData.ng' }, s);
  assert.equal(made.status, 200);
  const html = await made.text();
  assert.match(html, /Bola Data &lt;b&gt;/, 'escaped');
  assert.match(html, /Invite emailed to bola@boladata\.ng/);
  const p = app.db.get("SELECT * FROM projects WHERE name = 'Bola Data <b>'");
  assert.equal(p.gateway_mode, 'deposits');
  assert.equal(app.db.get('SELECT COUNT(*) n FROM api_keys WHERE project_id = ?', p.id).n, 0, 'no unknown secret key is created');
  assert.equal(mails[0].to, 'bola@boladata.ng');
  const token = linkIn(mails[0].text);
  assert.ok(html.includes(`/reset/${token}`), 'the link is also shown to copy');

  assert.match(msg(await post('/admin/businesses', { _csrf: csrf, name: 'Dup', mode: 'sales', email: 'bola@boladata.ng' }, s)), /already has a RecoverKit login/);
  assert.equal(app.db.get("SELECT COUNT(*) n FROM projects WHERE name = 'Dup'").n, 0, 'nothing half-created');

  assert.equal((await login('bola@boladata.ng', '')).cookie, null, 'no password yet, no login');
  assert.match(await (await get(`/reset/${token}`)).text(), /Choose your password/);
  await post(`/reset/${token}`, { password: 'bola-password-long-1', confirm: 'bola-password-long-1' });
  const bola = (await login('bola@boladata.ng', 'bola-password-long-1')).cookie;
  const dash = await (await get('/dashboard', bola)).text();
  assert.match(dash, /Bola Data &lt;b&gt;/, 'lands in their own business');
  assert.equal((await get('/admin', bola)).status, 403);
  assert.ok(!dash.includes('href="/admin"'), 'no admin link for non-admins');

  // The test email goes to the admin who clicked it.
  mails.length = 0;
  assert.match(msg(await post('/admin/mail-test', { _csrf: csrf }, s)), /ok=Sent to admin@padi\.ng/);
  assert.equal(mails[0].to, 'admin@padi.ng');
  assert.equal((await post('/admin/mail-test', { _csrf: 'x' }, bola)).status, 403);

  // Add a colleague, and make a reset link for an existing login.
  mails.length = 0;
  const added = await post(`/admin/businesses/${p.id}/users`, { _csrf: csrf, email: 'staff@boladata.ng' }, s);
  assert.match(await added.text(), /staff@boladata\.ng/);
  assert.equal(app.db.get('SELECT project_id FROM users WHERE email = ?', 'staff@boladata.ng').project_id, p.id);
  const bolaUser = app.accounts.byEmail('bola@boladata.ng');
  const linked = await post(`/admin/users/${bolaUser.id}/link`, { _csrf: csrf }, s);
  assert.match(await linked.text(), /Reset link emailed to bola@boladata\.ng/);
  assert.equal(mails.at(-1).to, 'bola@boladata.ng');
  assert.equal((await post(`/admin/users/${bolaUser.id}/link`, { _csrf: 'x' }, bola)).status, 403, 'non-admins cannot make links');
});

test('admin without email: links are shown to send by hand', async () => {
  const off = createMailer({ mode: 'none' });
  assert.equal(off.enabled, false);
  assert.equal((await off.send({ to: 'a@b.co', subject: 's', text: 't' })).ok, false);
});

test('sendmail mode pipes a well-formed message to sendmail -t -i', async () => {
  const { writeFileSync, readFileSync, chmodSync } = await import('node:fs');
  const out = join(dir, 'sent.eml');
  const fake = join(dir, 'fake-sendmail');
  writeFileSync(fake, `#!/bin/sh\necho "$@" > "${out}.args"\ncat > "${out}"\n`);
  chmodSync(fake, 0o755);
  const m = createMailer({ mode: 'sendmail', from: 'RecoverKit <no-reply@padi.ng>', path: fake });
  assert.deepEqual(await m.send({ to: 'ada@shop.ng', subject: 'Reset your RecoverKit password', text: 'Hello\nLink' }), { ok: true });
  assert.equal(readFileSync(out + '.args', 'utf8').trim(), '-t -i');
  assert.match(readFileSync(out, 'utf8'), /^From: RecoverKit <no-reply@padi\.ng>\r\nTo: ada@shop\.ng\r\n/);
  assert.equal((await createMailer({ mode: 'sendmail', from: 'x@y.ng', path: join(dir, 'missing') }, { logger: { warn() {} } }).send({ to: 'a@b.ng', subject: 's', text: 't' })).ok, false);
});

test('mailer refuses header injection', () => {
  assert.throws(() => buildMessage({ from: 'R <r@x.ng>', to: 'a@b.ng\r\nBcc: evil@x.ng', subject: 'Hi', text: 'x' }), /bad email header/);
  assert.throws(() => buildMessage({ from: 'R <r@x.ng>', to: 'a@b.ng', subject: 'Hi\nBcc: evil@x.ng', text: 'x' }), /bad email header/);
  const m = buildMessage({ from: 'R <r@x.ng>', to: 'a@b.ng', subject: 'Hi', text: 'line1\nline2' });
  assert.match(m, /^From: R <r@x\.ng>\r\nTo: a@b\.ng\r\nSubject: Hi\r\n/);
  assert.match(m, /line1\r\nline2/);
});

test('sign-up: closed by default, open with RK_SIGNUP=open, confirm by email, then sign in', async () => {
  assert.equal((await get('/signup')).status, 404, 'invite-only by default');
  assert.ok(!(await (await get('/login')).text()).includes('/signup'));
  cfg.signup = 'open';
  assert.match(await (await get('/login')).text(), /Create an account/);
  assert.equal((await get('/signup')).status, 200);

  mails.length = 0;
  const r = await post('/signup', { name: 'Tunde Airtime', mode: 'deposits', email: 'Tunde@Airtime.ng' });
  assert.match(msg(r), /ok=Check your email/);
  assert.ok(!msg(r).includes('@'), 'no email in the URL');
  const p = app.db.get("SELECT * FROM projects WHERE name = 'Tunde Airtime'");
  assert.equal(p.source, 'signup');
  assert.equal(p.gateway_mode, 'deposits');
  assert.equal(app.db.get('SELECT COUNT(*) n FROM api_keys WHERE project_id = ?', p.id).n, 0);
  assert.equal(mails[0].to, 'tunde@airtime.ng');
  assert.equal((await login('tunde@airtime.ng', '')).cookie, null, 'no login before confirming');
  const token = linkIn(mails[0].text);
  await post(`/reset/${token}`, { password: 'tunde-password-long-1', confirm: 'tunde-password-long-1' });
  const s = (await login('tunde@airtime.ng', 'tunde-password-long-1')).cookie;
  assert.match(await (await get('/dashboard', s)).text(), /Tunde Airtime/);
  assert.equal((await get('/admin', s)).status, 403, 'sign-ups are never admins');

  // Same answer for an email that already has a login; it gets a "you already have an account" note instead.
  mails.length = 0;
  const again = await post('/signup', { name: 'Copycat', mode: 'sales', email: 'tunde@airtime.ng' });
  assert.equal(msg(again), msg(r));
  assert.equal(app.db.get("SELECT COUNT(*) n FROM projects WHERE name = 'Copycat'").n, 0);
  assert.match(mails[0].subject, /already have/);

  // Bots that fill the hidden field get the same answer and create nothing.
  mails.length = 0;
  assert.equal(msg(await post('/signup', { name: 'Bot', mode: 'sales', email: 'bot@spam.ng', website: 'http://spam' })), msg(r));
  assert.equal(app.db.get("SELECT COUNT(*) n FROM projects WHERE name = 'Bot'").n, 0);
  assert.equal(mails.length, 0);

  // Bad input, cross-site posts.
  assert.match(msg(await post('/signup', { name: '', mode: 'sales', email: 'x@y.ng' })), /business name/);
  assert.match(msg(await post('/signup', { name: 'X', mode: 'nope', email: 'x2@y.ng' })), /kind of payments/);
  const evil = await fetch(base + '/signup', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' }, body: 'name=a&mode=sales&email=a@b.ng' });
  assert.equal(evil.status, 403);

  // Sign-ups that never confirm are removed once their link has expired; confirmed ones stay.
  await post('/signup', { name: 'Ghost Shop', mode: 'sales', email: 'ghost@shop.ng' });
  const ghost = app.db.get("SELECT id FROM projects WHERE name = 'Ghost Shop'");
  app.db.run('UPDATE projects SET created_at = ? WHERE id IN (?, ?)', Date.now() - 9 * 864e5, ghost.id, p.id);
  app.purgeOld();
  assert.ok(app.db.get('SELECT id FROM projects WHERE id = ?', ghost.id), 'kept while its link still works');
  app.db.run('UPDATE password_tokens SET expires_at = ? WHERE user_id IN (SELECT id FROM users WHERE project_id = ?)', Date.now() - 1, ghost.id);
  app.purgeOld();
  assert.equal(app.db.get('SELECT id FROM projects WHERE id = ?', ghost.id), undefined, 'unconfirmed sign-up removed');
  assert.equal(app.db.get('SELECT COUNT(*) n FROM users WHERE email = ?', 'ghost@shop.ng').n, 0);
  assert.ok(app.db.get('SELECT id FROM projects WHERE id = ?', p.id), 'confirmed account kept');
  cfg.signup = 'off';
});

test('sign-up is rate limited per IP', async () => {
  cfg.signup = 'open';
  app.limiter.reset('signup-ip:127.0.0.1');
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push(msg(await post('/signup', { name: `Flood ${i}`, mode: 'sales', email: `flood${i}@x.ng` })).includes('Too many') ? 'limited' : 'ok');
  assert.deepEqual(codes, ['ok', 'ok', 'ok', 'ok', 'ok', 'limited', 'limited']);
  cfg.signup = 'off';
});
