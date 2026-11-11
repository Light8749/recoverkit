// Dashboard logins: passwords, invite and reset links, admin flag.
import { randomToken, sha256Hex, randomId, hashPassword, verifyPassword } from './crypto.js';
import { normalizeEmail } from '../sdk/core/identity.js';

export const RESET_MINUTES = 60;
export const INVITE_DAYS = 7;

export function checkPassword(pw, confirm) {
  if (typeof pw !== 'string' || pw.length < 12) throw new Error('Use at least 12 characters.');
  if (pw.length > 200) throw new Error('Use at most 200 characters.');
  if (confirm !== undefined && pw !== confirm) throw new Error('The two passwords don\'t match.');
  return pw;
}

export function createAccounts(db) {
  const byEmail = (email) => {
    const e = normalizeEmail(email);
    return e ? db.get('SELECT * FROM users WHERE email = ?', e) || null : null;
  };
  const byId = (id) => db.get('SELECT * FROM users WHERE id = ?', id) || null;

  /** A login with no password yet: it can only be activated through an invite link. */
  function invite(projectId, email) {
    const e = normalizeEmail(email);
    if (!e) throw new Error('Enter a valid email address.');
    if (db.get('SELECT 1 FROM users WHERE email = ?', e)) throw new Error('That email already has a RecoverKit login.');
    const id = randomId('usr_');
    db.run("INSERT INTO users (id, project_id, email, password_hash, created_at) VALUES (?,?,?,'',?)", id, projectId, e, Date.now());
    return { userId: id, token: issue(id, 'invite') };
  }

  /** Returns the raw token (for the link). Older unused links of the same kind stop working. */
  function issue(userId, purpose, minutes = purpose === 'invite' ? INVITE_DAYS * 1440 : RESET_MINUTES) {
    const token = randomToken(32);
    db.tx(() => {
      db.run('DELETE FROM password_tokens WHERE user_id = ? AND (purpose = ? OR expires_at < ? OR used_at IS NOT NULL)', userId, purpose, Date.now());
      db.run('INSERT INTO password_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?,?,?,?,?)',
        sha256Hex(token), userId, purpose, Date.now(), Date.now() + minutes * 60e3);
    });
    return token;
  }

  function lookup(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
    const t = db.get('SELECT * FROM password_tokens WHERE token_hash = ?', sha256Hex(token));
    if (!t || t.used_at || t.expires_at < Date.now()) return null;
    const user = byId(t.user_id);
    return user ? { ...t, user } : null;
  }

  /** Sets the password, burns every link for the user and signs out all their sessions. */
  function redeem(token, password) {
    return db.tx(() => {
      const t = lookup(token);
      if (!t) throw new Error('This link has expired or was already used.');
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), t.user_id);
      db.run('DELETE FROM password_tokens WHERE user_id = ?', t.user_id);
      db.run('DELETE FROM sessions WHERE user_id = ?', t.user_id);
      return t.user;
    });
  }

  /** Signed-in change: needs the current password; other sessions are signed out. */
  function changePassword(userId, current, next, keepSessionHash) {
    const u = byId(userId);
    if (!u || !verifyPassword(String(current || '').slice(0, 200), u.password_hash)) throw new Error('Your current password is wrong.');
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), userId);
      db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, keepSessionHash || '');
      db.run('DELETE FROM password_tokens WHERE user_id = ?', userId);
    });
  }

  function setAdmin(email, on = true) {
    const u = byEmail(email);
    if (!u) throw new Error('no user with that email');
    db.run('UPDATE users SET is_admin = ? WHERE id = ?', on ? 1 : 0, u.id);
    return u.id;
  }

  return { byEmail, byId, invite, issue, lookup, redeem, changePassword, setAdmin };
}
