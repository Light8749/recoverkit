// Runtime configuration. Every secret comes from the environment, never from code.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { aiFromEnv } from './ai.js';
import { mailFromEnv } from './mailer.js';

/** Load KEY=VALUE lines from .env if present (does not override real env vars). */
export function loadDotEnv(file = resolve(process.cwd(), '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

export function readConfig(env = process.env) {
  const masterKey = env.RK_MASTER_KEY || '';
  const raw = Buffer.from(masterKey, 'base64');
  if (raw.length < 32) {
    throw new Error('RK_MASTER_KEY must be set to at least 32 random bytes, base64-encoded. Run `npm run cli -- init`.');
  }
  const port = Number(env.PORT || 8787);
  return {
    masterKey: raw,
    port,
    host: env.HOST || '127.0.0.1',
    dbPath: env.RK_DB_PATH || resolve(process.cwd(), 'recoverkit.db'),
    publicUrl: (env.RK_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    // Behind a TLS-terminating proxy, set RK_TRUST_PROXY=1 so client IPs and https are detected.
    trustProxy: env.RK_TRUST_PROXY === '1',
    // Server-wide default model; each business can pick its own in the dashboard.
    ai: aiFromEnv(env),
    // System email for password resets and invites (see src/mailer.js).
    mail: mailFromEnv(env),
    // RK_SIGNUP=open lets businesses create their own account at /signup (needs email set up). Default: invite-only.
    signup: env.RK_SIGNUP === 'open' ? 'open' : 'off',
    // Google Search Console "HTML file" verification, e.g. RK_GOOGLE_VERIFY=google4cdb70df215417e3
    googleVerify: /^google[0-9a-f]{8,32}$/.test(env.RK_GOOGLE_VERIFY || '') ? env.RK_GOOGLE_VERIFY : null,
    // Lets a business point the AI at a private address (e.g. Ollama on this machine). Off by default (SSRF).
    allowPrivateAiUrls: env.RK_ALLOW_PRIVATE_AI_URLS === '1',
    attributionDays: Number(env.RK_ATTRIBUTION_DAYS || 7),
    feePercent: Number(env.RK_FEE_PERCENT || 10),
    minDaysBetweenMessages: Number(env.RK_MIN_DAYS_BETWEEN_MESSAGES || 7),
    // Raw events older than this are deleted (data minimisation). Purchases and messages are kept.
    retentionDays: Number(env.RK_RETENTION_DAYS || 395),
  };
}
