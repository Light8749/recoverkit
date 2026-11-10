// RecoverKit server SDK for Node.js (layer 3).
//
//   import { RecoverKit } from 'recoverkit/sdk/node/index.js';
//   const rk = new RecoverKit({ publicKey: 'rk_pub_...', secretKey: process.env.RK_SECRET_KEY });
//   await rk.identify({ email: user.email, phone: user.phone, firstName: user.firstName });
//   // right after your VTU vendor API returns success:
//   await rk.trackPurchase({ email: user.email, amount: 50000, ref: order.id });
//
// Calls never throw by default: a RecoverKit outage must not break your checkout.
import { identityHashes } from '../core/identity.js';

export { identityHashes, normalizeEmail, normalizePhone } from '../core/identity.js';

export class RecoverKit {
  constructor({ publicKey, secretKey, endpoint = 'https://api.recoverkit.app', timeoutMs = 3000, throwOnError = false, fetch: f } = {}) {
    if (!/^rk_pub_[0-9a-f]{24}$/.test(publicKey || '')) throw new Error('RecoverKit: publicKey (rk_pub_...) required');
    if (!/^rk_sec_/.test(secretKey || '')) throw new Error('RecoverKit: secretKey (rk_sec_...) required; keep it on your server only');
    const u = new URL(endpoint);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !local) throw new Error('RecoverKit: endpoint must use https');
    this.publicKey = publicKey;
    this.secretKey = secretKey;
    this.endpoint = u.origin;
    this.timeoutMs = timeoutMs;
    this.throwOnError = throwOnError;
    this.fetch = f || globalThis.fetch;
  }

  hashes(user) { return identityHashes(this.publicKey, user); }

  async #post(path, body) {
    try {
      const res = await this.fetch(this.endpoint + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.secretKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`RecoverKit ${res.status}: ${json.error || 'request failed'}`);
      return json;
    } catch (err) {
      if (this.throwOnError) throw err;
      return { ok: false, error: String(err.message || err) };
    }
  }

  #ids(user) {
    const ids = this.hashes(user || {});
    if (!ids.length) {
      const err = new Error('RecoverKit: a valid email or phone is required to identify the user');
      if (this.throwOnError) throw err;
      return null;
    }
    return ids;
  }

  /**
   * Link a user. Contact details are sent only when shareContact is true, so
   * RecoverKit can message them; they are stored encrypted and never shown in full.
   */
  identify({ email, phone, firstName, anonId, shareContact = true } = {}) {
    const ids = this.#ids({ email, phone });
    if (!ids) return Promise.resolve({ ok: false, error: 'no identity' });
    const body = { ids, anonId };
    if (shareContact) body.contact = { email, phone, firstName };
    return this.#post('/v1/server/events', body);
  }

  /** The real sale. amount is in minor units (kobo). Pass the payment reference as ref so webhooks dedupe. */
  trackPurchase({ email, phone, amount, currency, ref, name, ts } = {}) {
    const ids = this.#ids({ email, phone });
    if (!ids) return Promise.resolve({ ok: false, error: 'no identity' });
    return this.#post('/v1/server/events', { ids, events: [{ type: 'purchase', amount, currency, ref, name, ts }] });
  }

  /** A wallet deposit. Not a sale: for VTU/fintech, people who fund but never buy are leads. */
  walletFunded({ email, phone, amount, currency, ts } = {}) {
    const ids = this.#ids({ email, phone });
    if (!ids) return Promise.resolve({ ok: false, error: 'no identity' });
    return this.#post('/v1/server/events', { ids, events: [{ type: 'wallet_funded', amount, currency, ts }] });
  }

  track(type, { email, phone, name, amount, currency, ts } = {}) {
    const ids = this.#ids({ email, phone });
    if (!ids) return Promise.resolve({ ok: false, error: 'no identity' });
    return this.#post('/v1/server/events', { ids, events: [{ type, name, amount, currency, ts }] });
  }

  /** Delete everything RecoverKit holds about this person. */
  erase({ email, phone } = {}) {
    const ids = this.#ids({ email, phone });
    if (!ids) return Promise.resolve({ ok: false, error: 'no identity' });
    return this.#post('/v1/server/erase', { ids });
  }
}
