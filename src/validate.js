// Strict input validation. Anything not on these allowlists is dropped, so form
// values, card data or free text can never be stored even if a client sends it.
import { HttpError } from './http.js';

export const BROWSER_TYPES = new Set(['page_view', 'click', 'form_submit', 'checkout_started', 'payment_signal', 'registered', 'custom']);
export const SERVER_TYPES = new Set(['purchase', 'wallet_funded', 'registered', 'checkout_started', 'custom']);

const NAME_RE = /^[A-Za-z0-9_.:/-]{1,64}$/;
const ANON_RE = /^[A-Za-z0-9_-]{8,64}$/;
const REF_RE = /^[\x21-\x7e]{1,128}$/; // printable ASCII, no spaces
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_AMOUNT = 1e13; // minor units

export const isAnonId = (v) => typeof v === 'string' && ANON_RE.test(v);

/** Paths are reduced to a template so ids, tokens and emails in URLs are never stored. */
export function sanitizePath(path) {
  if (typeof path !== 'string') return null;
  const clean = path.split(/[?#]/)[0].slice(0, 200);
  const segs = clean.split('/').filter(Boolean).slice(0, 8).map((seg) => {
    let s;
    try { s = decodeURIComponent(seg); } catch { s = seg; }
    if (s.includes('@') || /\d{4,}/.test(s) || s.length > 32 || /[^A-Za-z0-9_.-]/.test(s)) return ':id';
    return s;
  });
  return '/' + segs.join('/');
}

function cleanTs(ts, now) {
  if (ts === undefined || ts === null) return now;
  const n = Number(ts);
  // Accept a week of offline-queued events; never trust future timestamps.
  if (!Number.isFinite(n) || n < now - 7 * 864e5 || n > now + 5 * 60e3) return now;
  return Math.floor(n);
}

function cleanAmount(a) {
  if (a === undefined || a === null) return null;
  const n = Number(a);
  if (!Number.isInteger(n) || n < 0 || n > MAX_AMOUNT) throw new HttpError(400, 'amount must be a non-negative integer in minor units (kobo)');
  return n;
}

function cleanCurrency(c, fallback) {
  if (c === undefined || c === null) return fallback;
  const s = String(c).toUpperCase();
  if (!CURRENCY_RE.test(s)) throw new HttpError(400, 'currency must be a 3-letter code');
  return s;
}

/** One browser (layer 1) event. Returns null for events that should be silently dropped. */
export function cleanBrowserEvent(e, now, currency) {
  if (!e || typeof e !== 'object' || !BROWSER_TYPES.has(e.type)) return null;
  let name = null;
  if (e.type === 'page_view') name = sanitizePath(e.path ?? e.name);
  else if (e.name !== undefined) {
    if (typeof e.name !== 'string' || !NAME_RE.test(e.name)) return null;
    name = e.name;
  }
  let amount = null;
  try { amount = cleanAmount(e.amount); } catch { amount = null; }
  return { layer: 1, type: e.type, name, amount, currency: amount === null ? null : currency, ts: cleanTs(e.ts, now) };
}

/** One server (layer 3) event. Throws on bad input so developers see the mistake. */
export function cleanServerEvent(e, now, currency) {
  if (!e || typeof e !== 'object') throw new HttpError(400, 'event must be an object');
  if (!SERVER_TYPES.has(e.type)) throw new HttpError(400, `unknown event type; allowed: ${[...SERVER_TYPES].join(', ')}`);
  if (e.name !== undefined && (typeof e.name !== 'string' || !NAME_RE.test(e.name))) throw new HttpError(400, 'name must match [A-Za-z0-9_.:/-]{1,64}');
  if (e.ref !== undefined && (typeof e.ref !== 'string' || !REF_RE.test(e.ref))) throw new HttpError(400, 'ref must be 1-128 printable characters without spaces');
  const amount = cleanAmount(e.amount);
  if ((e.type === 'purchase' || e.type === 'wallet_funded') && amount === null) throw new HttpError(400, `${e.type} requires amount (minor units)`);
  return {
    layer: 3, type: e.type, name: e.name ?? null, ref: e.ref ?? null,
    amount, currency: amount === null ? null : cleanCurrency(e.currency, currency), ts: cleanTs(e.ts, now),
  };
}

export function hashList(v) {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  if (arr.length > 4 || !arr.every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))) {
    throw new HttpError(400, 'ids must be up to 4 lowercase hex SHA-256 hashes');
  }
  return arr;
}
