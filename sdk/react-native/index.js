// RecoverKit SDK. MIT License, Copyright (c) 2026 Light8749. https://github.com/Light8749/recoverkit
// RecoverKit for React Native / Expo (layer 1 for apps).
//
//   import AsyncStorage from '@react-native-async-storage/async-storage';
//   import { RecoverKit } from 'recoverkit/sdk/react-native';
//   const rk = RecoverKit.init({ key: 'rk_pub_...', endpoint: 'https://YOUR-RECOVERKIT-HOST', storage: AsyncStorage });
//   rk.screen('Pricing');               // call from your navigation listener
//   rk.identify({ email, phone });      // after login
//   rk.checkoutStarted(250000);         // when they open the payment sheet
//
// Purchases must still be confirmed by webhooks or your server (layer 2/3).
import { createClient } from '../core/client.js';

let client = null;

function memoryStorage() {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); } };
}

async function transport(url, body) {
  const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
  return res.status < 500 && res.status !== 429;
}

export const RecoverKit = {
  init({ key, endpoint, storage, debug } = {}) {
    if (!client) {
      const s = storage
        ? { get: (k) => storage.getItem(k), set: (k, v) => storage.setItem(k, v) }
        : memoryStorage();
      client = createClient({ key, endpoint, storage: s, transport, debug });
    }
    return RecoverKit;
  },
  screen(name) {
    if (!client) return;
    const path = '/' + String(name || '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 64);
    client.track('page_view', { path });
  },
  identify(user) { return client ? client.identify(user) : Promise.resolve(false); },
  track(type, props) { if (client) client.track(type === 'purchase' ? 'payment_signal' : type, props); },
  checkoutStarted(amountKobo) { if (client) client.track('checkout_started', { name: 'manual', amount: amountKobo }); },
  paymentScreenShown() { if (client) client.track('payment_signal', { name: 'app_success_screen' }); },
  reset() { return client ? client.reset() : Promise.resolve(); },
  flush() { return client ? client.flush() : Promise.resolve(); },
};

export default RecoverKit;
