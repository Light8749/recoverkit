// SMTP sender against a fake SMTP server: STARTTLS, implicit TLS, AUTH, dot-stuffing, refusals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smtpSend, addressOf } from '../src/smtp.js';
import { createMailer, mailFromEnv } from '../src/mailer.js';

let dir, key, cert;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'rk-smtp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  key = readFileSync(join(dir, 'k.pem')); cert = readFileSync(join(dir, 'c.pem'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** A tiny SMTP server. mode: 'starttls' | 'implicit' | 'plain'. Records what it received. */
function fakeServer({ mode = 'starttls', authOk = true } = {}) {
  const got = { lines: [], data: '', tls: false, auth: null };
  const handle = (sock, secure) => {
    let buf = ''; let inData = false;
    const say = (s) => sock.write(s + '\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; say('250 queued'); } else got.data += line + '\r\n';
          continue;
        }
        got.lines.push(line);
        if (/^EHLO/.test(line)) { sock.write(`250-fake\r\n${mode === 'starttls' && !secure ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN LOGIN\r\n`); }
        else if (line === 'STARTTLS') {
          say('220 go ahead');
          sock.removeAllListeners('data');
          const t = new tls.TLSSocket(sock, { isServer: true, key, cert });
          got.tls = true;
          handle(t, true);
          return;
        } else if (/^AUTH PLAIN /.test(line)) { got.auth = Buffer.from(line.slice(11), 'base64').toString(); say(authOk ? '235 ok' : '535 bad credentials'); }
        else if (/^MAIL FROM/.test(line) || /^RCPT TO/.test(line)) say('250 ok');
        else if (line === 'DATA') { inData = true; say('354 send it'); }
        else if (line === 'QUIT') { say('221 bye'); sock.end(); }
      }
    });
    if (!secure || mode === 'implicit') say('220 fake ESMTP');
  };
  const server = mode === 'implicit'
    ? tls.createServer({ key, cert }, (s) => { got.tls = true; handle(s, true); })
    : net.createServer((s) => handle(s, false));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, port: server.address().port })));
}

const trust = { tlsOptions: { rejectUnauthorized: false } }; // self-signed test certificate only
const MSG = 'From: R <no-reply@padi.ng>\r\nTo: ada@shop.ng\r\nSubject: Hi\r\n\r\nline one\r\n.starts with a dot\r\n';

test('STARTTLS on 587-style ports: upgrades before logging in, dot-stuffs the body', async () => {
  const { server, got, port } = await fakeServer({ mode: 'starttls' });
  const r = await smtpSend({ host: 'mail.test', connectHost: '127.0.0.1', port, user: 'me@smtp-brevo.com', pass: 'smtp-key', ...trust }, { from: 'no-reply@padi.ng', to: 'ada@shop.ng' }, MSG);
  server.close();
  assert.deepEqual(r, { ok: true });
  assert.equal(got.tls, true);
  assert.ok(got.lines.indexOf('STARTTLS') < got.lines.findIndex((l) => l.startsWith('AUTH')), 'password only sent after TLS');
  assert.equal(got.auth, '\0me@smtp-brevo.com\0smtp-key');
  assert.ok(got.lines.includes('MAIL FROM:<no-reply@padi.ng>') && got.lines.includes('RCPT TO:<ada@shop.ng>'));
  assert.match(got.data, /\r\n\.\.starts with a dot\r\n/);
});

test('implicit TLS on port 465', async () => {
  const { server, got, port } = await fakeServer({ mode: 'implicit' });
  const r = await smtpSend({ host: 'localhost', connectHost: '127.0.0.1', port: 465, connectPort: port, ...trust }, { from: 'a@b.ng', to: 'c@d.ng' }, MSG);
  server.close();
  assert.deepEqual(r, { ok: true });
  assert.equal(got.tls, true);
  assert.ok(!got.lines.includes('STARTTLS'));
});

test('refuses to log in without encryption to a remote server, and reports bad credentials', async () => {
  const plain = await fakeServer({ mode: 'plain' });
  // A remote server that doesn't offer STARTTLS: refused before any password is sent.
  await assert.rejects(smtpSend({ host: 'smtp.example.com', connectHost: '127.0.0.1', port: plain.port, user: 'u', pass: 'secret' }, { from: 'a@b.ng', to: 'c@d.ng' }, MSG), /does not offer STARTTLS/);
  assert.ok(!plain.got.lines.some((l) => l.startsWith('AUTH')), 'no password sent');
  plain.got.lines.length = 0;
  const r = await smtpSend({ host: 'localhost', connectHost: '127.0.0.1', port: plain.port }, { from: 'a@b.ng', to: 'c@d.ng' }, MSG);
  assert.deepEqual(r, { ok: true }, 'localhost without TLS is allowed (a local relay)');
  plain.server.close();

  const bad = await fakeServer({ mode: 'starttls', authOk: false });
  await assert.rejects(smtpSend({ host: 'mail.test', connectHost: '127.0.0.1', port: bad.port, user: 'u', pass: 'wrong', ...trust }, { from: 'a@b.ng', to: 'c@d.ng' }, MSG), /login/);
  bad.server.close();
});

