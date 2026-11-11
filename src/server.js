// RecoverKit server: ingestion API, webhooks, dashboard.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDotEnv, readConfig } from './config.js';
import { deriveKeys } from './crypto.js';
import { openDb } from './db.js';
import { HttpError, Router, RateLimiter, send, sendHtml, redirect, readBody, isSecure } from './http.js';
import { createProjects } from './projects.js';
import { createPeople } from './people.js';
import { createEngine } from './engine.js';
import { createIngest } from './ingest.js';
import { createWebhooks } from './webhooks.js';
import { createDrafter } from './ai.js';
import { createConnectorApi } from './connector.js';
import { createOutreach } from './outreach.js';
import { createDashboard, esc } from './dashboard/index.js';
import { assets } from './dashboard/ui.js';
import { createHash } from 'node:crypto';
import { buildBrowserBundle } from '../scripts/build-browser.js';
import { brandSvg } from '../scripts/build-brand.js';
import { loadDownloads, PHP_FILES } from './downloads.js';
import { createAccounts } from './accounts.js';
import { createMailer } from './mailer.js';
import { landingPage, robotsTxt, sitemapXml, llmsTxt } from './site.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function createApp({ config, fetch = globalThis.fetch, anthropicFactory, resolver, logger = console, mailer } = {}) {
  const keys = deriveKeys(config.masterKey);
  const db = openDb(config.dbPath);
  const limiter = new RateLimiter();
  const projects = createProjects(db, keys);
  const people = createPeople(db, keys);
  const engine = createEngine(db, config);

  if (!anthropicFactory) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const clients = new Map();
    // One client per API key. With no key the SDK uses ANTHROPIC_API_KEY / an `ant auth login` profile.
    anthropicFactory = (apiKey) => {
      const k = apiKey || '';
      if (!clients.has(k)) clients.set(k, new Anthropic({ ...(apiKey ? { apiKey } : {}), timeout: 60_000, maxRetries: 2 }));
      return clients.get(k);
    };
  }
  const resolveAi = (project) => projects.getAiSettings(project) || config.ai || { provider: 'none' };
  const drafter = createDrafter({
    resolveAi, logger, fetch, anthropicFactory, resolver, allowPrivateAiUrls: config.allowPrivateAiUrls,
  });
  const outreach = createOutreach({ db, keys, config, projects, people, engine, drafter, fetch, logger });
  const accounts = createAccounts(db);
  mailer ||= createMailer(config.mail, { fetch, logger });
  const deps = { db, config, keys, accounts, mailer, logger, projects, people, engine, limiter, outreach, drafter, resolveAi };
  const ingest = createIngest(deps);
  const webhooks = createWebhooks(deps);
  const connector = createConnectorApi({ ...deps, requireSecret: ingest.requireSecret, deps: { fetch, anthropicFactory, resolver, allowPrivateAiUrls: config.allowPrivateAiUrls } });
  const dash = createDashboard(deps);

  const css = readFileSync(join(here, 'dashboard/app.css'));
  assets.css = `/static/app.css?v=${createHash('sha256').update(css).digest('hex').slice(0, 10)}`;
  const sdkJs = buildBrowserBundle();
  const favicon = brandSvg('mark');
  const ogPath = join(here, '../assets/brand/og.png');
  const ogImage = existsSync(ogPath) ? readFileSync(ogPath) : null;
  const signupLive = () => config.signup === 'open' && mailer.enabled;
  const text = (body, type) => (_q, res) => send(res, 200, body(), { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
  const downloads = loadDownloads();
  // Downloads are plain text with an attachment header: a browser saves them, never runs them.
  const download = (name, body, type = 'text/plain; charset=utf-8') => (_q, res) => send(res, 200, body, {
    'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'public, max-age=3600',
  });

  const r = new Router()
    .add('GET', '/health', (_q, res) => send(res, 200, { ok: true }))
    .add('GET', '/static/app.css', (_q, res) => send(res, 200, css, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }))
    .add('GET', '/static/kobo.svg', (_q, res) => send(res, 200, favicon, {
      'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    }))
    .add('GET', '/sdk/recoverkit.js', (_q, res) => send(res, 200, sdkJs, {
      'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Cross-Origin-Resource-Policy': 'cross-origin',
    }))
    .add('GET', '/sdk/recoverkit-php.zip', download('recoverkit-php.zip', downloads.zip, 'application/zip'))
    .add('GET', '/sdk/LICENSE', download('LICENSE', downloads.license))
    .add('GET', '/docs', dash.docsPage)
    .add('OPTIONS', '/v1/collect', ingest.collectPreflight)
    .add('POST', '/v1/collect', ingest.collect)
    .add('POST', '/v1/server/events', ingest.serverEvents)
    .add('POST', '/v1/server/erase', ingest.serverErase)
    .add('POST', '/v1/connector/suggest', connector.suggest)
    .add('POST', '/v1/connector/sync', connector.sync)
    .add('POST', '/v1/webhooks/:gatewayId', webhooks.receive)
    .add('GET', '/', (req, res) => sendHtml(res, 200, landingPage(config, { signedIn: dash.isSignedIn(req), signupOpen: signupLive() }), { 'Cache-Control': 'no-cache' }))
    .add('GET', '/robots.txt', text(() => robotsTxt(config), 'text/plain; charset=utf-8'))
    .add('GET', '/sitemap.xml', text(() => sitemapXml(config, signupLive()), 'application/xml; charset=utf-8'))
    .add('GET', '/llms.txt', text(() => llmsTxt(config, signupLive()), 'text/plain; charset=utf-8'))
    .add('GET', '/static/og.png', (_q, res) => (ogImage ? send(res, 200, ogImage, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Cross-Origin-Resource-Policy': 'cross-origin' }) : send(res, 404, { error: 'not found' })))
    .add('GET', '/login', dash.loginPage)
    .add('POST', '/login', dash.login)
    .add('POST', '/logout', dash.logout)
    .add('GET', '/signup', dash.signupPage)
    .add('POST', '/signup', dash.signup)
    .add('GET', '/forgot', dash.forgotPage)
    .add('POST', '/forgot', dash.forgot)
    .add('GET', '/reset/:token', dash.resetPage)
    .add('POST', '/reset/:token', dash.reset)
    .add('POST', '/dashboard/password', dash.changePasswordAction)
    .add('GET', '/admin', dash.adminPage)
    .add('POST', '/admin/businesses', dash.addBusinessAction)
    .add('GET', '/admin/businesses/:id', dash.adminBusinessPage)
    .add('POST', '/admin/businesses/:id/users', dash.addUserAction)
    .add('POST', '/admin/users/:id/link', dash.userLinkAction)
    .add('POST', '/admin/mail-test', dash.mailTestAction)
    .add('GET', '/dashboard', dash.overview)
    .add('GET', '/dashboard/leads', dash.leadsPage)
    .add('GET', '/dashboard/messages', dash.messagesPage)
    .add('POST', '/dashboard/drafts', dash.draftsAction)
    .add('POST', '/dashboard/send', dash.sendAction)
    .add('POST', '/dashboard/messages/:id/approve', dash.approveAction)
    .add('POST', '/dashboard/messages/:id/reject', dash.rejectAction)
    .add('GET', '/dashboard/payments', dash.paymentsPage)
    .add('GET', '/dashboard/payments/new', dash.newGatewayPage)
    .add('POST', '/dashboard/payments', dash.createGatewayAction)
    .add('POST', '/dashboard/payments/mode', dash.modeAction)
    .add('GET', '/dashboard/payments/:id', dash.gatewayPage)
    .add('POST', '/dashboard/payments/:id', dash.updateGatewayAction)
    .add('POST', '/dashboard/payments/:id/delete', dash.deleteGatewayAction)
    .add('GET', '/dashboard/ai', dash.aiPage)
    .add('POST', '/dashboard/ai', dash.aiSaveAction)
    .add('POST', '/dashboard/ai/test', dash.aiTestAction)
    .add('POST', '/dashboard/ai/reset', dash.aiResetAction)
    .add('GET', '/dashboard/channels', dash.channelsPage)
    .add('POST', '/dashboard/channels', dash.channelsAction)
    .add('GET', '/dashboard/developers', dash.developersPage)
    .add('POST', '/dashboard/developers/key', dash.developerKeyAction)
    .add('GET', '/dashboard/settings', dash.settingsPage)
    .add('POST', '/dashboard/settings', dash.settingsAction)
    .add('POST', '/dashboard/keys', dash.newKeyAction)
    .add('POST', '/dashboard/keys/:id/revoke', dash.revokeKeyAction);
  for (const f of PHP_FILES) r.add('GET', `/sdk/php/${f}`, download(f, downloads.php[f]));

  // Unsubscribe links carry a signed token, so they're routed separately.
  const UNSUB = /^\/u\/([A-Za-z0-9_-]{10,400}\.[A-Za-z0-9_-]{20,100})$/;
  const GUIDE = /^\/dev\/([A-Za-z0-9_-]{10,400}\.[A-Za-z0-9_-]{20,100})$/;
  async function unsubscribe(req, res, token) {
    if (req.method === 'GET') {
      return sendHtml(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${assets.css}">
        <main class="content"><div class="auth"><h1>Stop these messages?</h1><p class="subtitle">You won't hear from this business through RecoverKit again.</p><form method="post"><button class="btn prominent wide">Unsubscribe</button></form></div></main>`);
    }
    if (req.method === 'POST') {
      await readBody(req, 1024).catch(() => {});
      const ok = outreach.unsubscribe(token);
      return sendHtml(res, ok ? 200 : 400, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${assets.css}"><main class="content"><div class="auth"><h1>${ok ? 'You\'re unsubscribed' : 'This link has expired'}</h1></div></main>`);
    }
    send(res, 405, { error: 'method not allowed' });
  }

  async function handle(req, res) {
    res.rkSecure = isSecure(req, config.trustProxy);
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, { error: 'bad url' }); }
    try {
      const u = UNSUB.exec(url.pathname);
      if (u) return await unsubscribe(req, res, u[1]);
      const g = GUIDE.exec(url.pathname);
      if (g) return req.method === 'GET' ? dash.sharedGuidePage(req, res, { token: g[1] }) : send(res, 405, { error: 'method not allowed' });
      // Signed-in and one-time pages never belong in search results.
      if (/^\/(dashboard|admin|reset|forgot|dev|u)(\/|$)/.test(url.pathname)) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      const m = r.match(req.method, url.pathname);
      if (!m) return send(res, 404, { error: 'not found' });
      if (m.status) return send(res, m.status, { error: 'method not allowed' });
      await m.handler(req, res, m.params, url);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 303 && err.location) return redirect(res, err.location);
        const body = { error: err.expose ? err.message : 'error' };
        if (/^\/(dashboard|admin|reset)(\/|$)/.test(url.pathname) || ['/logout', '/login', '/forgot', '/signup'].includes(url.pathname)) {
          return sendHtml(res, err.status, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${assets.css}"><main class="content"><div class="banner err" role="alert"><span>${esc(err.message)}</span></div><a class="btn tinted" href="/dashboard">Back to dashboard</a></main>`);
        }
        return send(res, err.status, body);
      }
      logger.error?.(`[error] ${req.method} ${url.pathname}: ${err?.stack || err}`);
      send(res, 500, { error: 'internal error' });
    }
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000, maxHeaderSize: 16 * 1024 }, (req, res) => {
    handle(req, res).catch(() => { try { send(res, 500, { error: 'internal error' }); } catch { /* socket gone */ } });
  });
  server.keepAliveTimeout = 5_000;

  function purgeOld() {
    const cut = Date.now() - (config.retentionDays || 395) * 864e5;
    db.run('DELETE FROM events WHERE ts < ?', cut);
    db.run('DELETE FROM webhook_seen WHERE seen_at < ?', cut);
    db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    // Self-service sign-ups that never confirmed their email: removed once the 7-day link has expired.
    db.run(`DELETE FROM projects WHERE source = 'signup' AND created_at < ?
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.project_id = projects.id AND u.password_hash != '')
      AND NOT EXISTS (SELECT 1 FROM password_tokens t JOIN users u ON u.id = t.user_id WHERE u.project_id = projects.id AND t.expires_at > ?)`,
    Date.now() - 8 * 864e5, Date.now());
  }
  purgeOld();
  const purgeTimer = setInterval(purgeOld, 6 * 36e5);
  purgeTimer.unref();

  function close() {
    clearInterval(purgeTimer);
    limiter.stop();
    return new Promise((resolve) => server.close(() => { db.close(); resolve(); }));
  }

  return { server, db, keys, accounts, projects, purgeOld, people, engine, outreach, limiter, close };
}

// Run directly: `node src/server.js`
// Run directly: `node src/server.js` (cPanel uses app.cjs, which loads src/start.js the same way).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await import('./start.js');
}
