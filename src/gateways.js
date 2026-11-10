// Payment gateways are data, not code. Each gateway is a "spec": how its webhooks
// are signed, which events mean a successful payment, and where the fields live.
// Presets are just pre-filled specs; a business can edit them or define any
// other gateway (Remita, Interswitch, OPay, a bank, an in-house wallet...).
import { createHmac } from 'node:crypto';
import { safeEqual } from './crypto.js';

const PATH_RE = /^[A-Za-z0-9_]{1,64}(\.[A-Za-z0-9_]{1,64}){0,7}$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
export const ALGORITHMS = ['sha256', 'sha512', 'sha1'];
export const FIELD_NAMES = ['ref', 'amount', 'currency', 'email', 'phone', 'name', 'time', 'eventId', 'kind'];

export const PRESETS = {
  paystack: {
    label: 'Paystack', secretLabel: 'Secret key (sk_live_...)',
    spec: {
      signatures: [{ scheme: 'hmac', header: 'x-paystack-signature', algorithm: 'sha512', encoding: 'hex', signs: 'body' }],
      eventPath: 'event', eventValues: ['charge.success'], statusPath: 'data.status', statusValues: ['success'],
      amountUnit: 'minor',
      fields: { ref: 'data.reference', amount: 'data.amount', currency: 'data.currency', email: 'data.customer.email', phone: 'data.customer.phone', name: 'data.customer.first_name', time: 'data.paid_at', eventId: 'data.reference', kind: 'data.metadata.recoverkit_kind' },
    },
  },
  flutterwave: {
    label: 'Flutterwave', secretLabel: 'Secret hash (set in Flutterwave webhook settings)',
    spec: {
      signatures: [
        { scheme: 'hmac', header: 'flutterwave-signature', algorithm: 'sha256', encoding: 'base64', signs: 'body' },
        { scheme: 'secret', header: 'verif-hash' },
      ],
      eventPath: 'event', eventValues: ['charge.completed'], statusPath: 'data.status', statusValues: ['successful'],
      amountUnit: 'major',
      fields: { ref: 'data.tx_ref', amount: 'data.amount', currency: 'data.currency', email: 'data.customer.email', phone: 'data.customer.phone_number', name: 'data.customer.name', time: 'data.created_at', eventId: 'data.id', kind: 'data.meta.recoverkit_kind' },
    },
  },
  monnify: {
    label: 'Monnify (Moniepoint)', secretLabel: 'Client secret key',
    spec: {
      signatures: [{ scheme: 'hmac', header: 'monnify-signature', algorithm: 'sha512', encoding: 'hex', signs: 'body' }],
      eventPath: 'eventType', eventValues: ['SUCCESSFUL_TRANSACTION'], statusPath: 'eventData.paymentStatus', statusValues: ['PAID'],
      amountUnit: 'major',
      fields: { ref: 'eventData.paymentReference', amount: 'eventData.amountPaid', currency: 'eventData.currency', email: 'eventData.customer.email', name: 'eventData.customer.name', time: 'eventData.paidOn', eventId: 'eventData.transactionReference', kind: 'eventData.metaData.recoverkit_kind' },
    },
  },
  korapay: {
    label: 'Korapay', secretLabel: 'Secret key',
    spec: {
      signatures: [{ scheme: 'hmac', header: 'x-korapay-signature', algorithm: 'sha256', encoding: 'hex', signs: 'field:data' }],
      eventPath: 'event', eventValues: ['charge.success'], statusPath: 'data.status', statusValues: ['success'],
      amountUnit: 'major',
      fields: { ref: 'data.reference', amount: 'data.amount', currency: 'data.currency', email: 'data.customer.email', name: 'data.customer.name', eventId: 'data.reference', kind: 'data.metadata.recoverkit_kind' },
    },
  },
  squad: {
    label: 'Squad (GTCO)', secretLabel: 'Secret key',
    spec: {
      signatures: [{ scheme: 'hmac', header: 'x-squad-encrypted-body', algorithm: 'sha512', encoding: 'hex', signs: 'body' }],
      eventPath: 'Event', eventValues: ['charge_successful'], statusPath: 'Body.transaction_status', statusValues: ['Success'],
      amountUnit: 'minor',
      fields: { ref: 'Body.transaction_ref', amount: 'Body.amount', currency: 'Body.currency', email: 'Body.email', time: 'Body.created_at', eventId: 'Body.transaction_ref', kind: 'Body.meta.recoverkit_kind' },
    },
  },
  stripe: {
    label: 'Stripe', secretLabel: 'Webhook signing secret (whsec_...)',
    spec: {
      signatures: [{ scheme: 'stripe', header: 'stripe-signature' }],
      eventPath: 'type', eventValues: ['checkout.session.completed'], statusPath: 'data.object.payment_status', statusValues: ['paid'],
      amountUnit: 'minor',
      fields: { ref: 'data.object.payment_intent', amount: 'data.object.amount_total', currency: 'data.object.currency', email: 'data.object.customer_details.email', phone: 'data.object.customer_details.phone', name: 'data.object.customer_details.name', time: 'data.object.created', eventId: 'id', kind: 'data.object.metadata.recoverkit_kind' },
    },
  },
  custom: {
    label: 'Other gateway (custom)', secretLabel: 'Webhook secret or signing key',
    spec: {
      signatures: [{ scheme: 'hmac', header: 'x-signature', algorithm: 'sha256', encoding: 'hex', signs: 'body' }],
      eventPath: '', eventValues: [], statusPath: '', statusValues: [], amountUnit: 'minor',
      fields: { ref: 'reference', amount: 'amount', currency: 'currency', email: 'customer.email' },
    },
  },
};

