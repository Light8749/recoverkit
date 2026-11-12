// The public website: landing page, structured data, robots.txt, sitemap.xml, llms.txt, noindex.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

let app, base, dir, cfg;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rk-site-'));
  cfg = { masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 't.db'), publicUrl: 'https://recover.example.ng', trustProxy: false, ai: { provider: 'none' }, attributionDays: 7, feePercent: 10, minDaysBetweenMessages: 7 };
  app = await createApp({ config: cfg, logger: { log() {}, warn() {}, error() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

test('landing page: indexable, canonical, Open Graph, CSP-safe', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-robots-tag'), null);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await r.text();
  assert.match(html, /<title>RecoverKit: win back customers who signed up but never bought<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/recover\.example\.ng\/">/);
  assert.match(html, /<meta name="description" content="[^"]{80,200}">/);
  assert.match(html, /property="og:image" content="https:\/\/recover\.example\.ng\/static\/og\.png"/);
  assert.match(html, /<html lang="en-NG">/);
  assert.ok(!/style="/.test(html), 'no inline styles (CSP)');
  assert.ok(!/<script(?! type="application\/ld\+json")/i.test(html), 'only JSON-LD data blocks, no scripts');
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'one h1');
  assert.match(html, /10%/);
  assert.ok(!html.includes('/signup'), 'no sign-up link while sign-up is off');
});

test('structured data: SoftwareApplication and FAQPage that match the visible FAQ', async () => {
  const html = await (await fetch(base + '/')).text();
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
  const appLd = blocks.find((b) => b['@type'] === 'SoftwareApplication');
  const faqLd = blocks.find((b) => b['@type'] === 'FAQPage');
  assert.equal(appLd.url, 'https://recover.example.ng');
  assert.equal(appLd.offers.price, '0');
  assert.ok(faqLd.mainEntity.length >= 8);
  for (const q of faqLd.mainEntity) assert.ok(html.includes(`<h3>${q.name.replace(/'/g, '&#39;').replace(/"/g, '&quot;')}</h3>`), `visible: ${q.name}`);
});

test('robots.txt, sitemap.xml and llms.txt', async () => {
  const robots = await (await fetch(base + '/robots.txt')).text();
  for (const p of ['/dashboard', '/admin', '/reset/', '/dev/', '/v1/']) assert.match(robots, new RegExp(`Disallow: ${p.replace(/\//g, '\\/')}`));
  assert.match(robots, /Sitemap: https:\/\/recover\.example\.ng\/sitemap\.xml/);
  const sm = await fetch(base + '/sitemap.xml');
  assert.match(sm.headers.get('content-type'), /application\/xml/);
  const xml = await sm.text();
  assert.match(xml, /<loc>https:\/\/recover\.example\.ng\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/recover\.example\.ng\/docs<\/loc>/);
  assert.ok(!xml.includes('/dashboard'));
  const llms = await (await fetch(base + '/llms.txt')).text();
  assert.match(llms, /^# RecoverKit\n\n> /);
  assert.match(llms, /wallet deposit is not counted as a purchase/);
  assert.match(llms, /## Frequently asked questions/);
  const og = await fetch(base + '/static/og.png');
  assert.equal(og.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await og.arrayBuffer()).readUInt32BE(0), 0x89504e47);
});

test('private pages say noindex; sign-up appears in the site and sitemap only when open', async () => {
  for (const p of ['/dashboard', '/admin', '/forgot', '/reset/abc']) assert.match((await fetch(base + p, { redirect: 'manual' })).headers.get('x-robots-tag') || '', /noindex/, p);
  assert.equal((await fetch(base + '/docs')).headers.get('x-robots-tag'), null);
  // Open sign-up still needs email: without it, nothing advertises a page that would say "closed".
  cfg.signup = 'open';
  assert.ok(!(await (await fetch(base + '/')).text()).includes('href="/signup"'));
  assert.ok(!(await (await fetch(base + '/sitemap.xml')).text()).includes('/signup'));
  cfg.signup = 'off';
});

test('with sign-up open and email set up, the site and sitemap link to /signup', async () => {
  const d = mkdtempSync(join(tmpdir(), 'rk-site2-'));
  const c = { ...cfg, dbPath: join(d, 't.db'), signup: 'open' };
  const a = await createApp({ config: c, mailer: { enabled: true, mode: 'test', send: async () => ({ ok: true }) }, logger: { log() {}, warn() {}, error() {} } });
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${a.server.address().port}`;
  assert.match(await (await fetch(b + '/')).text(), /href="\/signup">Create a free account/);
  assert.match(await (await fetch(b + '/sitemap.xml')).text(), /\/signup<\/loc>/);
  assert.match(await (await fetch(b + '/llms.txt')).text(), /Create an account\]\(https:\/\/recover\.example\.ng\/signup\)/);
  await a.close(); rmSync(d, { recursive: true, force: true });
});

test('Google Search Console verification file, only when configured', async () => {
  assert.equal((await fetch(base + '/google4cdb70df215417e3.html')).status, 404);
  cfg.googleVerify = 'google4cdb70df215417e3';
  const r = await fetch(base + '/google4cdb70df215417e3.html');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'google-site-verification: google4cdb70df215417e3.html');
  assert.equal((await fetch(base + '/google0000000000000000.html')).status, 404);
  cfg.googleVerify = null;
});

test('free by default: no fee anywhere on the site, FAQ or llms.txt', async () => {
  const d = mkdtempSync(join(tmpdir(), 'rk-free-'));
  const c = { ...cfg, dbPath: join(d, 't.db'), feePercent: 0 };
  const a = await createApp({ config: c, logger: { log() {}, warn() {}, error() {} } });
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${a.server.address().port}`;
  const html = await (await fetch(b + '/')).text();
  assert.match(html, /<b>Free<\/b>/);
  assert.match(html, /no card needed/i);
  assert.ok(!/% of recovered|commission on recovered sales\./.test(html.replace('no commission on recovered sales', '')), 'no fee claims');
  const app = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1])).find((x) => x['@type'] === 'SoftwareApplication');
  assert.equal(app.isAccessibleForFree, true);
  assert.match(await (await fetch(b + '/llms.txt')).text(), /Pricing: free\./);
  await a.close(); rmSync(d, { recursive: true, force: true });
});

test('HEAD requests work like GET without a body (uptime monitors)', async () => {
  for (const p of ['/', '/health', '/blog', '/docs', '/sitemap.xml']) {
    const r = await fetch(base + p, { method: 'HEAD' });
    assert.equal(r.status, 200, p);
    assert.equal((await r.text()).length, 0, `${p}: no body`);
  }
  assert.equal((await fetch(base + '/nope', { method: 'HEAD' })).status, 404);
  assert.equal((await fetch(base + '/v1/collect', { method: 'HEAD' })).status, 405, 'POST-only endpoints still refuse');
});

test('Privacy Policy and Terms: linked, indexable, name the operator and contact', async () => {
  cfg.operatorName = 'Padi Tech Ltd'; cfg.contactEmail = 'privacy@padi.ng';
  for (const p of ['/privacy', '/terms']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, /Padi Tech Ltd/);
    assert.match(html, /href="mailto:privacy@padi\.ng"/);
    assert.match(html, /Nigeria Data Protection/);
    assert.ok(!/style="/.test(html));
  }
  assert.match(await (await fetch(base + '/privacy')).text(), /never receives names, emails or phone numbers/);
  assert.match(await (await fetch(base + '/terms')).text(), /governed by the laws of the Federal Republic of Nigeria/);
  const home = await (await fetch(base + '/')).text();
  assert.match(home, /href="\/privacy">Privacy<\/a><a href="\/terms">Terms<\/a>/);
  assert.match(await (await fetch(base + '/sitemap.xml')).text(), /\/privacy<\/loc>[\s\S]*\/terms<\/loc>/);
  cfg.operatorName = null; cfg.contactEmail = null;
  assert.match(await (await fetch(base + '/terms')).text(), /operator of RecoverKit/);
});
