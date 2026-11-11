// System email (password resets, invites): not customer follow-ups, which use each business's channels.
//   RK_MAIL_FROM        e.g. "RecoverKit <no-reply@yourdomain.com>"  (required to send anything)
//   RK_RESEND_API_KEY   send through Resend's API; otherwise...
//   RK_SENDMAIL         path to sendmail (default /usr/sbin/sendmail, which cPanel hosting has)
// With no RK_MAIL_FROM, nothing is sent and the admin copies links by hand.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const HEADER_SAFE = /^[^\r\n]{1,300}$/;
const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function mailFromEnv(env = process.env) {
  const from = (env.RK_MAIL_FROM || '').trim();
  if (!from) return { mode: 'none' };
  if (!HEADER_SAFE.test(from)) throw new Error('RK_MAIL_FROM must be one line');
  if (env.RK_RESEND_API_KEY) return { mode: 'resend', from, apiKey: env.RK_RESEND_API_KEY };
  const path = env.RK_SENDMAIL || '/usr/sbin/sendmail';
  return existsSync(path) ? { mode: 'sendmail', from, path } : { mode: 'none' };
}

/** Builds the RFC 5322 message. Exported for tests. */
export function buildMessage({ from, to, subject, text }) {
  if (!ADDRESS.test(to) || !HEADER_SAFE.test(subject) || !HEADER_SAFE.test(from)) throw new Error('bad email header');
  const body = String(text).replace(/\r?\n/g, '\r\n');
  return [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', 'Auto-Submitted: auto-generated', '', body, '',
  ].join('\r\n');
}

export function createMailer(cfg = { mode: 'none' }, { fetch = globalThis.fetch, logger = console } = {}) {
  async function send({ to, subject, text }) {
    try {
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
