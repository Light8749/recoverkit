// The follow-up email channel: SMTP and five APIs, the private-network block, and the Channels page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendEmail, validateEmailConfig, emailReady, parseFrom } from '../src/email.js';
import { createApp } from '../src/server.js';

const MSG = { to: 'ada@shop.ng', subject: 'A quick note from Padi', body: 'Hi Ada, your wallet is ready.', unsubscribeUrl: 'https://rk.example/u/abc.def', unsubscribeText: 'Stop: https://rk.example/u/abc.def' };
function recorder(status = 200, reply = { id: 'm1' }) {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(reply), { status }); } };
}

test('From parsing and config validation', () => {
  assert.deepEqual(parseFrom('PadiConnect <hello@padi.ng>'), { name: 'PadiConnect', email: 'hello@padi.ng' });
  assert.deepEqual(parseFrom('hello@padi.ng'), { name: '', email: 'hello@padi.ng' });
  assert.equal(parseFrom('Padi <nope>'), null);
  assert.throws(() => validateEmailConfig({ provider: 'resend', from: 'x', apiKey: 're_1234567890' }), /From/);
  assert.throws(() => validateEmailConfig({ provider: 'mailgun', from: 'a@b.ng', apiKey: 'key-1234567890' }), /sending domain/);
  assert.throws(() => validateEmailConfig({ provider: 'smtp', from: 'a@b.ng', smtpHost: '127.0.0.1', smtpUser: 'u', smtpPass: 'p' }), /host name/);
  assert.throws(() => validateEmailConfig({ provider: 'smtp', from: 'a@b.ng', smtpHost: 'mail.b.ng', smtpPort: 3306, smtpUser: 'u', smtpPass: 'p' }), /port/);
  const ok = validateEmailConfig({ provider: 'smtp', from: 'Padi <hi@padi.ng>', smtpHost: 'Mail.Padi.NG', smtpPort: '465', smtpUser: 'hi@padi.ng', smtpPass: 'pw', apiKey: 'leftover' });
  assert.deepEqual(ok, { provider: 'smtp', from: 'Padi <hi@padi.ng>', smtpHost: 'mail.padi.ng', smtpPort: 465, smtpUser: 'hi@padi.ng', smtpPass: 'pw' }, 'fields of other providers are dropped');
  assert.ok(emailReady({ apiKey: 're_x', from: 'a@b.ng' }), 'old Resend settings keep working');
});

test('each API gets the right request, with the unsubscribe header', async () => {
  const cases = [
    ['resend', {}, 'https://api.resend.com/emails', (b, h) => { assert.equal(h.Authorization, 'Bearer KEY12345678'); assert.deepEqual(b.to, ['ada@shop.ng']); assert.equal(b.headers['List-Unsubscribe'], '<https://rk.example/u/abc.def>'); }],
    ['brevo', {}, 'https://api.brevo.com/v3/smtp/email', (b, h) => { assert.equal(h['api-key'], 'KEY12345678'); assert.deepEqual(b.sender, { name: 'Padi', email: 'hi@padi.ng' }); assert.match(b.textContent, /Stop: https/); }],
    ['sendgrid', {}, 'https://api.sendgrid.com/v3/mail/send', (b) => { assert.deepEqual(b.personalizations, [{ to: [{ email: 'ada@shop.ng' }] }]); assert.equal(b.content[0].type, 'text/plain'); }],
    ['postmark', {}, 'https://api.postmarkapp.com/email', (b, h) => { assert.equal(h['X-Postmark-Server-Token'], 'KEY12345678'); assert.equal(b.To, 'ada@shop.ng'); assert.equal(b.Headers[0].Name, 'List-Unsubscribe'); }],
    ['mailgun', { domain: 'mg.padi.ng', region: 'eu' }, 'https://api.eu.mailgun.net/v3/mg.padi.ng/messages', (b, h, raw) => {
      assert.equal(h.Authorization, `Basic ${Buffer.from('api:KEY12345678').toString('base64')}`);
      const f = new URLSearchParams(raw); assert.equal(f.get('to'), 'ada@shop.ng'); assert.equal(f.get('h:List-Unsubscribe'), '<https://rk.example/u/abc.def>');
    }],
  ];
  for (const [provider, extra, url, check] of cases) {
    const rec = recorder(provider === 'sendgrid' ? 202 : 200);
    const r = await sendEmail({ provider, from: 'Padi <hi@padi.ng>', apiKey: 'KEY12345678', ...extra }, MSG, { fetch: rec.fetch });
    assert.equal(r.ok, true, provider);
    assert.equal(rec.calls[0].url, url, provider);
    const raw = rec.calls[0].init.body;
    check(provider === 'mailgun' ? null : JSON.parse(raw), rec.calls[0].init.headers, raw);
  }
  const bad = recorder(401, { errors: [{ message: 'The provided authorization grant is invalid' }] });
  assert.deepEqual(await sendEmail({ provider: 'sendgrid', from: 'hi@padi.ng', apiKey: 'KEY12345678' }, MSG, { fetch: bad.fetch }), { ok: false, error: 'sendgrid 401: The provided authorization grant is invalid' });
  const resend = recorder(403, { statusCode: 403, message: 'The padi.ng domain is not verified. Please, add and verify your domain on https://resend.com/domains', name: 'validation_error' });
  const r403 = await sendEmail({ provider: 'resend', from: 'hi@padi.ng', apiKey: 're_secretkey123456' }, MSG, { fetch: resend.fetch });
  assert.match(r403.error, /^resend 403: The padi\.ng domain is not verified/);
});

