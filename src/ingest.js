// Layer 1 (browser) and layer 3 (server) ingestion endpoints.
import { HttpError, send, readBody, parseJson, clientIp } from './http.js';
import { cleanBrowserEvent, cleanServerEvent, hashList, isAnonId } from './validate.js';

const COLLECT_LIMIT = 64 * 1024;
const SERVER_LIMIT = 128 * 1024;
const MAX_EVENTS = 50;

export function createIngest({ projects, people, engine, limiter, config }) {
  function corsHeaders(req, project) {
    const origin = req.headers.origin;
    if (!origin) return {};
    const allowed = JSON.parse(project?.allowed_origins || '[]');
    if (allowed.length && !allowed.includes(origin)) return null;
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-RK-Key',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }

  // Preflight: we don't know the project yet, so allow; the POST itself enforces the origin list.
  function collectPreflight(req, res) {
    const origin = req.headers.origin;
    send(res, 204, '', origin ? {
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-RK-Key', 'Access-Control-Max-Age': '600', Vary: 'Origin',
    } : {});
  }

  /** POST /v1/collect - public key, write-only, can never create a purchase. */
  async function collect(req, res) {
    const ip = clientIp(req, config.trustProxy);
    if (!limiter.hit(`collect-ip:${ip}`, 300, 60e3)) throw new HttpError(429, 'slow down');
    // sendBeacon posts text/plain; both are parsed as JSON.
    const body = parseJson(await readBody(req, COLLECT_LIMIT));
    const project = projects.byPublicKey(req.headers['x-rk-key'] || body.key);
    if (!project) throw new HttpError(401, 'unknown project key');
    const cors = corsHeaders(req, project);
    if (cors === null) throw new HttpError(403, 'origin not allowed for this project');
    if (!limiter.hit(`collect-prj:${project.id}`, 6000, 60e3)) throw new HttpError(429, 'project rate limit');
    if (!isAnonId(body.anonId)) throw new HttpError(400, 'anonId required');
    if (!Array.isArray(body.events) || body.events.length > MAX_EVENTS) throw new HttpError(400, `events must be an array of at most ${MAX_EVENTS}`);

    const now = Date.now();
    let personId = null;
    const ids = hashList(body.ids);
    if (ids.length) {
      personId = people.resolve(project.id, ids, now, { trusted: false });
      people.linkAnon(project.id, body.anonId, personId);
    } else {
      personId = people.personForAnon(project.id, body.anonId);
    }
    let accepted = 0;
    for (const raw of body.events) {
      const ev = cleanBrowserEvent(raw, now, project.currency);
      if (!ev) continue;
      engine.recordEvent(project.id, { ...ev, personId, anonId: body.anonId });
      accepted++;
    }
    send(res, 202, { ok: true, accepted }, cors);
  }

  function requireSecret(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const ip = clientIp(req, config.trustProxy);
    if (!limiter.hit(`auth-ip:${ip}`, 1200, 60e3)) throw new HttpError(429, 'slow down');
    const project = projects.bySecretKey(token);
    if (!project) {
      if (!limiter.hit(`authfail:${ip}`, 30, 60e3)) throw new HttpError(429, 'too many failed attempts');
      throw new HttpError(401, 'invalid secret key');
    }
    if (!limiter.hit(`server-prj:${project.id}`, 12000, 60e3)) throw new HttpError(429, 'project rate limit');
    return project;
  }

  /** POST /v1/server/events - secret key. Identify (with optional contact) and verified purchases. */
  async function serverEvents(req, res) {
    const project = requireSecret(req);
    const body = parseJson(await readBody(req, SERVER_LIMIT));
    const ids = hashList(body.ids);
    const events = body.events ?? [];
    if (!Array.isArray(events) || events.length > MAX_EVENTS) throw new HttpError(400, `events must be an array of at most ${MAX_EVENTS}`);
    if (body.anonId !== undefined && !isAnonId(body.anonId)) throw new HttpError(400, 'bad anonId');
    const now = Date.now();
    const cleaned = events.map((e) => cleanServerEvent(e, now, project.currency)); // validate all before writing any

    let personId = null;
    if (ids.length) {
      personId = people.resolve(project.id, ids, now);
      if (body.anonId) people.linkAnon(project.id, body.anonId, personId);
      if (body.contact && typeof body.contact === 'object') people.setContact(project.id, personId, body.contact);
    } else if (cleaned.length) {
      throw new HttpError(400, 'ids required: call identify with the user email or phone');
    }
    const purchases = [];
    for (const ev of cleaned) {
      engine.recordEvent(project.id, { ...ev, personId });
      if (ev.type === 'purchase') {
        purchases.push(engine.recordPurchase(project.id, { personId, ref: ev.ref, amount: ev.amount, currency: ev.currency, source: 'server', ts: ev.ts }));
      }
    }
    send(res, 200, { ok: true, person: personId ? 'identified' : null, purchases });
  }

  /** POST /v1/server/erase - delete everything about one person (NDPA right to erasure). */
  async function serverErase(req, res) {
    const project = requireSecret(req);
    const body = parseJson(await readBody(req, 8 * 1024));
    const personId = people.findByHashes(project.id, hashList(body.ids));
    if (personId) people.erase(project.id, personId);
    projects.audit(project.id, 'api', 'erase', personId ? 'person erased' : 'no match');
    send(res, 200, { ok: true, erased: Boolean(personId) });
  }

  return { collect, collectPreflight, serverEvents, serverErase };
}
