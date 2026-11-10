// All cryptography lives here so it can be reviewed in one place.
import {
  createHash, createHmac, randomBytes, timingSafeEqual, hkdfSync,
  createCipheriv, createDecipheriv, scryptSync,
} from 'node:crypto';

export const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const hmacHex = (key, s) => createHmac('sha256', key).update(s, 'utf8').digest('hex');
export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const randomId = (prefix = '') => prefix + randomBytes(12).toString('hex');

/** Constant-time string comparison that is also safe for different lengths. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Derive independent purpose keys from the one master key. */
export function deriveKeys(masterKey) {
  const k = (info) => Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), `recoverkit:${info}`, 32));
  return { pepper: k('identity-pepper'), enc: k('field-encryption'), sign: k('token-signing') };
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encrypt(encKey, plaintext) {
  if (plaintext == null) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(encKey, box) {
  if (!box) return null;
  const [v, iv, tag, ct] = String(box).split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** Encrypt a JSON object (used for channel credentials and gateway secrets). */
export const encryptJson = (k, obj) => encrypt(k, JSON.stringify(obj));
export const decryptJson = (k, box) => (box ? JSON.parse(decrypt(k, box)) : null);

// Passwords: scrypt with per-user salt. N=2^15 keeps login near 100ms.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(password) {
  const salt = randomBytes(16);
  const dk = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}
export function verifyPassword(password, stored) {
  const [alg, salt, dk] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !dk) return false;
  const got = scryptSync(password, Buffer.from(salt, 'base64url'), 32, SCRYPT);
  const want = Buffer.from(dk, 'base64url');
  return want.length === got.length && timingSafeEqual(got, want);
}

/** Signed, expiring token: payload.exp.sig (used for unsubscribe links). */
export function signToken(signKey, payload, ttlSeconds) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${createHmac('sha256', signKey).update(body).digest('base64url')}`;
}
export function verifyToken(signKey, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', signKey).update(body).digest('base64url');
  if (!safeEqual(sig, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof p.exp === 'number' && p.exp * 1000 > Date.now() ? p : null;
  } catch { return null; }
}
