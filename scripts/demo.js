// Starts RecoverKit with sample data so you can look around the dashboard.
//   node scripts/demo.js      then open http://localhost:8790  (demo@recoverkit.test / demo-password-123)
// Uses a throwaway database (demo.db) and a random key. Never use this for real data.
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createApp } from '../src/server.js';
import { identityHashes } from '../sdk/core/identity.js';

const DAY = 864e5;
const port = Number(process.env.PORT || 8790);
const dbPath = 'demo.db';
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });

const config = {
  masterKey: randomBytes(32), port, host: '127.0.0.1', dbPath, publicUrl: `http://localhost:${port}`, trustProxy: false,
  ai: { provider: 'none' }, allowPrivateAiUrls: false, attributionDays: 7, feePercent: 10, minDaysBetweenMessages: 7, retentionDays: 395,
};
// Demo: sign-up is open and emails are printed here instead of being sent.
config.signup = 'open';
const mailer = { enabled: true, mode: 'demo (printed in this terminal)', send: async (m) => { console.log(`\n--- email to ${m.to}: ${m.subject}\n${m.text}`); return { ok: true }; } };
const app = await createApp({ config, mailer });
const { projects, people, engine } = app;
const p = projects.create({ name: 'Ada Data & Airtime', gatewayMode: 'deposits' });
projects.createUser(p.id, 'demo@recoverkit.test', 'demo-password-123');
app.accounts.setAdmin('demo@recoverkit.test'); // so the demo shows the Admin pages too
projects.create({ name: 'Bola Stores', gatewayMode: 'sales', withKey: false });
projects.update(p.id, { voiceProfile: 'Friendly and quick. We talk like Lagos friends, small Pidgin is fine.', paymentLink: 'https://adadata.ng/buy' });
projects.setChannel(p.id, 'console', { enabled: true });
projects.addGateway(p.id, { provider: 'paystack', secret: 'sk_test_demo_secret_key' });
projects.addGateway(p.id, { provider: 'monnify', label: 'Monnify (bank transfers)', secret: 'monnify_demo_secret' });

const names = ['Chioma', 'Tunde', 'Emeka', 'Ngozi', 'Bola', 'Ifeoma', 'Segun', 'Aisha', 'Kelechi', 'Funmi', 'Yusuf', 'Zainab'];
const now = Date.now();
names.forEach((name, i) => {
  const email = `${name.toLowerCase()}@example.com`;
  const pid = people.resolve(p.id, identityHashes(p.public_key, { email }), now - (20 + i) * DAY);
  people.setContact(p.id, pid, { email, phone: `0803${String(1000000 + i * 7919).slice(0, 7)}`, firstName: name });
  const ev = (type, daysAgo, extra = {}) => engine.recordEvent(p.id, { personId: pid, layer: 3, type, ts: now - daysAgo * DAY, ...extra });
  ev('registered', 18 - i);
  if (i % 3 === 0) ev('wallet_funded', 6 - (i % 4), { amount: 200000 });
  if (i % 4 === 1) ev('checkout_started', 3, { layer: 1 });
  if (i % 5 === 2) engine.recordPurchase(p.id, { personId: pid, ref: `old-${i}`, amount: 150000, currency: 'NGN', source: 'server', ts: now - 40 * DAY });
  if (i % 6 === 5) engine.recordPurchase(p.id, { personId: pid, ref: `new-${i}`, amount: 80000, currency: 'NGN', source: 'paystack', ts: now - 2 * DAY });
});
await app.outreach.generateDrafts(p.id);

app.server.listen(port, '127.0.0.1', () => console.log(`Demo dashboard: http://localhost:${port}  (demo@recoverkit.test / demo-password-123)`));
