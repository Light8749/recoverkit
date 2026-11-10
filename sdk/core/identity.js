// Shared identity rules. This file is used unchanged by the browser SDK, the
// React Native SDK, the Node server SDK and the RecoverKit server, so every
// layer produces the same hash for the same person.
import { sha256 } from './sha256.js';

export const HASH_VERSION = 'rk1';

export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const e = input.trim().toLowerCase();
  // Deliberately simple: one @, something on both sides, a dot in the domain, no spaces.
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

/**
 * Phone numbers become digits only with the country code.
 * Nigerian local formats are converted: 0803... -> 234803..., 803... -> 234803...
 */
export function normalizePhone(input, defaultCountry = '234') {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  let s = String(input).trim();
  const hadPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (s.startsWith('00')) s = s.slice(2);
  else if (!hadPlus) {
    if (defaultCountry === '234') {
      if (s.length === 11 && s.startsWith('0')) s = '234' + s.slice(1);
      else if (s.length === 10 && /^[789]/.test(s)) s = '234' + s;
    } else if (s.startsWith('0')) {
      s = defaultCountry + s.slice(1);
    }
  }
  // "+234 0803..." is a common mistake: drop the trunk zero after the country code.
  if (s.length === 14 && s.startsWith('2340')) s = '234' + s.slice(4);
  if (s.startsWith('0')) return null; // no country code starts with 0
  if (s.startsWith('234') && s.length !== 13) return null;
  if (s.length < 8 || s.length > 15) return null;
  return s;
}

/**
 * Hash one identifier. Scoped to the project so the same email gives a
 * different hash at two different businesses (no cross-client tracking).
 */
export function hashIdentifier(projectPublicKey, kind, normalized) {
  return sha256(`${HASH_VERSION}|${projectPublicKey}|${kind}|${normalized}`);
}

/** Returns an array of identity hashes for {email, phone}. Raw values never leave this function. */
export function identityHashes(projectPublicKey, { email, phone } = {}, defaultCountry) {
  const out = [];
  const e = normalizeEmail(email);
  if (e) out.push(hashIdentifier(projectPublicKey, 'e', e));
  const p = normalizePhone(phone, defaultCountry);
  if (p) out.push(hashIdentifier(projectPublicKey, 'p', p));
  return out;
}
