// Identity resolution: turns client-side hashes into one stable person per project.
import { hmacHex, randomId, encryptJson, decryptJson } from './crypto.js';
import { normalizeEmail, normalizePhone } from '../sdk/core/identity.js';

const HASH_RE = /^[0-9a-f]{64}$/;

export function createPeople(db, keys) {
  const idKey = (projectId, clientHash) => hmacHex(keys.pepper, `${projectId}:${clientHash}`);

  function merge(projectId, fromId, intoId) {
    for (const table of ['events', 'purchases', 'messages', 'identities', 'anon_links']) {
      db.run(`UPDATE ${table} SET person_id = ? WHERE project_id = ? AND person_id = ?`, intoId, projectId, fromId);
    }
    const from = db.get('SELECT * FROM persons WHERE id = ? AND project_id = ?', fromId, projectId);
    const into = db.get('SELECT * FROM persons WHERE id = ? AND project_id = ?', intoId, projectId);
    if (from && into) {
      const contact = { ...(decryptJson(keys.enc, from.contact_enc) || {}), ...(decryptJson(keys.enc, into.contact_enc) || {}) };
      db.run(
        'UPDATE persons SET first_seen = ?, last_seen = ?, opted_out = ?, contact_enc = ? WHERE id = ?',
        Math.min(from.first_seen, into.first_seen), Math.max(from.last_seen, into.last_seen),
        from.opted_out || into.opted_out ? 1 : 0,
        Object.keys(contact).length ? encryptJson(keys.enc, contact) : null, intoId,
      );
    }
    db.run('DELETE FROM persons WHERE id = ? AND project_id = ?', fromId, projectId);
  }

  /**
   * Find or create the person for these client hashes. Merges persons if the
   * hashes (say an email and a phone) were previously seen apart.
   *
   * trusted=false (browser/app, public key): anyone can send any hash, so it may
   * only look people up or create a brand-new person. It can never merge two
   * existing people or attach a new identity to someone who already exists.
   */
  function resolve(projectId, clientHashes, now = Date.now(), { trusted = true } = {}) {
    const hashes = [...new Set((clientHashes || []).filter((h) => typeof h === 'string' && HASH_RE.test(h)))].slice(0, 4);
    if (!hashes.length) return null;
    return db.tx(() => {
      const keysFor = hashes.map((h) => idKey(projectId, h));
      const found = new Set();
      for (const k of keysFor) {
        const row = db.get('SELECT person_id FROM identities WHERE project_id = ? AND id_key = ?', projectId, k);
        if (row) found.add(row.person_id);
      }
      let personId;
      if (found.size === 0) {
        personId = randomId('per_');
        db.run('INSERT INTO persons (id, project_id, first_seen, last_seen) VALUES (?, ?, ?, ?)', personId, projectId, now, now);
      } else {
        const ids = [...found];
        const rows = ids.map((id) => db.get('SELECT id, first_seen FROM persons WHERE id = ?', id)).filter(Boolean);
        rows.sort((a, b) => a.first_seen - b.first_seen || a.id.localeCompare(b.id));
        personId = rows[0].id;
        if (!trusted) return personId;
        for (const r of rows.slice(1)) merge(projectId, r.id, personId);
        db.run('UPDATE persons SET last_seen = MAX(last_seen, ?) WHERE id = ?', now, personId);
      }
      for (const k of keysFor) {
        db.run('INSERT OR IGNORE INTO identities (project_id, id_key, person_id) VALUES (?, ?, ?)', projectId, k, personId);
      }
      return personId;
    });
  }

  /** Attach anonymous browsing to a person, including events already received. */
  function linkAnon(projectId, anonId, personId) {
    if (!anonId || !personId) return;
    db.run('INSERT OR IGNORE INTO anon_links (project_id, anon_id, person_id) VALUES (?, ?, ?)', projectId, anonId, personId);
    db.run('UPDATE events SET person_id = ? WHERE project_id = ? AND anon_id = ? AND person_id IS NULL', personId, projectId, anonId);
  }

  function personForAnon(projectId, anonId) {
    if (!anonId) return null;
    return db.get('SELECT person_id FROM anon_links WHERE project_id = ? AND anon_id = ?', projectId, anonId)?.person_id ?? null;
  }

  /** Contact details are only accepted from trusted server-side sources and stored encrypted. */
  function setContact(projectId, personId, { email, phone, firstName } = {}) {
    const row = db.get('SELECT contact_enc FROM persons WHERE id = ? AND project_id = ?', personId, projectId);
    if (!row) return;
    const c = decryptJson(keys.enc, row.contact_enc) || {};
    const e = normalizeEmail(email); if (e) c.email = e;
    const p = normalizePhone(phone); if (p) c.phone = p;
    if (typeof firstName === 'string') {
      const f = firstName.trim().replace(/[^\p{L}\p{M}' -]/gu, '').slice(0, 40);
      if (f) c.firstName = f;
    }
    db.run('UPDATE persons SET contact_enc = ? WHERE id = ?', Object.keys(c).length ? encryptJson(keys.enc, c) : null, personId);
  }

  const getContact = (projectId, personId) => {
    const row = db.get('SELECT contact_enc FROM persons WHERE id = ? AND project_id = ?', personId, projectId);
    return row ? decryptJson(keys.enc, row.contact_enc) || {} : null;
  };

  function findByHashes(projectId, clientHashes) {
    for (const h of clientHashes || []) {
      if (typeof h !== 'string' || !HASH_RE.test(h)) continue;
      const row = db.get('SELECT person_id FROM identities WHERE project_id = ? AND id_key = ?', projectId, idKey(projectId, h));
      if (row) return row.person_id;
    }
    return null;
  }

  /** Right to erasure: removes the person and everything derived from them. */
  function erase(projectId, personId) {
    db.run('DELETE FROM persons WHERE id = ? AND project_id = ?', personId, projectId);
  }

  return { resolve, linkAnon, personForAnon, setContact, getContact, findByHashes, erase, idKey };
}
