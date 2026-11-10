// Projects, API keys and per-project settings.
import { randomBytes } from 'node:crypto';
import { sha256Hex, safeEqual, randomId, encrypt, decrypt, encryptJson, decryptJson, hashPassword } from './crypto.js';
import { normalizeEmail } from '../sdk/core/identity.js';
import { PRESETS, validateSpec } from './gateways.js';
import { AI_PROVIDERS, validateAiSettings } from './ai.js';

const PUB_RE = /^rk_pub_[0-9a-f]{24}$/;
const SEC_RE = /^rk_sec_(key_[0-9a-f]{24})_([A-Za-z0-9_-]{32,64})$/;

export function createProjects(db, keys) {
  function create({ name, gatewayMode = 'sales', currency = 'NGN' }) {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('project name required (max 80 chars)');
    if (!['sales', 'deposits'].includes(gatewayMode)) throw new Error('gatewayMode must be sales or deposits');
    const id = randomId('prj_');
    const publicKey = 'rk_pub_' + randomBytes(12).toString('hex');
    db.run('INSERT INTO projects (id, name, public_key, gateway_mode, currency, created_at) VALUES (?,?,?,?,?,?)',
      id, name.trim(), publicKey, gatewayMode, currency, Date.now());
    return { id, publicKey, secretKey: createSecretKey(id, 'default') };
  }

  /** The full secret is shown once; only its hash is stored. */
  function createSecretKey(projectId, label = '') {
    const keyId = 'key_' + randomBytes(12).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    db.run('INSERT INTO api_keys (id, project_id, secret_hash, label, created_at) VALUES (?,?,?,?,?)',
      keyId, projectId, sha256Hex(secret), label.slice(0, 40), Date.now());
    return `rk_sec_${keyId}_${secret}`;
  }

  function revokeSecretKey(projectId, keyId) {
    db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL', Date.now(), keyId, projectId);
  }

  function byPublicKey(pk) {
    if (typeof pk !== 'string' || !PUB_RE.test(pk)) return null;
    return db.get('SELECT * FROM projects WHERE public_key = ?', pk) || null;
  }

  function bySecretKey(token) {
    const m = typeof token === 'string' ? SEC_RE.exec(token) : null;
    if (!m) return null;
    const row = db.get('SELECT * FROM api_keys WHERE id = ? AND revoked_at IS NULL', m[1]);
    if (!row || !safeEqual(row.secret_hash, sha256Hex(m[2]))) return null;
    return db.get('SELECT * FROM projects WHERE id = ?', row.project_id) || null;
  }

  const byId = (id) => db.get('SELECT * FROM projects WHERE id = ?', id) || null;

  function update(projectId, patch) {
    const p = byId(projectId);
    if (!p) throw new Error('no such project');
    const next = { ...p };
    if (patch.voiceProfile !== undefined) next.voice_profile = String(patch.voiceProfile).slice(0, 2000);
    if (patch.paymentLink !== undefined) {
      const l = String(patch.paymentLink).trim();
      if (l && !/^https:\/\/[^\s<>"']{3,300}$/.test(l)) throw new Error('payment link must be an https:// URL');
      next.payment_link = l;
    }
    if (patch.gatewayMode !== undefined) {
      if (!['sales', 'deposits'].includes(patch.gatewayMode)) throw new Error('gatewayMode must be sales or deposits');
      next.gateway_mode = patch.gatewayMode;
    }
    if (patch.allowedOrigins !== undefined) {
      const list = (Array.isArray(patch.allowedOrigins) ? patch.allowedOrigins : String(patch.allowedOrigins).split(/[\s,]+/))
        .map((o) => o.trim()).filter(Boolean);
      for (const o of list) if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(o)) throw new Error(`bad origin: ${o}`);
      next.allowed_origins = JSON.stringify(list.slice(0, 20));
    }
    if (patch.requireApproval !== undefined) next.require_approval = patch.requireApproval ? 1 : 0;
    db.run('UPDATE projects SET voice_profile=?, payment_link=?, gateway_mode=?, allowed_origins=?, require_approval=? WHERE id=?',
      next.voice_profile, next.payment_link, next.gateway_mode, next.allowed_origins, next.require_approval, projectId);
    return byId(projectId);
  }

  // ---------- payment gateways ----------
  function addGateway(projectId, { provider, label, secret, spec }) {
    const preset = Object.hasOwn(PRESETS, provider ?? '') ? PRESETS[provider] : null;
    if (!preset) throw new Error('unknown gateway type');
    const clean = validateSpec(spec || preset.spec);
    const sec = String(secret || '').trim();
    if (sec.length < 8 || sec.length > 500) throw new Error('enter the webhook secret from your gateway dashboard');
    const id = 'gw_' + randomBytes(12).toString('hex');
    db.run('INSERT INTO gateways (id, project_id, provider, label, spec_json, secret_enc, created_at) VALUES (?,?,?,?,?,?,?)',
      id, projectId, provider, String(label || preset.label).trim().slice(0, 60) || preset.label, JSON.stringify(clean), encrypt(keys.enc, sec), Date.now());
    return id;
  }

  function updateGateway(projectId, id, { label, secret, spec, enabled }) {
    const row = db.get('SELECT * FROM gateways WHERE id = ? AND project_id = ?', id, projectId);
    if (!row) throw new Error('gateway not found');
    const clean = spec ? validateSpec(spec) : JSON.parse(row.spec_json);
    let secretEnc = row.secret_enc;
    if (secret !== undefined && String(secret).trim()) {
      const sec = String(secret).trim();
      if (sec.length < 8 || sec.length > 500) throw new Error('secret looks wrong');
      secretEnc = encrypt(keys.enc, sec);
    }
    db.run('UPDATE gateways SET label = ?, spec_json = ?, secret_enc = ?, enabled = ? WHERE id = ? AND project_id = ?',
      label !== undefined ? (String(label).trim().slice(0, 60) || row.label) : row.label, JSON.stringify(clean), secretEnc,
      enabled === undefined ? row.enabled : enabled ? 1 : 0, id, projectId);
  }

  const deleteGateway = (projectId, id) => db.run('DELETE FROM gateways WHERE id = ? AND project_id = ?', id, projectId).changes > 0;

  /** For the webhook handler: includes the decrypted secret. */
  function getGateway(id) {
    if (typeof id !== 'string' || !/^gw_[0-9a-f]{24}$/.test(id)) return null;
    const row = db.get('SELECT * FROM gateways WHERE id = ?', id);
    if (!row) return null;
    return { ...row, spec: JSON.parse(row.spec_json), secret: decrypt(keys.enc, row.secret_enc) };
  }

  /** For the dashboard: never includes the secret. */
  const listGateways = (projectId) => db.all(
    'SELECT id, provider, label, spec_json, enabled, created_at, last_event_at, last_result FROM gateways WHERE project_id = ? ORDER BY created_at', projectId,
  ).map((g) => ({ ...g, spec: JSON.parse(g.spec_json) }));

  // ---------- AI model ----------
  const getAiSettings = (p) => decryptJson(keys.enc, p.ai_enc);
  function setAiSettings(projectId, input) {
    const p = byId(projectId);
    if (input === null) { db.run('UPDATE projects SET ai_enc = NULL WHERE id = ?', projectId); return; }
    const cur = getAiSettings(p) || {};
    const next = validateAiSettings({ ...input, apiKey: input.apiKey ? input.apiKey : (input.provider === cur.provider ? cur.apiKey : '') });
    db.run('UPDATE projects SET ai_enc = ? WHERE id = ?', encryptJson(keys.enc, next), projectId);
  }

  const getChannels = (p) => decryptJson(keys.enc, p.channels_enc) || {};
  function setChannel(projectId, name, cfg) {
    if (!['email', 'sms', 'whatsapp', 'console'].includes(name)) throw new Error('unknown channel');
    const p = byId(projectId);
    const cur = getChannels(p);
    if (cfg === null) delete cur[name]; else cur[name] = cfg;
    db.run('UPDATE projects SET channels_enc = ? WHERE id = ?', encryptJson(keys.enc, cur), projectId);
  }

  function createUser(projectId, email, password) {
    const e = normalizeEmail(email);
    if (!e) throw new Error('valid email required');
    if (typeof password !== 'string' || password.length < 12) throw new Error('password must be at least 12 characters');
    const id = randomId('usr_');
    db.run('INSERT INTO users (id, project_id, email, password_hash, created_at) VALUES (?,?,?,?,?)', id, projectId, e, hashPassword(password), Date.now());
    return id;
  }

  const audit = (projectId, actor, action, detail = '') =>
    db.run('INSERT INTO audit_log (project_id, actor, action, detail, at) VALUES (?,?,?,?,?)', projectId, actor, action, String(detail).slice(0, 500), Date.now());

  return {
    create, createSecretKey, revokeSecretKey, byPublicKey, bySecretKey, byId, update, getChannels, setChannel, createUser, audit,
    addGateway, updateGateway, deleteGateway, getGateway, listGateways, getAiSettings, setAiSettings, AI_PROVIDERS,
  };
}