/** Read a dotted path from parsed JSON using own properties only (no prototype tricks). */
export function getPath(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || FORBIDDEN.has(seg) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function cleanPath(p, label) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  if (!PATH_RE.test(s) || s.split('.').some((x) => FORBIDDEN.has(x))) throw new Error(`${label}: use dotted field names like data.customer.email`);
  return s;
}

const cleanValues = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((x) => String(x).trim()).filter(Boolean).slice(0, 10).map((x) => x.slice(0, 64));

/** Validate and normalise a spec from the dashboard. Throws with a readable message. */
export function validateSpec(input) {
  if (!input || typeof input !== 'object') throw new Error('gateway settings missing');
  const sigs = Array.isArray(input.signatures) ? input.signatures.slice(0, 3) : [];
  if (!sigs.length) throw new Error('a signature check is required: unsigned webhooks are never accepted');
  const signatures = sigs.map((s) => {
    const header = String(s.header || '').trim().toLowerCase();
    if (!HEADER_RE.test(header)) throw new Error('signature header must be a header name like x-signature');
    if (s.scheme === 'secret') return { scheme: 'secret', header };
    if (s.scheme === 'stripe') return { scheme: 'stripe', header };
    if (s.scheme !== 'hmac') throw new Error('signature type must be hmac, secret or stripe');
    if (!ALGORITHMS.includes(s.algorithm)) throw new Error(`algorithm must be one of ${ALGORITHMS.join(', ')}`);
    if (!['hex', 'base64'].includes(s.encoding)) throw new Error('encoding must be hex or base64');
    const signs = s.signs || 'body';
    if (signs !== 'body' && !(signs.startsWith('field:') && PATH_RE.test(signs.slice(6)))) throw new Error('signs must be body or field:<path>');
    return { scheme: 'hmac', header, algorithm: s.algorithm, encoding: s.encoding, signs };
  });
  const fields = {};
  for (const f of FIELD_NAMES) {
    const p = cleanPath(input.fields?.[f], `field ${f}`);
    if (p) fields[f] = p;
  }
  if (!fields.amount) throw new Error('the amount field is required');
  if (!fields.ref && !fields.eventId) throw new Error('a reference or event id field is required (for duplicate protection)');
  if (!['minor', 'major'].includes(input.amountUnit)) throw new Error('amount unit must be minor (kobo/cents) or major (naira/dollars)');
  return {
    signatures,
    eventPath: cleanPath(input.eventPath, 'event field'), eventValues: cleanValues(input.eventValues),
    statusPath: cleanPath(input.statusPath, 'status field'), statusValues: cleanValues(input.statusValues),
    amountUnit: input.amountUnit, fields,
  };
}

