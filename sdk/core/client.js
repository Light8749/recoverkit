// Shared event client for the browser and React Native SDKs.
// Sends only: hashed ids, an anonymous id, event types/names, amounts, timestamps.
import { identityHashes } from './identity.js';

const KEY_RE = /^rk_pub_[0-9a-f]{24}$/;
const NAME_RE = /^[A-Za-z0-9_.:/-]{1,64}$/;
const MAX_QUEUE = 200;
const BATCH = 20;

function randomAnonId() {
  const bytes = new Uint8Array(16);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return 'a_' + s;
}

/**
 * storage: { get(k): string|null|Promise, set(k, v): void|Promise }
 * transport: async (url, bodyString, { beacon }) => boolean
 */
export function createClient({ key, endpoint, storage, transport, debug = false }) {
  if (!KEY_RE.test(key || '')) throw new Error('RecoverKit: init needs your public key (rk_pub_...)');
  if (!endpoint) throw new Error('RecoverKit: init needs endpoint (your RecoverKit server address)');
  const url = String(endpoint).replace(/\/+$/, '') + '/v1/collect';
  const state = { anonId: null, ids: [], queue: [], timer: null, sending: false, ready: null, disabled: false };
  const log = (...a) => { if (debug && typeof console !== 'undefined') console.log('[recoverkit]', ...a); };

  state.ready = (async () => {
    try {
      state.anonId = (await storage.get('rk_anon')) || null;
      const ids = await storage.get('rk_ids');
      state.ids = ids ? JSON.parse(ids).filter((h) => /^[0-9a-f]{64}$/.test(h)).slice(0, 4) : [];
    } catch { /* storage unavailable: run in memory */ }
    if (!state.anonId || !/^[A-Za-z0-9_-]{8,64}$/.test(state.anonId)) {
      state.anonId = randomAnonId();
      try { await storage.set('rk_anon', state.anonId); } catch { /* ignore */ }
    }
  })();

  function schedule() {
    if (state.timer) return;
    state.timer = setTimeout(() => { state.timer = null; flush(); }, 4000);
  }

  async function flush({ beacon = false } = {}) {
    await state.ready;
    if (state.sending || state.disabled || !state.queue.length) return;
    state.sending = true;
    try {
      while (state.queue.length) {
        const events = state.queue.splice(0, BATCH);
        const body = JSON.stringify({ key, anonId: state.anonId, ids: state.ids.length ? state.ids : undefined, events });
        let ok = false;
        try { ok = await transport(url, body, { beacon }); } catch { ok = false; }
        if (!ok) { state.queue.unshift(...events.slice(0, MAX_QUEUE - state.queue.length)); log('send failed, will retry'); break; }
      }
    } finally { state.sending = false; }
    if (state.queue.length && !beacon) schedule();
  }

  function track(type, props = {}) {
    if (state.disabled) return;
    const ev = { type, ts: Date.now() };
    if (props.name !== undefined) {
      if (typeof props.name !== 'string' || !NAME_RE.test(props.name)) { log('dropped event with invalid name', props.name); return; }
      ev.name = props.name;
    }
    if (props.path !== undefined) ev.path = String(props.path).split(/[?#]/)[0].slice(0, 200);
    if (Number.isInteger(props.amount) && props.amount >= 0) ev.amount = props.amount;
    if (state.queue.length >= MAX_QUEUE) state.queue.shift();
    state.queue.push(ev);
    if (state.queue.length >= BATCH) flush(); else schedule();
  }

  /** Hash the user's email/phone on this device and link this device to them. */
  async function identify(user = {}) {
    await state.ready;
    const ids = identityHashes(key, user);
    if (!ids.length) { log('identify: no valid email or phone'); return false; }
    state.ids = [...new Set([...ids, ...state.ids])].slice(0, 4);
    try { await storage.set('rk_ids', JSON.stringify(state.ids)); } catch { /* ignore */ }
    track('registered', { name: 'identify' });
    return true;
  }

  /** Forget the user on logout (keeps a fresh anonymous id). */
  async function reset() {
    await flush();
    state.ids = [];
    state.anonId = randomAnonId();
    try { await storage.set('rk_ids', '[]'); await storage.set('rk_anon', state.anonId); } catch { /* ignore */ }
  }

  return {
    track, identify, reset, flush,
    disable() { state.disabled = true; state.queue = []; },
    get anonId() { return state.anonId; },
    ready: () => state.ready,
  };
}
