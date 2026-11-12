// The email channel for follow-ups: any SMTP server, or the API of Resend, Brevo, SendGrid, Mailgun or Postmark.
// cfg is the business's saved email settings (encrypted at rest). Every message carries the unsubscribe
// link in the text and a List-Unsubscribe header.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateIp } from './ai.js';
import { smtpSend, addressOf } from './smtp.js';
import { buildMessage } from './mailer.js';

export const EMAIL_PROVIDERS = {
  resend: { label: 'Resend (API)', needs: ['apiKey'] },
  brevo: { label: 'Brevo (API)', needs: ['apiKey'] },
  sendgrid: { label: 'SendGrid (API)', needs: ['apiKey'] },
  mailgun: { label: 'Mailgun (API)', needs: ['apiKey', 'domain'] },
  postmark: { label: 'Postmark (API)', needs: ['apiKey'] },
  smtp: { label: 'SMTP (any mail server: cPanel, Gmail, Zoho, Brevo SMTP...)', needs: ['smtpHost', 'smtpUser', 'smtpPass'] },
};
export const SMTP_PORTS = [25, 465, 587, 2525];
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const TIMEOUT = 15_000;

/** "Name <a@b.ng>" -> { name, email } */
export function parseFrom(from) {
  const s = String(from || '').trim();
  if (!/^[^\r\n]{3,200}$/.test(s)) return null;
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/.exec(s);
  const email = m ? m[2] : s;
  if (!ADDRESS.test(email)) return null;
  return { name: m ? m[1].trim() : '', email };
}

/** Clean what a business saves. Throws a readable error. Blank secrets keep the saved ones (merged by the caller). */
export function validateEmailConfig(c) {
  const provider = Object.hasOwn(EMAIL_PROVIDERS, c.provider || '') ? c.provider : 'resend';
  const out = { provider };
  if (!parseFrom(c.from)) throw new Error('Email "From" must look like PadiConnect <hello@yourdomain.com>');
  out.from = String(c.from).trim();
  if (provider === 'smtp') {
    const host = String(c.smtpHost || '').trim().toLowerCase();
    if (!HOST_RE.test(host)) throw new Error('SMTP server must be a host name like mail.yourdomain.com');
    const port = Number(c.smtpPort || 587);
    if (!SMTP_PORTS.includes(port)) throw new Error(`SMTP port must be one of ${SMTP_PORTS.join(', ')}`);
    Object.assign(out, { smtpHost: host, smtpPort: port, smtpUser: String(c.smtpUser || '').trim().slice(0, 200), smtpPass: String(c.smtpPass || '').slice(0, 500) });
    if (!out.smtpUser || !out.smtpPass) throw new Error('SMTP needs a username and password');
  } else {
    out.apiKey = String(c.apiKey || '').trim().slice(0, 500);
    if (out.apiKey.length < 8) throw new Error(`Enter your ${EMAIL_PROVIDERS[provider].label.replace(' (API)', '')} API key`);
    if (provider === 'mailgun') {
      out.domain = String(c.domain || '').trim().toLowerCase();
      if (!HOST_RE.test(out.domain)) throw new Error('Mailgun needs your sending domain, like mg.yourdomain.com');
      out.region = c.region === 'eu' ? 'eu' : 'us';
    }
  }
  return out;
}

export function emailReady(cfg) {
  if (!cfg || !parseFrom(cfg.from)) return false;
  const provider = cfg.provider || 'resend';
  return (EMAIL_PROVIDERS[provider]?.needs || ['apiKey']).every((k) => cfg[k]);
}