function digest(algorithm, secret, data, encoding) {
  return createHmac(algorithm, secret).update(data).digest(encoding);
}

/** Does any configured signature check pass for this raw request? */
export function verifySignature(spec, secret, headers, raw, now = Date.now()) {
  if (!secret) return false;
  for (const s of spec.signatures) {
    const got = headers[s.header];
    if (typeof got !== 'string' || !got || got.length > 1024) continue;
    if (s.scheme === 'secret') {
      if (safeEqual(got, secret)) return true;
    } else if (s.scheme === 'hmac') {
      let data = raw;
      if (s.signs.startsWith('field:')) {
        let parsed;
        try { parsed = JSON.parse(raw.toString('utf8')); } catch { continue; }
        const part = getPath(parsed, s.signs.slice(6));
        if (part === undefined) continue;
        data = JSON.stringify(part);
      }
      const want = digest(s.algorithm, secret, data, s.encoding);
      const cmp = s.encoding === 'hex' ? [got.trim().toLowerCase(), want] : [got.trim(), want];
      if (safeEqual(cmp[0], cmp[1])) return true;
    } else if (s.scheme === 'stripe') {
      // Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]; signed payload is "<t>.<raw body>"
      let t = null; const v1 = [];
      for (const kv of got.split(',')) {
        const [k, v] = kv.split('=');
        if (k === 't') t = v; else if (k === 'v1' && v) v1.push(v);
      }
      if (!t || !/^\d{1,12}$/.test(t) || Math.abs(now / 1000 - Number(t)) > 300) continue;
      const want = digest('sha256', secret, Buffer.concat([Buffer.from(`${t}.`), raw]), 'hex');
      if (v1.some((sig) => safeEqual(sig, want))) return true;
    }
  }
  return false;
}

function parseTime(v, now) {
  let t;
  if (typeof v === 'number') t = v < 1e12 ? v * 1000 : v; // unix seconds or ms
  else if (typeof v === 'string' && /^\d{9,13}$/.test(v)) t = Number(v) < 1e12 ? Number(v) * 1000 : Number(v);
  else t = Date.parse(v);
  if (!Number.isFinite(t) || t > now + 5 * 60e3 || t < now - 60 * 864e5) return now;
  return Math.floor(t);
}

const str = (v, max = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, max) : undefined);

/**
 * Turn a verified webhook body into a payment, or explain why it was ignored.
 * Returns { payment } or { ignored: reason }.
 */
export function extractPayment(spec, body, fallbackCurrency, now = Date.now()) {
  if (spec.eventPath && spec.eventValues.length) {
    const ev = str(getPath(body, spec.eventPath));
    if (!ev || !spec.eventValues.includes(ev)) return { ignored: 'event type not tracked' };
  }
  if (spec.statusPath && spec.statusValues.length) {
    const st = str(getPath(body, spec.statusPath));
    if (!st || !spec.statusValues.map((x) => x.toLowerCase()).includes(st.toLowerCase())) return { ignored: 'payment not successful' };
  }
  const f = spec.fields;
  const rawAmount = Number(getPath(body, f.amount));
  if (!Number.isFinite(rawAmount) || rawAmount < 0 || rawAmount > 1e13) return { ignored: 'missing or invalid amount' };
  const amount = spec.amountUnit === 'major' ? Math.round(rawAmount * 100) : Math.round(rawAmount);
  const ref = str(getPath(body, f.ref), 128);
  const eventId = str(getPath(body, f.eventId), 128) || ref;
  if (!eventId) return { ignored: 'missing reference' };
  const cur = str(getPath(body, f.currency), 3)?.toUpperCase();
  const name = str(getPath(body, f.name), 80);
  const kind = str(getPath(body, f.kind), 16);
  return {
    payment: {
      ref: ref || null, eventId, amount,
      currency: cur && /^[A-Z]{3}$/.test(cur) ? cur : fallbackCurrency,
      email: str(getPath(body, f.email), 254), phone: str(getPath(body, f.phone), 32),
      firstName: name ? name.trim().split(/\s+/)[0] : undefined,
      ts: parseTime(getPath(body, f.time), now),
      kind: kind === 'sale' || kind === 'deposit' ? kind : null,
    },
  };
}
