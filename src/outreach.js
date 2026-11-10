// Draft -> approve -> send, with safety checks right before anything is sent.
import { randomId, signToken, verifyToken } from './crypto.js';
import { adapters, chooseChannel, mask } from './channels.js';

const DAY = 864e5;
const MAX_BODY = 1600;

export function createOutreach({ db, keys, config, projects, people, engine, drafter, fetch = globalThis.fetch, logger = console }) {
  const unsubscribeUrl = (projectId, personId) =>
    `${config.publicUrl}/u/${signToken(keys.sign, { p: projectId, u: personId }, 365 * 86400)}`;

  async function generateDrafts(projectId, { limit = 20, now = Date.now() } = {}) {
    const project = projects.byId(projectId);
    const channels = projects.getChannels(project);
    const result = { drafted: 0, skipped: 0, noContact: 0 };
    const jobs = [];
    for (const lead of engine.leads(projectId, { now, limit })) {
      const contact = people.getContact(projectId, lead.personId);
      const route = chooseChannel(channels, contact);
      if (!route) { result.noContact++; continue; }
      jobs.push({ lead, contact, route });
    }
    // Draft up to 4 at a time; write results in rank order.
    const drafts = [];
    for (let i = 0; i < jobs.length; i += 4) {
      drafts.push(...await Promise.all(jobs.slice(i, i + 4).map((j) => drafter.draft({ lead: j.lead, project, channel: j.route.channel, contact: j.contact }))));
    }
    for (const [i, { lead, route }] of jobs.entries()) {
      const d = drafts[i];
      const status = !d.send ? 'skipped' : project.require_approval ? 'draft' : 'approved';
      db.run(
        `INSERT INTO messages (id, project_id, person_id, lead_type, channel, body, tactic, score, confidence, status, status_reason, drafted_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        randomId('msg_'), projectId, lead.personId, lead.leadType, route.channel, d.body.slice(0, MAX_BODY), d.tactic,
        lead.score, lead.confidence, status, d.send ? '' : 'drafter advised not to send', d.draftedBy, now,
      );
      if (status === 'skipped') result.skipped++; else result.drafted++;
    }
    projects.audit(projectId, 'system', 'drafts_generated', JSON.stringify(result));
    return result;
  }

  function cleanBody(text) {
    const t = String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (t.length < 2 || t.length > MAX_BODY) throw new Error(`message must be 2-${MAX_BODY} characters`);
    return t;
  }

  function approve(projectId, messageId, actor, editedBody) {
    const m = db.get("SELECT * FROM messages WHERE id = ? AND project_id = ? AND status = 'draft'", messageId, projectId);
    if (!m) throw new Error('draft not found');
    const body = editedBody !== undefined ? cleanBody(editedBody) : m.body;
    db.run("UPDATE messages SET status = 'approved', body = ? WHERE id = ? AND status = 'draft'", body, messageId);
    projects.audit(projectId, actor, 'approve', messageId + (body !== m.body ? ' (edited)' : ''));
  }

  function reject(projectId, messageId, actor) {
    const r = db.run("UPDATE messages SET status = 'rejected' WHERE id = ? AND project_id = ? AND status IN ('draft','approved')", messageId, projectId);
    if (!r.changes) throw new Error('message not found');
    projects.audit(projectId, actor, 'reject', messageId);
  }

  /** Why this message must not be sent right now, or null if it is safe. */
  function blocker(projectId, m, now) {
    const person = db.get('SELECT * FROM persons WHERE id = ? AND project_id = ?', m.person_id, projectId);
    if (!person) return 'person no longer exists';
    if (person.opted_out) return 'person opted out';
    // Never chase someone who has already paid.
    const since = m.lead_type === 'never_bought' ? 0 : m.created_at - DAY;
    if (engine.purchasedSince(projectId, m.person_id, since)) return 'person has purchased';
    const recent = db.get(
      "SELECT 1 FROM messages WHERE project_id = ? AND person_id = ? AND status = 'sent' AND sent_at > ? AND id != ?",
      projectId, m.person_id, now - config.minDaysBetweenMessages * DAY, m.id,
    );
    if (recent) return 'messaged too recently';
    return null;
  }

  async function sendApproved(projectId, { now = Date.now(), limit = 100 } = {}) {
    const project = projects.byId(projectId);
    const channels = projects.getChannels(project);
    const result = { sent: 0, failed: 0, skipped: 0 };
    const batch = db.all("SELECT * FROM messages WHERE project_id = ? AND status = 'approved' ORDER BY created_at LIMIT ?", projectId, limit);
    for (const m of batch) {
      // Claim it atomically so two clicks can't send twice.
      if (!db.run("UPDATE messages SET status = 'sending' WHERE id = ? AND status = 'approved'", m.id).changes) continue;
      const why = blocker(projectId, m, now);
      if (why) {
        db.run("UPDATE messages SET status = 'skipped', status_reason = ? WHERE id = ?", why, m.id);
        result.skipped++; continue;
      }
      const contact = people.getContact(projectId, m.person_id);
      const route = chooseChannel(channels, contact, m.channel);
      if (!route) {
        db.run("UPDATE messages SET status = 'failed', status_reason = 'channel or contact unavailable' WHERE id = ?", m.id);
        result.failed++; continue;
      }
      const unsub = unsubscribeUrl(projectId, m.person_id);
      let out;
      try {
        out = await adapters[route.channel](channels[route.channel], {
          to: route.to, toMasked: mask(route.to), body: m.body, subject: `A quick note from ${project.name}`,
          unsubscribeUrl: unsub, unsubscribeText: route.channel === 'email' ? `Don't want these? Unsubscribe: ${unsub}` : `Stop: ${unsub}`,
        }, { fetch, logger });
      } catch (err) {
        out = { ok: false, error: err?.name === 'TimeoutError' ? 'provider timeout' : 'provider error' };
      }
      if (out.ok) {
        db.run("UPDATE messages SET status = 'sent', sent_at = ?, status_reason = '' WHERE id = ?", now, m.id);
        result.sent++;
      } else {
        db.run("UPDATE messages SET status = 'failed', status_reason = ? WHERE id = ?", String(out.error).slice(0, 200), m.id);
        result.failed++;
      }
    }
    projects.audit(projectId, 'system', 'send', JSON.stringify(result));
    return result;
  }

  function unsubscribe(token) {
    const p = verifyToken(keys.sign, token);
    if (!p || typeof p.p !== 'string' || typeof p.u !== 'string') return false;
    db.run('UPDATE persons SET opted_out = 1 WHERE id = ? AND project_id = ?', p.u, p.p);
    db.run("UPDATE messages SET status = 'rejected', status_reason = 'opted out' WHERE person_id = ? AND project_id = ? AND status IN ('draft','approved')", p.u, p.p);
    return true;
  }

  return { generateDrafts, approve, reject, sendApproved, unsubscribe, unsubscribeUrl };
}
