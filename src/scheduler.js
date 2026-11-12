// Background work, run every few minutes by `node src/cli.js tick` (cron) and by the app itself:
//   - draft follow-ups once a day for each business (if it has automatic drafting on)
//   - email the business when drafts are waiting for approval, and when customers reply
//   - send approved messages, only during the business's sending hours (Lagos time)
//   - back up the database once a day, keeping the last 7
import { mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const LAGOS = 3600e3; // Africa/Lagos is UTC+1 all year
export const lagosHour = (now) => new Date(now + LAGOS).getUTCHours();
export const lagosDay = (now) => new Date(now + LAGOS).toISOString().slice(0, 10);
export const KEEP_BACKUPS = 7;

export function createScheduler({ db, config, projects, outreach, mailer, logger = console }) {
  const backupDir = config.backupDir || join(dirname(config.dbPath), 'backups');

  function lease(name, ms, now) {
    db.run('INSERT OR IGNORE INTO jobs (name) VALUES (?)', name);
    return db.run('UPDATE jobs SET locked_until = ? WHERE name = ? AND locked_until < ?', now + ms, name, now).changes > 0;
  }
  const finish = (name, result, now) => db.run('UPDATE jobs SET locked_until = 0, last_run = ?, last_result = ? WHERE name = ?', now, JSON.stringify(result).slice(0, 500), name);

  const owners = (projectId) => db.all("SELECT email FROM users WHERE project_id = ? AND password_hash != ''", projectId).map((u) => u.email);
  async function tell(p, subject, text) {
    if (!mailer?.enabled || !p.notify_email) return 0;
    let n = 0;
    for (const to of owners(p.id)) if ((await mailer.send({ to, subject, text })).ok) n++;
    return n;
  }
  const footer = `\n\nYou can turn these emails off in RecoverKit: ${config.publicUrl}/dashboard/settings\n`;

  async function forProject(p, now, out) {
    const hour = lagosHour(now);
    const inHours = p.send_from <= p.send_to ? hour >= p.send_from && hour < p.send_to : hour >= p.send_from || hour < p.send_to;
    const today = lagosDay(now);
    if (p.auto_draft && inHours && p.last_auto_draft_day !== today) {
      // Mark the day first, so a failure can't cause repeated AI calls.
      db.run('UPDATE projects SET last_auto_draft_day = ? WHERE id = ?', today, p.id);
      const r = await outreach.generateDrafts(p.id, { limit: 20, now });
      out.drafted += r.drafted;
      const waiting = db.get("SELECT COUNT(*) n FROM messages WHERE project_id = ? AND status = 'draft'", p.id).n;
      if (r.drafted && p.require_approval && waiting) {
        out.emails += await tell(p, `${waiting} follow-up${waiting === 1 ? ' is' : 's are'} waiting for your approval`,
          `Hello,\n\nRecoverKit drafted follow-ups for ${p.name}. ${waiting} ${waiting === 1 ? 'message is' : 'messages are'} waiting for you to read and approve:\n${config.publicUrl}/dashboard/messages\n\nNothing is sent until you approve it.${footer}`);
      }
    }
    if (p.auto_send && inHours) {
      const pending = db.get("SELECT COUNT(*) n FROM messages WHERE project_id = ? AND status = 'approved'", p.id).n;
      if (pending) {
        const r = await outreach.sendApproved(p.id, { now, limit: 50 });
        out.sent += r.sent; out.failed += r.failed;
      }
    }
    const replies = db.get('SELECT COUNT(*) n FROM inbound WHERE project_id = ? AND received_at > ? AND is_stop = 0', p.id, p.last_reply_notice_at || 0)?.n || 0;
    if (replies && now - (p.last_reply_notice_at || 0) > 30 * 60e3) {
      db.run('UPDATE projects SET last_reply_notice_at = ? WHERE id = ?', now, p.id);
      out.emails += await tell(p, `${replies} new ${replies === 1 ? 'reply' : 'replies'} on WhatsApp`,
        `Hello,\n\nCustomers replied to ${p.name}'s follow-ups on WhatsApp. Read and answer them here:\n${config.publicUrl}/dashboard/messages?view=replies${footer}`);
    }
  }

  function backup(now, out) {
    const day = lagosDay(now);
    const file = join(backupDir, `recoverkit-${day}.db`);
    if (existsSync(file)) return;
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    db.raw.prepare('VACUUM INTO ?').run(file);
    const old = readdirSync(backupDir).filter((f) => /^recoverkit-\d{4}-\d\d-\d\d\.db$/.test(f)).sort().reverse().slice(KEEP_BACKUPS);
    for (const f of old) rmSync(join(backupDir, f), { force: true });
    out.backup = day;
  }

  function backups() {
    if (!existsSync(backupDir)) return [];
    return readdirSync(backupDir).filter((f) => /^recoverkit-\d{4}-\d\d-\d\d\.db$/.test(f)).sort().reverse()
      .map((f) => ({ file: f, size: statSync(join(backupDir, f)).size, at: statSync(join(backupDir, f)).mtimeMs }));
  }

  async function tick({ now = Date.now() } = {}) {
    if (!lease('tick', 10 * 60e3, now)) return { skipped: 'another run is in progress' };
    const out = { drafted: 0, sent: 0, failed: 0, emails: 0, errors: 0 };
    try {
      for (const p of db.all('SELECT * FROM projects')) {
        try { await forProject(p, now, out); } catch (e) { out.errors++; logger.warn?.(`[tick] ${p.id}: ${e.message}`); }
      }
      if (config.backups !== false) {
        try { backup(now, out); } catch (e) { out.errors++; logger.warn?.(`[tick] backup failed: ${e.message}`); }
      }
    } finally { finish('tick', out, Date.now()); }
    return out;
  }

  const lastRun = () => db.get("SELECT last_run, last_result FROM jobs WHERE name = 'tick'") || null;
  return { tick, backups, lastRun, backupDir };
}
