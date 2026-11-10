// Events -> purchases -> funnel stages -> ranked leads -> recovered revenue.
import { sha256Hex } from './crypto.js';

const DAY = 864e5;
const HOUR = 36e5;
export const LAPSE_DAYS = 30;
// Two reports of the same payment without a shared reference are merged when
// they are for the same person and amount within this window.
const DEDUPE_WINDOW = 15 * 60e3;

export function createEngine(db, config) {
  /** Returns true if the event was stored (false when its sourceKey was already seen). */
  function recordEvent(projectId, ev) {
    const r = db.run(
      'INSERT OR IGNORE INTO events (project_id, person_id, anon_id, layer, type, name, amount, currency, ts, received_at, source_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      projectId, ev.personId ?? null, ev.anonId ?? null, ev.layer, ev.type, ev.name ?? null,
      ev.amount ?? null, ev.currency ?? null, ev.ts, Date.now(), ev.sourceKey ?? null,
    );
    if (!r.changes) return false;
    if (ev.personId) db.run('UPDATE persons SET last_seen = MAX(last_seen, ?) WHERE id = ?', ev.ts, ev.personId);
    return true;
  }

  /** Attribute a purchase to the most recent message sent within the window before it. */
  function attribute(projectId, personId, ts) {
    if (!personId) return null;
    const m = db.get(
      `SELECT id FROM messages WHERE project_id = ? AND person_id = ? AND status = 'sent'
       AND sent_at <= ? AND sent_at >= ? ORDER BY sent_at DESC LIMIT 1`,
      projectId, personId, ts, ts - config.attributionDays * DAY,
    );
    return m?.id ?? null;
  }

  /**
   * Record a verified purchase (layer 2 or 3). Returns {id, merged}.
   * A webhook and a server call for one payment produce one row.
   */
  function recordPurchase(projectId, { personId, ref, amount, currency, source, ts }) {
    return db.tx(() => {
      const refKey = ref ? sha256Hex(`${projectId}:${ref}`) : null;
      let row = refKey ? db.get('SELECT * FROM purchases WHERE project_id = ? AND ref_key = ?', projectId, refKey) : null;
      if (!row && personId) {
        // Fallback: same person, same amount, close in time, reported by a different source.
        const near = db.all(
          `SELECT * FROM purchases WHERE project_id = ? AND person_id = ? AND amount = ? AND ts BETWEEN ? AND ?`,
          projectId, personId, amount, ts - DEDUPE_WINDOW, ts + DEDUPE_WINDOW,
        );
        row = near.find((p) => !p.sources.split(',').includes(source) && (!refKey || !p.ref_key)) || null;
      }
      if (row) {
        const sources = [...new Set([...row.sources.split(','), source])].sort().join(',');
        db.run(
          'UPDATE purchases SET sources = ?, person_id = COALESCE(person_id, ?), ref_key = COALESCE(ref_key, ?) WHERE id = ?',
          sources, personId ?? null, refKey, row.id,
        );
        return { id: row.id, merged: true };
      }
      const r = db.run(
        'INSERT INTO purchases (project_id, person_id, ref_key, amount, currency, sources, ts, attributed_message_id) VALUES (?,?,?,?,?,?,?,?)',
        projectId, personId ?? null, refKey, amount, currency, source, ts, attribute(projectId, personId, ts),
      );
      return { id: Number(r.lastInsertRowid), merged: false };
    });
  }

  /** Has this project ever sent us verified purchase data? Without it we can't tell buyers apart. */
  function hasVerifiedSource(projectId) {
    return Boolean(db.get('SELECT 1 FROM purchases WHERE project_id = ? LIMIT 1', projectId)
      || db.get("SELECT 1 FROM events WHERE project_id = ? AND layer IN (2,3) LIMIT 1", projectId));
  }

  /** Build one person's journey and work out lead type, stage, score and confidence. */
  function assess(projectId, person, now, verified) {
    const events = db.all(
      'SELECT layer, type, name, amount, ts FROM events WHERE project_id = ? AND person_id = ? ORDER BY ts ASC LIMIT 500',
      projectId, person.id,
    );
    const purchases = db.all('SELECT amount, ts FROM purchases WHERE project_id = ? AND person_id = ? ORDER BY ts ASC', projectId, person.id);
    const lastPurchase = purchases.at(-1)?.ts ?? null;
    const lastActivity = Math.max(person.last_seen, ...events.map((e) => e.ts));
    const after = (t) => (e) => lastPurchase === null || e.ts > t;
    const since = events.filter(after(lastPurchase));
    const has = (pred) => since.some(pred);
    const viewedPricing = has((e) => e.type === 'page_view' && /pric|plan|checkout|cart|buy|product|data|airtime/i.test(e.name || ''));
    const checkout = has((e) => e.type === 'checkout_started');
    const funded = has((e) => e.type === 'wallet_funded');
    const paySignal = since.filter((e) => e.type === 'payment_signal').at(-1)?.ts ?? null;
    const cartValue = since.filter((e) => e.amount).at(-1)?.amount ?? null;

    let leadType = null; let stage;
    if (purchases.length === 0) {
      leadType = 'never_bought';
      stage = funded ? 'funded_not_bought' : checkout ? 'checkout_abandoned' : viewedPricing ? 'browsed' : 'registered';
    } else if (now - lastPurchase > LAPSE_DAYS * DAY) {
      leadType = 'lapsed';
      stage = purchases.length > 1 ? 'lapsed_repeat' : 'bought_once';
    } else {
      stage = purchases.length > 1 ? 'repeat_customer' : 'new_customer';
    }

    // Score: intent signals plus recency. 0-100.
    let score = 20;
    if (viewedPricing) score += 15;
    if (checkout) score += 25;
    if (funded) score += 30;
    if (leadType === 'lapsed') score += Math.min(25, purchases.length * 8);
    const idleDays = (now - lastActivity) / DAY;
    score += idleDays < 3 ? 15 : idleDays < 14 ? 10 : idleDays < 45 ? 0 : -15;
    score = Math.max(0, Math.min(100, Math.round(score)));

    // Confidence that this person really has NOT paid (or really has lapsed).
    let confidence = verified ? 0.9 : 0.4;
    const reasons = [];
    if (!verified) reasons.push('no verified purchase data from webhooks or server yet');
    if (paySignal) { confidence -= 0.5; reasons.push('browser saw a payment-success screen without a verified purchase'); }
    if (now - lastActivity < 2 * HOUR) { confidence -= 0.3; reasons.push('active in the last 2 hours, may still be buying'); }
    confidence = Math.max(0, Math.round(confidence * 100) / 100);

    const journey = events.slice(-15).map((e) => ({
      daysAgo: Math.round(((now - e.ts) / DAY) * 10) / 10,
      layer: e.layer, type: e.type, name: e.name, amount: e.amount,
    }));
    return {
      personId: person.id, leadType, stage, score, confidence, reasons, journey,
      purchases: purchases.length, lastPurchaseDaysAgo: lastPurchase ? Math.round((now - lastPurchase) / DAY) : null,
      idleDays: Math.round(idleDays * 10) / 10, cartValue, optedOut: Boolean(person.opted_out),
    };
  }

  /** Ranked follow-up list. Excludes opted-out people and anyone messaged recently. */
  function leads(projectId, { now = Date.now(), minConfidence = 0.6, limit = 100 } = {}) {
    const verified = hasVerifiedSource(projectId);
    const recentCut = now - config.minDaysBetweenMessages * DAY;
    const people = db.all(
      `SELECT p.* FROM persons p WHERE p.project_id = ? AND p.opted_out = 0
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.person_id = p.id AND m.project_id = p.project_id
         AND (m.status IN ('draft','approved') OR (m.status = 'sent' AND m.sent_at > ?)))
       ORDER BY p.last_seen DESC LIMIT 5000`,
      projectId, recentCut,
    );
    return people
      .map((p) => assess(projectId, p, now, verified))
      .filter((a) => a.leadType && a.confidence >= minConfidence)
      .sort((a, b) => b.score * b.confidence - a.score * a.confidence)
      .slice(0, limit);
  }

  function funnel(projectId, now = Date.now()) {
    const verified = hasVerifiedSource(projectId);
    const counts = {};
    for (const p of db.all('SELECT * FROM persons WHERE project_id = ? LIMIT 20000', projectId)) {
      const a = assess(projectId, p, now, verified);
      counts[a.stage] = (counts[a.stage] || 0) + 1;
    }
    const anonymous = db.get(
      `SELECT COUNT(DISTINCT anon_id) n FROM events WHERE project_id = ? AND person_id IS NULL AND anon_id IS NOT NULL`, projectId,
    ).n;
    return { anonymous, ...counts, verified };
  }

  function revenue(projectId) {
    const r = db.get(
      `SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM purchases WHERE project_id = ? AND attributed_message_id IS NOT NULL`, projectId,
    );
    const sent = db.get(`SELECT COUNT(*) n FROM messages WHERE project_id = ? AND status = 'sent'`, projectId).n;
    return { recoveredPurchases: r.n, recoveredAmount: r.total, fee: Math.round(r.total * config.feePercent / 100), messagesSent: sent };
  }

  /** Before sending: did this person buy since the lead was computed? */
  function purchasedSince(projectId, personId, ts) {
    return Boolean(db.get('SELECT 1 FROM purchases WHERE project_id = ? AND person_id = ? AND ts >= ? LIMIT 1', projectId, personId, ts));
  }

  return { recordEvent, recordPurchase, leads, assess, funnel, revenue, purchasedSince, hasVerifiedSource };
}
