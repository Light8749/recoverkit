// RecoverKit browser SDK (layer 1).
//
//   <script src="https://cdn.example.com/recoverkit.js"></script>
//   <script>
//     RecoverKit.init({ key: 'rk_pub_...', endpoint: 'https://api.recoverkit.app' });
//     // after login or signup:
//     RecoverKit.identify({ email: user.email, phone: user.phone });
//   </script>
//
// Never reads form field values, never reads card details. The email/phone you
// pass to identify() is hashed in the browser; only the hash is sent.
import { createClient } from '../core/client.js';

const DEFAULT_SUCCESS = [
  /payment (was )?successful/i, /transaction (was )?successful/i, /purchase (was )?successful/i,
  /thank you for your (order|purchase|payment)/i, /order (has been )?(confirmed|placed)/i,
  /(recharge|top.?up|subscription) (was )?successful/i,
];
const CHECKOUT_WORDS = /\b(checkout|pay now|buy now|place order|proceed to pay(ment)?|subscribe|add to cart|recharge now|buy data|buy airtime)\b/i;

let client = null;

const storage = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* private mode */ } },
};

async function transport(url, body, { beacon }) {
  if (beacon && navigator.sendBeacon) {
    // text/plain keeps this a "simple" request: no CORS preflight on page unload.
    return navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
  }
  const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: body.length < 60000, credentials: 'omit' });
  return res.status < 500 && res.status !== 429;
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
}

function autocapture(opts) {
  const patterns = opts.successPatterns || DEFAULT_SUCCESS;
  const signalled = new Set();
  let checks = 0;

  const pageView = () => {
    client.track('page_view', { path: location.pathname });
    checks = 0;
    setTimeout(scanForSuccess, 800);
  };

  function scanForSuccess() {
    if (checks++ > 20 || signalled.has(location.pathname) || !document.body) return;
    const text = (document.body.innerText || '').slice(0, 20000);
    if (patterns.some((re) => re.test(text))) {
      signalled.add(location.pathname);
      client.track('payment_signal', { name: 'success_text' });
    }
  }

  // Single-page apps: route changes.
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...args) {
      const before = location.pathname;
      const r = orig.apply(this, args);
      if (location.pathname !== before) pageView();
      return r;
    };
  }
  window.addEventListener('popstate', pageView);

  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-rk-event],button,a,[role=button],input[type=submit]') : null;
    if (!el) return;
    const tagged = el.getAttribute('data-rk-event');
    if (tagged) { client.track('custom', { name: slug(tagged) || 'tagged' }); return; }
    const label = (el.getAttribute('aria-label') || el.textContent || el.value || '').slice(0, 80);
    // Only the category is sent, never the text itself.
    if (CHECKOUT_WORDS.test(label)) client.track('checkout_started', { name: 'button' });
  }, { capture: true, passive: true });

  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    const name = slug(f.getAttribute('data-rk-name') || f.id || f.getAttribute('name') || 'form');
    client.track('form_submit', { name: name || 'form' });
  }, { capture: true, passive: true });

  let mo = null; let pending = null;
  if (typeof MutationObserver !== 'undefined') {
    mo = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; scanForSuccess(); }, 1000);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  const onHide = () => { if (document.visibilityState === 'hidden') client.flush({ beacon: true }); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', () => client.flush({ beacon: true }));

  pageView();
}

export const RecoverKit = {
  init(opts = {}) {
    if (client) return RecoverKit;
    const respectPrivacy = opts.respectPrivacySignals !== false;
    if (respectPrivacy && (navigator.globalPrivacyControl === true || navigator.doNotTrack === '1')) {
      return RecoverKit; // user asked not to be tracked
    }
    client = createClient({ key: opts.key, endpoint: opts.endpoint, storage, transport, debug: opts.debug });
    if (opts.autocapture !== false) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => autocapture(opts));
      else autocapture(opts);
    }
    return RecoverKit;
  },
  identify(user) { return client ? client.identify(user) : Promise.resolve(false); },
  track(type, props) { if (client) client.track(type === 'purchase' ? 'payment_signal' : type, props); },
  checkoutStarted(amountKobo) { if (client) client.track('checkout_started', { name: 'manual', amount: amountKobo }); },
  reset() { return client ? client.reset() : Promise.resolve(); },
  flush() { return client ? client.flush() : Promise.resolve(); },
};

if (typeof window !== 'undefined') window.RecoverKit = window.RecoverKit || RecoverKit;
