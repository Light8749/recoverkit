// A small SMTP client (no dependencies) for system email: Brevo, Gmail, Zoho, a cPanel mailbox...
// Port 465 uses TLS from the start; any other port (587, 2525) must offer STARTTLS. Plain text
// connections are refused except to localhost, so a password never crosses the network unencrypted.
import net from 'node:net';
import tls from 'node:tls';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

/** Reads SMTP replies line by line; resolves with { code, text } for each complete (multi-line) reply. */
function replies(socket) {
  let buf = ''; const queue = []; const waiting = [];
  let failure = null;
  const push = (r) => (waiting.length ? waiting.shift().resolve(r) : queue.push(r));
  const fail = (e) => { failure = e; while (waiting.length) waiting.shift().reject(e); };
  const lines = [];
  const onData = (d) => {
    buf += d.toString('utf8');
    if (buf.length > 64 * 1024) return fail(new Error('SMTP reply too long'));
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) { push({ code: Number(line.slice(0, 3)), text: lines.join('\n') }); lines.length = 0; }
    }
  };
  return {
    attach(s) { s.on('data', onData); s.on('error', fail); s.on('close', () => fail(new Error('SMTP connection closed'))); },
    detach(s) { s.removeListener('data', onData); },
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
  };
}

/**
 * cfg: { host, port, user, pass, timeoutMs, tlsOptions }. Tests may set connectHost/connectPort to reach a
 * fake server while host/port still decide the TLS rules.
 * msg: the full RFC 5322 message (CRLF line endings); envelope: { from, to }
 */
export async function smtpSend(cfg, envelope, msg) {
  const port = Number(cfg.port || 587);
  const implicit = port === 465;
  const tlsOpts = { servername: cfg.host, minVersion: 'TLSv1.2', ...(cfg.tlsOptions || {}) };
  const target = { host: cfg.connectHost || cfg.host, port: cfg.connectPort || port };
  let socket = implicit ? tls.connect({ ...target, ...tlsOpts }) : net.connect(target);
  socket.setTimeout(cfg.timeoutMs || 20_000, () => socket.destroy(new Error('SMTP timed out')));
  let r = replies(socket);
  r.attach(socket);
  const send = (line) => socket.write(line + '\r\n');
  const expect = async (codes, what) => {
    const rep = await r.next();
    if (!codes.includes(rep.code)) throw new Error(`SMTP ${what} failed: ${rep.text.slice(0, 200)}`);
    return rep;
  };
  try {
    await expect([220], 'greeting');
    send('EHLO recoverkit');
    let ehlo = await expect([250], 'EHLO');
    if (!implicit) {
      if (/STARTTLS/i.test(ehlo.text)) {
        send('STARTTLS');
        await expect([220], 'STARTTLS');
        r.detach(socket);
        socket = await new Promise((resolve, reject) => {
          const t = tls.connect({ socket, ...tlsOpts }, () => resolve(t));
          t.once('error', reject);
        });
        r = replies(socket);
        r.attach(socket);
        send('EHLO recoverkit');
        ehlo = await expect([250], 'EHLO after STARTTLS');
      } else if (!LOCAL.has(cfg.host)) {
        throw new Error('the SMTP server does not offer STARTTLS; use port 465 or 587');
      }
    }
    if (cfg.user) {
      const plain = Buffer.from(`\0${cfg.user}\0${cfg.pass || ''}`).toString('base64');
      send(`AUTH PLAIN ${plain}`);
      await expect([235], 'login (check RK_SMTP_USER and RK_SMTP_PASS)');
    }
    send(`MAIL FROM:<${envelope.from}>`);
    await expect([250], 'MAIL FROM (is the sender address allowed by your SMTP provider?)');
    send(`RCPT TO:<${envelope.to}>`);
    await expect([250, 251], 'RCPT TO');
    send('DATA');
    await expect([354], 'DATA');
    // Dot-stuffing: a line starting with "." gets an extra one.
    socket.write(msg.replace(/(^|\r\n)\./g, '$1..').replace(/(\r\n)?$/, '\r\n') + '.\r\n');
    await expect([250], 'sending');
    send('QUIT');
    return { ok: true };
  } finally {
    socket.end();
    setTimeout(() => socket.destroy(), 1000).unref();
  }
}

/** The bare address inside "Name <addr>" (or the whole string). */
export const addressOf = (from) => (/<([^<>\s]+)>\s*$/.exec(from)?.[1] || from).trim();