test('mailer: Brevo-style settings from env, and a full send through SMTP', async () => {
  const cfg = mailFromEnv({ RK_MAIL_FROM: 'RecoverKit <no-reply@padi.ng>', RK_SMTP_HOST: 'smtp-relay.brevo.com', RK_SMTP_USER: 'x@smtp-brevo.com', RK_SMTP_PASS: 'k' });
  assert.deepEqual({ mode: cfg.mode, host: cfg.host, port: cfg.port }, { mode: 'smtp', host: 'smtp-relay.brevo.com', port: 587 });
  assert.throws(() => mailFromEnv({ RK_MAIL_FROM: 'a@b.ng', RK_SMTP_HOST: 'bad host!' }), /host name/);
  assert.equal(addressOf('RecoverKit <no-reply@padi.ng>'), 'no-reply@padi.ng');

  const { server, got, port } = await fakeServer({ mode: 'starttls' });
  const m = createMailer({ mode: 'smtp', from: 'RecoverKit <no-reply@padi.ng>', host: 'mail.test', connectHost: '127.0.0.1', port, user: 'u', pass: 'p', ...trust });
  assert.deepEqual(await m.send({ to: 'ada@shop.ng', subject: 'Reset your RecoverKit password', text: 'Hello\nhttps://x/reset/abc' }), { ok: true });
  server.close();
  assert.match(got.data, /^From: RecoverKit <no-reply@padi\.ng>\r\nTo: ada@shop\.ng\r\nSubject: Reset your RecoverKit password\r\nDate: /);
  assert.match(got.data, /Message-ID: <.+@recoverkit>/);
  const quiet = createMailer({ mode: 'smtp', from: 'x@y.ng', host: 'localhost', port: 1 }, { logger: { warn() {} } });
  assert.equal((await quiet.send({ to: 'a@b.ng', subject: 's', text: 't' })).ok, false, 'connection errors are reported, not thrown');
});

test('mailer: Brevo HTTPS API (for hosts that block SMTP ports)', async () => {
  const cfg = mailFromEnv({ RK_MAIL_FROM: 'RecoverKit <no-reply@padi.ng>', RK_BREVO_API_KEY: 'xkeysib-test', RK_SMTP_HOST: 'smtp-relay.brevo.com' });
  assert.equal(cfg.mode, 'brevo', 'the API wins over SMTP when both are set');
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return new Response('{"messageId":"m1"}', { status: 201 }); };
  const m = createMailer(cfg, { fetch });
  assert.deepEqual(await m.send({ to: 'ada@shop.ng', subject: 'Reset your RecoverKit password', text: 'Hello' }), { ok: true });
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].init.headers['api-key'], 'xkeysib-test');
  assert.deepEqual(JSON.parse(calls[0].init.body), { sender: { name: 'RecoverKit', email: 'no-reply@padi.ng' }, to: [{ email: 'ada@shop.ng' }], subject: 'Reset your RecoverKit password', textContent: 'Hello' });
  const bad = createMailer(cfg, { fetch: async () => new Response('{"message":"Sender not valid"}', { status: 400 }) });
  assert.deepEqual(await bad.send({ to: 'ada@shop.ng', subject: 's', text: 't' }), { ok: false, error: 'brevo 400: Sender not valid' });
  assert.equal((await m.send({ to: 'a@b.ng\r\nBcc: x@y.ng', subject: 's', text: 't' })).ok, false, 'header checks still apply');
});

test('localhost (cPanel\'s own mail server): logs in without STARTTLS, since nothing leaves the machine', async () => {
  const { server, got, port } = await fakeServer({ mode: 'starttls' });
  const r = await smtpSend({ host: 'localhost', connectHost: '127.0.0.1', port, user: 'no-reply@padi.ng', pass: 'mailbox-pw' }, { from: 'no-reply@padi.ng', to: 'ada@shop.ng' }, MSG);
  server.close();
  assert.deepEqual(r, { ok: true });
  assert.equal(got.tls, false);
  assert.equal(got.auth, '\0no-reply@padi.ng\0mailbox-pw');
});
