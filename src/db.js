// SQLite storage (node:sqlite, no native dependency). Every query is parameterised.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  -- 'sales': a successful gateway payment is a sale (stores, subscriptions)
  -- 'deposits': gateway payments only fund a wallet; sales come from layer 3 (VTU, betting, fintech)
  gateway_mode TEXT NOT NULL DEFAULT 'sales' CHECK (gateway_mode IN ('sales','deposits')),
  currency TEXT NOT NULL DEFAULT 'NGN',
  allowed_origins TEXT NOT NULL DEFAULT '[]',
  voice_profile TEXT NOT NULL DEFAULT '',
  payment_link TEXT NOT NULL DEFAULT '',
  require_approval INTEGER NOT NULL DEFAULT 1,
  channels_enc TEXT,
  -- {provider, model, apiKey, baseUrl}, encrypted. NULL = use the server default.
  ai_enc TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  contact_enc TEXT,
  opted_out INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS persons_project ON persons(project_id);

-- identity key = HMAC(pepper, client hash). Neither value can be reversed without the server pepper.
CREATE TABLE IF NOT EXISTS identities (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id_key TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, id_key)
);
CREATE INDEX IF NOT EXISTS identities_person ON identities(person_id);

CREATE TABLE IF NOT EXISTS anon_links (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  anon_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, anon_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  person_id TEXT REFERENCES persons(id) ON DELETE CASCADE,
  anon_id TEXT,
  layer INTEGER NOT NULL,
  type TEXT NOT NULL,
  name TEXT,
  amount INTEGER,
  currency TEXT,
  ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_person ON events(project_id, person_id, ts);
CREATE INDEX IF NOT EXISTS events_anon ON events(project_id, anon_id);

-- Last runs of each project's read-only connector (shown in the dashboard).
CREATE TABLE IF NOT EXISTS connector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  source TEXT NOT NULL,
  version TEXT NOT NULL,
  people INTEGER NOT NULL,
  events INTEGER NOT NULL,
  new_events INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS connector_runs_project ON connector_runs(project_id, at);

-- One row per real purchase. Webhook + server reports of the same payment merge into one row.
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- SET NULL: erasing a person keeps the anonymous revenue record for billing.
  person_id TEXT REFERENCES persons(id) ON DELETE SET NULL,
  ref_key TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  sources TEXT NOT NULL,
  ts INTEGER NOT NULL,
  attributed_message_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS purchases_ref ON purchases(project_id, ref_key) WHERE ref_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchases_person ON purchases(project_id, person_id, ts);

-- Any number of payment gateways per project. spec_json says how to verify and read webhooks.
CREATE TABLE IF NOT EXISTS gateways (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_event_at INTEGER,
  last_result TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS gateways_project ON gateways(project_id);

-- Webhook replay protection.
CREATE TABLE IF NOT EXISTS webhook_seen (
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, provider, event_key)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  lead_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  body TEXT NOT NULL,
  tactic TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','approved','sending','sent','failed','rejected','skipped')),
  status_reason TEXT NOT NULL DEFAULT '',
  drafted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_project ON messages(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS messages_person ON messages(project_id, person_id, sent_at);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // Migration: events.source_key makes connector re-syncs idempotent.
  if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'source_key')) db.exec('ALTER TABLE events ADD COLUMN source_key TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS events_source_key ON events(project_id, source_key) WHERE source_key IS NOT NULL');
  const cache = new Map();
  let depth = 0;
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  return {
    raw: db,
    get: (sql, ...p) => prep(sql).get(...p),
    all: (sql, ...p) => prep(sql).all(...p),
    run: (sql, ...p) => prep(sql).run(...p),
    // Re-entrant: nested calls join the outer transaction.
    tx(fn) {
      if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
      db.exec('BEGIN IMMEDIATE'); depth = 1;
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth = 0; }
    },
    close: () => db.close(),
  };
}
