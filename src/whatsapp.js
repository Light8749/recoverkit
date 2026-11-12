// WhatsApp replies (Meta Cloud API webhooks), one URL per business:
//   GET  /v1/whatsapp/:projectId   Meta's verification handshake (hub.verify_token)
//   POST /v1/whatsapp/:projectId   incoming messages, signed with the Meta app secret (X-Hub-Signature-256)
// "STOP" and similar replies opt the person out at once. Other replies appear under Messages > Replies,
// where the business can answer within WhatsApp's 24-hour window.
import { createHmac } from 'node:crypto';
import { HttpError, send, readBody, clientIp } from './http.js';
import { hmacHex, safeEqual, randomId, encrypt, decrypt } from './crypto.js';
import { identityHashes, normalizePhone } from '../sdk/core/identity.js';
import { mask } from './channels.js';

const LIMIT = 512 * 1024;
const STOP_WORDS = new Set(['stop', 'stop all', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'opt out', 'optout', 'opt-out', 'remove me', 'no more']);
export const isStop = (text) => STOP_WORDS.has(String(text || '').trim().toLowerCase().replace(/[.!]+$/, ''));
export const REPLY_WINDOW_MS = 24 * 3600e3;

export function createWhatsApp({ db, keys, config, projects, people, limiter, fetch = globalThis.fetch, logger = console }) {
  const verifyToken = (projectId) => hmacHex(keys.sign, `wa-verify:${projectId}`).slice(0, 32);
  const webhookUrl = (projectId) => `${config.publicUrl}/v1/whatsapp/${projectId}`;

  function projectFor(params) {
    const p = /^prj_[0-9a-f]{24}$/.test(params.projectId || '') ? projects.byId(params.projectId) : null;
    return p ? { p, wa: projects.getChannels(p).whatsapp || null } : null;
  }

  /** Meta calls this once when you save the webhook in the Meta app dashboard. */
  function verify(req, res, params, url) {
    const found = projectFor(params);
    const q = url.searchParams;
    if (found && q.get('hub.mode') === 'subscribe' && safeEqual(q.get('hub.verify_token') || '', verifyToken(found.p.id))) {
      return send(res, 200, String(q.get('hub.challenge') || '').slice(0, 200), { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    throw new HttpError(403, 'verification failed');
  }

  async function sendText(wa, to, body) {
    const r = await fetch(`https://graph.facebook.com/v21.0/${wa.phoneNumberId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${wa.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }), signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    return r.ok ? { ok: true } : { ok: false, error: `whatsapp ${r.status}` };
  }

  async function receive(req, res, params) {
    if (!limiter.hit(`wa-ip:${clientIp(req, config.trustProxy)}`, 600, 60e3)) throw new HttpError(429, 'slow down');
    const raw = await readBody(req, LIMIT);
    const found = projectFor(params);
    const sig = String(req.headers['x-hub-signature-256'] || '');
    const want = found?.wa?.appSecret ? 'sha256=' + createHmac('sha256', found.wa.appSecret).update(raw).digest('hex') : null;
    if (!found || !want || !safeEqual(sig, want)) throw new HttpError(401, 'invalid signature');
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
    const { p, wa } = found;
    let stored = 0;
    for (const entry of Array.isArray(body.entry) ? body.entry : []) {
      for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
        const v = change?.value || {};
        // Only messages to this business's own WhatsApp number.
        if (wa.phoneNumberId && v.metadata?.phone_number_id && String(v.metadata.phone_number_id) !== String(wa.phoneNumberId)) continue;
        for (const m of Array.isArray(v.messages) ? v.messages : []) {
          const from = normalizePhone('+' + String(m.from || '').replace(/\D/g, ''));
          const id = typeof m.id === 'string' ? m.id.slice(0, 200) : '';
          if (!from || !id) continue;
          const text = String(m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? `[${String(m.type || 'message').slice(0, 20)}]`).slice(0, 4096);
          const ts = Number(m.timestamp) > 0 ? Math.min(Number(m.timestamp) * 1000, Date.now()) : Date.now();
          const personId = people.findByHashes(p.id, identityHashes(p.public_key, { phone: '+' + from }));
          const stop = isStop(text);
          const r = db.run('INSERT OR IGNORE INTO inbound (id, project_id, person_id, channel, provider_id, from_enc, from_masked, body_enc, is_stop, received_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            randomId('in_'), p.id, personId, 'whatsapp', id, encrypt(keys.enc, from), mask(from), encrypt(keys.enc, text), stop ? 1 : 0, ts);
          if (!r.changes) continue; // a retry of a message we already have
          stored++;
          if (stop && personId) {
            db.run('UPDATE persons SET opted_out = 1 WHERE id = ? AND project_id = ?', personId, p.id);
            db.run("UPDATE messages SET status = 'rejected', status_reason = 'replied STOP' WHERE person_id = ? AND project_id = ? AND status IN ('draft','approved')", personId, p.id);
            projects.audit(p.id, 'whatsapp', 'opted_out', 'replied STOP');
          }
          if (stop && wa.accessToken && wa.phoneNumberId) {
            sendText(wa, from, `You won't get any more messages from ${p.name}.`).catch(() => {});
          }
        }
      }
    }
    send(res, 200, { ok: true, stored });
  }

  const listReplies = (projectId, limit = 100) => db.all('SELECT * FROM inbound WHERE project_id = ? ORDER BY received_at DESC LIMIT ?', projectId, limit)
    .map((r) => ({ ...r, body: decrypt(keys.enc, r.body_enc), reply: r.reply_enc ? decrypt(keys.enc, r.reply_enc) : null }));
  const unanswered = (projectId) => db.get('SELECT COUNT(*) n FROM inbound WHERE project_id = ? AND replied_at IS NULL AND is_stop = 0 AND received_at > ?', projectId, Date.now() - REPLY_WINDOW_MS).n;

  /** Answer a reply. WhatsApp allows free text only within 24 hours of the customer's last message. */
  async function answer(projectId, inboundId, text, actor) {
    const row = db.get('SELECT * FROM inbound WHERE id = ? AND project_id = ?', inboundId, projectId);
    if (!row) throw new Error('reply not found');
    if (row.is_stop) throw new Error('this person asked not to be messaged');
    if (Date.now() - row.received_at > REPLY_WINDOW_MS) throw new Error('WhatsApp only allows a reply within 24 hours of the customer\'s message');
    const body = String(text || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (body.length < 1 || body.length > 4096) throw new Error('write a reply (up to 4,096 characters)');
    const wa = projects.getChannels(projects.byId(projectId)).whatsapp;
    if (!wa?.accessToken || !wa?.phoneNumberId) throw new Error('connect WhatsApp in Channels first');
    const r = await sendText(wa, decrypt(keys.enc, row.from_enc), body).catch(() => ({ ok: false, error: 'provider error' }));
    if (!r.ok) throw new Error(`WhatsApp didn't accept the reply (${r.error})`);
    db.run('UPDATE inbound SET replied_at = ?, reply_enc = ? WHERE id = ?', Date.now(), encrypt(keys.enc, body), row.id);
    projects.audit(projectId, actor, 'whatsapp_reply', row.id);
  }

  return { verify, receive, listReplies, unanswered, answer, verifyToken, webhookUrl };
}