async function post(fetchFn, url, { headers, json, form }) {
  const res = await fetchFn(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT),
    headers: { ...(json ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/x-www-form-urlencoded' }), Accept: 'application/json', ...headers },
    body: json ? JSON.stringify(json) : new URLSearchParams(form).toString(),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** A public mail server only: never this machine or a private network (an open sign-up must not reach internal mail). */
async function publicAddress(host, { resolver = lookup, allowPrivate = false } = {}) {
  const addrs = isIP(host) ? [{ address: host }] : await resolver(host, { all: true });
  if (!addrs.length) throw new Error('SMTP server not found');
  if (!allowPrivate && addrs.some((a) => isPrivateIp(a.address))) throw new Error('SMTP server must be a public address');
  return addrs[0].address;
}

/** msg: { to, subject, body, unsubscribeUrl, unsubscribeText }  -> { ok, id?, error? } */
export async function sendEmail(cfg, msg, { fetch = globalThis.fetch, resolver, allowPrivate = false } = {}) {
  if (!emailReady(cfg)) return { ok: false, error: 'email channel not configured' };
  const from = parseFrom(cfg.from);
  if (!ADDRESS.test(msg.to || '')) return { ok: false, error: 'bad recipient' };
  const subject = String(msg.subject || 'A quick note').replace(/[\r\n]+/g, ' ').slice(0, 200);
  const text = `${msg.body}\n\n${msg.unsubscribeText || ''}`.trim();
  const unsub = msg.unsubscribeUrl ? { 'List-Unsubscribe': `<${msg.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {};
  const ok = (status, id) => (status < 300 ? { ok: true, id } : { ok: false, error: `${cfg.provider || 'resend'} ${status}` });
  switch (cfg.provider || 'resend') {
    case 'resend': {
      const r = await post(fetch, 'https://api.resend.com/emails', { headers: { Authorization: `Bearer ${cfg.apiKey}` }, json: { from: cfg.from, to: [msg.to], subject, text, headers: unsub } });
      return ok(r.status, r.body.id);
    }
    case 'brevo': {
      const r = await post(fetch, 'https://api.brevo.com/v3/smtp/email', { headers: { 'api-key': cfg.apiKey }, json: { sender: { name: from.name || from.email, email: from.email }, to: [{ email: msg.to }], subject, textContent: text, headers: unsub } });
      return ok(r.status, r.body.messageId);
    }
    case 'sendgrid': {
      const r = await post(fetch, 'https://api.sendgrid.com/v3/mail/send', { headers: { Authorization: `Bearer ${cfg.apiKey}` },
        json: { personalizations: [{ to: [{ email: msg.to }] }], from: { email: from.email, ...(from.name ? { name: from.name } : {}) }, subject, content: [{ type: 'text/plain', value: text }], headers: unsub } });
      return ok(r.status);
    }
    case 'mailgun': {
      const host = cfg.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
      const r = await post(fetch, `https://${host}/v3/${encodeURIComponent(cfg.domain)}/messages`, {
        headers: { Authorization: `Basic ${Buffer.from(`api:${cfg.apiKey}`).toString('base64')}` },
        form: { from: cfg.from, to: msg.to, subject, text, ...Object.fromEntries(Object.entries(unsub).map(([k, v]) => [`h:${k}`, v])) },
      });
      return ok(r.status, r.body.id);
    }
    case 'postmark': {
      const r = await post(fetch, 'https://api.postmarkapp.com/email', { headers: { 'X-Postmark-Server-Token': cfg.apiKey },
        json: { From: cfg.from, To: msg.to, Subject: subject, TextBody: text, MessageStream: 'outbound', Headers: Object.entries(unsub).map(([Name, Value]) => ({ Name, Value })) } });
      return ok(r.status, r.body.MessageID);
    }
    case 'smtp': {
      try {
        const ip = await publicAddress(cfg.smtpHost, { resolver, allowPrivate });
        const raw = buildMessage({ from: cfg.from, to: msg.to, subject, text, headers: unsub });
        // Connect to the address we checked (no second DNS lookup), with the real name for TLS.
        await smtpSend({ host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.smtpUser, pass: cfg.smtpPass, connectHost: ip, tlsOptions: cfg.tlsOptions }, { from: addressOf(cfg.from), to: msg.to }, raw);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `smtp: ${String(e.message || e).replace(/AUTH PLAIN \S+/g, 'AUTH PLAIN ***').slice(0, 160)}` };
      }
    }
    default: return { ok: false, error: 'unknown email provider' };
  }
}
