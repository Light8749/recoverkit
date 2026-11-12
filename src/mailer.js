// System email (password resets, invites): not customer follow-ups, which use each business's channels.
//   RK_MAIL_FROM        e.g. "RecoverKit <no-reply@yourdomain.com>"  (required to send anything)
//   RK_BREVO_API_KEY    send through Brevo's HTTPS API (works where hosting blocks SMTP ports); otherwise...
//   RK_SMTP_HOST        send through SMTP (Brevo: smtp-relay.brevo.com), with RK_SMTP_PORT (587),
//                       RK_SMTP_USER and RK_SMTP_PASS; otherwise...
//   RK_RESEND_API_KEY   send through Resend's API; otherwise...
//   RK_SENDMAIL         path to sendmail (default /usr/sbin/sendmail, which cPanel hosting has)
// With no RK_MAIL_FROM, nothing is sent and the admin copies links by hand.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { smtpSend, addressOf } from './smtp.js';

const HEADER_SAFE = /^[^\r\n]{1,300}$/;
const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function mailFromEnv(env = process.env) {
  const from = (env.RK_MAIL_FROM || '').trim();
  if (!from) return { mode: 'none' };
  if (!HEADER_SAFE.test(from)) throw new Error('RK_MAIL_FROM must be one line');
  if (env.RK_BREVO_API_KEY) return { mode: 'brevo', from, apiKey: env.RK_BREVO_API_KEY.trim() };
  if (env.RK_SMTP_HOST) {
    const host = env.RK_SMTP_HOST.trim();
    if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('RK_SMTP_HOST must be a host name like smtp-relay.brevo.com');
    const port = Number(env.RK_SMTP_PORT || 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RK_SMTP_PORT must be a port number');
    return { mode: 'smtp', from, host, port, user: env.RK_SMTP_USER || '', pass: env.RK_SMTP_PASS || '' };
  }
  if (env.RK_RESEND_API_KEY) return { mode: 'resend', from, apiKey: env.RK_RESEND_API_KEY };
  const path = env.RK_SENDMAIL || '/usr/sbin/sendmail';
  return existsSync(path) ? { mode: 'sendmail', from, path } : { mode: 'none' };
}

/** Builds the RFC 5322 message. Exported for tests. */
export function buildMessage({ from, to, subject, text, headers = {} }) {
  if (!ADDRESS.test(to) || !HEADER_SAFE.test(subject) || !HEADER_SAFE.test(from)) throw new Error('bad email header');
  const body = String(text).replace(/\r?\n/g, '\r\n');
  return [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@recoverkit>`, 'MIME-Version: 1.0',
    ...Object.entries(headers).map(([k, v]) => {
      if (!/^[A-Za-z][A-Za-z0-9-]{0,60}$/.test(k) || !HEADER_SAFE.test(String(v))) throw new Error('bad email header');
      return `${k}: ${v}`;
    }),
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', ...(headers['List-Unsubscribe'] ? [] : ['Auto-Submitted: auto-generated']), '', body, '',
  ].join('\r\n');
}

export function createMailer(cfg = { mode: 'none' }, { fetch = globalThis.fetch, logger = console } = {}) {
  async function send({ to, subject, text }) {
    try {
      if (cfg.mode === 'smtp') {
        const msg = buildMessage({ from: cfg.from, to, subject, text });
        const envFrom = addressOf(cfg.from);
        if (!ADDRESS.test(envFrom)) throw new Error('RK_MAIL_FROM needs an email address');
        return await smtpSend(cfg, { from: envFrom, to }, msg);
      }
      if (cfg.mode === 'brevo') {
        buildMessage({ from: cfg.from, to, subject, text }); // same header checks
        const email = addressOf(cfg.from);
        if (!ADDRESS.test(email)) throw new Error('RK_MAIL_FROM needs an email address');
        const name = (/^\s*"?([^"<]+?)"?\s*</.exec(cfg.from)?.[1] || 'RecoverKit').trim();
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST', headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ sender: { name, email }, to: [{ email: to }], subject, textContent: text }), signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) return { ok: true };
        const j = await res.json().catch(() => ({}));
        return { ok: false, error: `brevo ${res.status}${j.message ? `: ${String(j.message).slice(0, 200)}` : ''}` };
      }
      if (cfg.mode === 'resend') {
        buildMessage({ from: cfg.from, to, subject, text }); // same header checks
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: cfg.from, to: [to], subject, text }), signal: AbortSignal.timeout(10_000),
        });
        return res.ok ? { ok: true } : { ok: false, error: `resend ${res.status}` };
      }
      if (cfg.mode === 'sendmail') {
        const msg = buildMessage({ from: cfg.from, to, subject, text });
        return await new Promise((resolve) => {
          // -t reads recipients from the headers (already validated), -i keeps lone dots in the body.
          const p = spawn(cfg.path, ['-t', '-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
          const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: 'sendmail timed out' }); }, 15_000);
          p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
          p.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, error: `sendmail exited ${code}` }); });
          p.stdin.end(msg);
        });
      }
      return { ok: false, error: 'email is not set up' };
    } catch (e) {
      logger.warn?.(`[mail] ${e.message}`);
      return { ok: false, error: e.message };
    }
  }
  return { enabled: cfg.mode !== 'none', mode: cfg.mode, send };
}
