// Layer 2: one webhook endpoint for every payment gateway.
// POST /v1/webhooks/:gatewayId  - the gateway's spec decides how it is verified and read.
import { HttpError, send, readBody, clientIp } from './http.js';
import { verifySignature, extractPayment } from './gateways.js';
import { identityHashes } from '../sdk/core/identity.js';

const LIMIT = 256 * 1024;

export function createWebhooks({ projects, people, engine, db, limiter, config }) {
  function firstTime(projectId, gatewayId, key) {
    const r = db.run('INSERT OR IGNORE INTO webhook_seen (project_id, provider, event_key, seen_at) VALUES (?,?,?,?)', projectId, gatewayId, key, Date.now());
    return r.changes === 1;
  }

  const note = (gatewayId, result) => db.run('UPDATE gateways SET last_event_at = ?, last_result = ? WHERE id = ?', Date.now(), result.slice(0, 120), gatewayId);

  async function receive(req, res, params) {
    const ip = clientIp(req, config.trustProxy);
    if (!limiter.hit(`wh-ip:${ip}`, 600, 60e3)) throw new HttpError(429, 'slow down');
    const raw = await readBody(req, LIMIT);
    const gw = projects.getGateway(params.gatewayId);
    // Unknown gateway, disabled gateway and bad signature all look the same to the caller.
    if (!gw || !gw.enabled || !verifySignature(gw.spec, gw.secret, req.headers, raw)) {
      if (gw) note(gw.id, 'rejected: invalid signature');
      throw new HttpError(401, 'invalid signature');
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { note(gw.id, 'rejected: invalid JSON'); throw new HttpError(400, 'invalid JSON'); }
    const project = projects.byId(gw.project_id);
    const out = extractPayment(gw.spec, body, project.currency);
    if (out.ignored) { note(gw.id, `ignored: ${out.ignored}`); return send(res, 200, { ok: true, ignored: out.ignored }); }
    const p = out.payment;
    if (!firstTime(project.id, gw.id, p.eventId)) { note(gw.id, 'duplicate'); return send(res, 200, { ok: true, duplicate: true }); }

    const hashes = identityHashes(project.public_key, { email: p.email, phone: p.phone });
    const personId = hashes.length ? people.resolve(project.id, hashes, p.ts) : null;
    if (personId) people.setContact(project.id, personId, { email: p.email, phone: p.phone, firstName: p.firstName });
    const kind = p.kind || (project.gateway_mode === 'deposits' ? 'deposit' : 'sale');
    engine.recordEvent(project.id, { personId, layer: 2, type: kind === 'deposit' ? 'wallet_funded' : 'purchase', name: gw.provider, amount: p.amount, currency: p.currency, ts: p.ts });
    if (kind === 'sale') engine.recordPurchase(project.id, { personId, ref: p.ref, amount: p.amount, currency: p.currency, source: gw.provider, ts: p.ts });
    note(gw.id, `ok: ${kind}${personId ? '' : ' (no customer email/phone in payload)'}`);
    send(res, 200, { ok: true, kind });
  }

  return { receive };
}
