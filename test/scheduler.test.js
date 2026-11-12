// Background work: daily drafts, owner emails, sending hours, backups, leases, settings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { identityHashes } from '../sdk/core/identity.js';
import { lagosHour } from '../src/scheduler.js';

const DAY = 864e5;
// 10:00 in Lagos (09:00 UTC) on a fixed day, and 22:00 the same day.
const T10 = Date.UTC(2026, 10, 12, 9, 0, 0);
const T22 = Date.UTC(2026, 10, 12, 21, 0, 0);
let app, dir, p, cfg;
const mails = [];
const mailer = { enabled: true, mode: 'test', send: async (m) => { mails.push(m); return { ok: true }; } };
const silent = { log() {}, warn() {}, error() {} };

function addLead(email, firstName) {
  const pid = app.people.resolve(p.id, identityHashes(p.publicKey, { email }), T10 - 10 * DAY);
  app.people.setContact(p.id, pid, { email, firstName });
  app.engine.recordEvent(p.id, { layer: 3, type: 'registered', name: null, ref: null, amount: null, currency: null, ts: T10 - 10 * DAY, personId: pid });
  return pid;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rk-sched-'));
  cfg = { masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 't.db'), publicUrl: 'https://recover.example.ng', trustProxy: false, ai: { provider: 'none' }, attributionDays: 7, feePercent: 0, minDaysBetweenMessages: 7, scheduler: false };
  app = await createApp({ config: cfg, mailer, logger: silent });
  const made = app.projects.create({ name: 'Ada Data' });
  p = { ...made, ...app.projects.byId(made.id) };
  p.publicKey = made.publicKey;
  app.projects.createUser(p.id, 'owner@ada.ng', 'owner-password-long-1');
  app.projects.setChannel(p.id, 'console', { enabled: true });
  addLead('kemi@x.ng', 'Kemi');
  addLead('tunde@x.ng', 'Tunde');
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

test('Lagos time helpers', () => {
  assert.equal(lagosHour(T10), 10);
  assert.equal(lagosHour(T22), 22);
});

test('drafts once a day in sending hours, and emails the owner that drafts are waiting', async () => {
  const r1 = await app.scheduler.tick({ now: T22 });
  assert.equal(r1.drafted, 0, 'nothing outside sending hours');
  const r2 = await app.scheduler.tick({ now: T10 });
  assert.equal(r2.drafted, 2);
  assert.equal(app.db.get("SELECT COUNT(*) n FROM messages WHERE project_id = ? AND status = 'draft'", p.id).n, 2);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'owner@ada.ng');
  assert.match(mails[0].subject, /2 follow-ups are waiting for your approval/);
  assert.match(mails[0].text, /\/dashboard\/messages/);
  addLead('bola@x.ng', 'Bola');
  const r3 = await app.scheduler.tick({ now: T10 + 3600e3 });
  assert.equal(r3.drafted, 0, 'only once per day');
  assert.equal(mails.length, 1);
  const r4 = await app.scheduler.tick({ now: T10 + DAY });
  assert.equal(r4.drafted, 1, 'the next day drafts the new lead only');
});

test('sends approved messages only during sending hours', async () => {
  const ids = app.db.all("SELECT id FROM messages WHERE project_id = ? AND status = 'draft'", p.id).map((m) => m.id);
  for (const id of ids) app.outreach.approve(p.id, id, 'owner@ada.ng');
  const night = await app.scheduler.tick({ now: T22 + DAY });
  assert.equal(night.sent, 0);
  const morning = await app.scheduler.tick({ now: T10 + 2 * DAY });
  assert.equal(morning.sent, ids.length);
  assert.equal(app.db.get("SELECT COUNT(*) n FROM messages WHERE project_id = ? AND status = 'sent'", p.id).n, ids.length);
});

test('automatic drafting and sending can be turned off; windows can cross midnight', async () => {
  app.projects.update(p.id, { autoDraft: false, autoSend: false });
  addLead('chidi@x.ng', 'Chidi');
  assert.equal((await app.scheduler.tick({ now: T10 + 3 * DAY })).drafted, 0);
  app.projects.update(p.id, { autoDraft: true, sendFrom: 20, sendTo: 2 });
  assert.equal((await app.scheduler.tick({ now: T10 + 4 * DAY })).drafted, 0, '10:00 is outside 20:00-02:00');
  assert.equal((await app.scheduler.tick({ now: T22 + 4 * DAY })).drafted, 1, '22:00 is inside');
  assert.throws(() => app.projects.update(p.id, { sendFrom: 9, sendTo: 9 }), /at least one hour/);
  assert.throws(() => app.projects.update(p.id, { sendFrom: 25 }), /between 0 and 23/);
  app.projects.update(p.id, { autoSend: true, sendFrom: 9, sendTo: 19 });
});

test('no owner email when notifications are off or approval is not required', async () => {
  app.projects.update(p.id, { notifyEmail: false });
  mails.length = 0;
  addLead('emeka@x.ng', 'Emeka');
  await app.scheduler.tick({ now: T10 + 5 * DAY });
  assert.equal(mails.length, 0);
  app.projects.update(p.id, { notifyEmail: true });
});

test('daily backups, keeping the last 7', async () => {
  const bdir = app.scheduler.backupDir;
  // Pretend 9 earlier days of backups exist.
  for (let d = 1; d <= 9; d++) writeFileSync(join(bdir, `recoverkit-2026-10-0${d}.db`), 'x');
  await app.scheduler.tick({ now: T10 + 6 * DAY });
  const files = readdirSync(bdir).filter((f) => f.endsWith('.db')).sort();
  assert.equal(files.length, 7);
  assert.ok(files.includes('recoverkit-2026-11-18.db'), 'today\'s backup made');
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(join(bdir, 'recoverkit-2026-11-18.db'));
  assert.ok(copy.prepare('SELECT COUNT(*) n FROM projects').get().n >= 1, 'the backup is a working database');
  copy.close();
  assert.equal(app.scheduler.backups().length, 7);
});

test('a lease stops two runs at once (cron and the app)', async () => {
  const now = T10 + 7 * DAY;
  app.db.run("UPDATE jobs SET locked_until = ? WHERE name = 'tick'", now + 60e3);
  assert.deepEqual(await app.scheduler.tick({ now }), { skipped: 'another run is in progress' });
  app.db.run("UPDATE jobs SET locked_until = 0 WHERE name = 'tick'");
  assert.ok(!(await app.scheduler.tick({ now })).skipped);
  assert.ok(app.scheduler.lastRun().last_run > 0);
});