test('SMTP: sends through the business\'s mail server, but never to a private or local address', async () => {
  const got = { lines: [], data: '' };
  const server = net.createServer((s) => {
    let buf = ''; let inData = false;
    s.write('220 fake\r\n');
    s.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; s.write('250 ok\r\n'); } else got.data += line + '\r\n'; continue; }
        got.lines.push(line);
        if (/^EHLO/.test(line)) s.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH/.test(line)) s.write('235 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); }
        else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
        else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cfg = { provider: 'smtp', from: 'Padi <hi@padi.ng>', smtpHost: 'localhost', smtpPort: port, smtpUser: 'hi@padi.ng', smtpPass: 'pw' };
  // The real setting: a private address is refused before connecting.
  const blocked = await sendEmail(cfg, MSG, { resolver: async () => [{ address: '127.0.0.1' }] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /public address/);
  assert.equal(got.lines.length, 0, 'nothing was sent to the local server');
  const internal = await sendEmail({ ...cfg, smtpHost: 'mail.padi.ng' }, MSG, { resolver: async () => [{ address: '10.0.0.5' }] });
  assert.match(internal.error, /public address/);
  // With the check relaxed (tests only), the message goes through with the unsubscribe headers.
  const r = await sendEmail(cfg, MSG, { resolver: async () => [{ address: '127.0.0.1' }], allowPrivate: true });
  server.close();
  assert.deepEqual(r, { ok: true });
  assert.ok(got.lines.includes('MAIL FROM:<hi@padi.ng>') && got.lines.includes('RCPT TO:<ada@shop.ng>'));
  assert.match(got.data, /^From: Padi <hi@padi\.ng>\r\nTo: ada@shop\.ng\r\nSubject: A quick note from Padi\r\n/);
  assert.match(got.data, /List-Unsubscribe: <https:\/\/rk\.example\/u\/abc\.def>\r\n/);
  assert.match(got.data, /Hi Ada, your wallet is ready\.\r\n\r\nStop: https/);
});

test('Channels page: choose a provider, keep saved secrets, send a test email', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-email-'));
  const rec = recorder(200, { id: 'test-1' });
  const config = { masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 't.db'), publicUrl: 'http://127.0.0.1', trustProxy: false, ai: { provider: 'none' }, attributionDays: 7, feePercent: 0, minDaysBetweenMessages: 7, scheduler: false };
  const app = await createApp({ config, fetch: rec.fetch, logger: { log() {}, warn() {}, error() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  config.publicUrl = base;
  const p = app.projects.create({ name: 'Padi' });
  app.projects.createUser(p.id, 'owner@padi.ng', 'owner-password-long-1');
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'owner@padi.ng', password: 'owner-password-long-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (path, body) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const loc = (r) => decodeURIComponent(r.headers.get('location') || '');
  const page = await (await fetch(base + '/dashboard/channels', { headers: { Cookie: cookie } })).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)[1];
  assert.match(page, /Postmark \(API\)/);
  assert.match(page, /SMTP \(any mail server/);

  assert.match(loc(await post('/dashboard/channels', { _csrf: csrf, email_provider: 'brevo', email_from: 'Padi <hi@padi.ng>' })), /Email: Enter your Brevo API key/);
  assert.match(loc(await post('/dashboard/channels', { _csrf: csrf, email_provider: 'brevo', email_from: 'Padi <hi@padi.ng>', email_apiKey: 'xkeysib-1234567890' })), /ok=Saved/);
  // Saving again without the key keeps it.
  assert.match(loc(await post('/dashboard/channels', { _csrf: csrf, email_provider: 'brevo', email_from: 'PadiConnect <hi@padi.ng>' })), /ok=Saved/);
  const saved = app.projects.getChannels(app.projects.byId(p.id)).email;
  assert.deepEqual([saved.provider, saved.from, saved.apiKey], ['brevo', 'PadiConnect <hi@padi.ng>', 'xkeysib-1234567890']);
  assert.ok(!(await (await fetch(base + '/dashboard/channels', { headers: { Cookie: cookie } })).text()).includes('xkeysib-1234567890'), 'secrets never shown');

  const t = await post('/dashboard/channels/test-email', { _csrf: csrf });
  assert.match(loc(t), /ok=Test email sent to owner@padi\.ng/);
  assert.equal(rec.calls.at(-1).url, 'https://api.brevo.com/v3/smtp/email');
  assert.deepEqual(JSON.parse(rec.calls.at(-1).init.body).to, [{ email: 'owner@padi.ng' }]);

  // Switching to SMTP needs its own fields; a private server name is refused when saving.
  assert.match(loc(await post('/dashboard/channels', { _csrf: csrf, email_provider: 'smtp', email_smtpHost: '192.168.1.10', email_smtpUser: 'u', email_smtpPass: 'p' })), /Email: SMTP server must be a host name/);
  await app.close(); rmSync(dir, { recursive: true, force: true });
});
