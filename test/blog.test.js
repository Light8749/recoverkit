// Blog: safe Markdown, admin-only writing, drafts hidden, published posts in sitemap, RSS and llms.txt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { renderMarkdown, slugify } from '../src/blog.js';

let app, base, dir, admin, user, csrf;
const PW = 'admin-password-long-1';
async function login(email, password) {
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }) });
  return r.headers.get('set-cookie')?.split(';')[0];
}
const get = (p, c) => fetch(base + p, { redirect: 'manual', headers: c ? { Cookie: c } : {} });
const post = (p, body, c) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: c }, body: new URLSearchParams(body) });
const loc = (r) => decodeURIComponent(r.headers.get('location') || '');

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rk-blog-'));
  const config = { masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 't.db'), publicUrl: 'https://recover.example.ng', trustProxy: false, ai: { provider: 'none' }, attributionDays: 7, feePercent: 10, minDaysBetweenMessages: 7 };
  app = await createApp({ config, logger: { log() {}, warn() {}, error() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const p = app.projects.create({ name: 'Padi' });
  app.projects.createUser(p.id, 'admin@padi.ng', PW);
  app.projects.createUser(p.id, 'staff@padi.ng', PW);
  app.accounts.setAdmin('admin@padi.ng');
  admin = await login('admin@padi.ng', PW);
  user = await login('staff@padi.ng', PW);
  csrf = /name="_csrf" value="([^"]+)"/.exec(await (await get('/admin/blog', admin)).text())[1];
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

test('Markdown: formatting works, HTML and unsafe links never get through', () => {
  const html = renderMarkdown('## Hello & welcome\n\nSome **bold**, *italic* and `code <b>`.\n\n- one\n- two\n\n1. first\n\n> a quote\n\n[ok](https://x.ng/a?b=1&c=2) [rel](/docs) [bad](javascript:alert(1)) [bad2](//evil.com)\n\n<script>alert(1)</script><img src=x onerror=alert(1)>\n\n```\n<b>raw</b>\n```');
  assert.match(html, /<h2 id="hello-welcome">Hello &amp; welcome<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>, <em>italic<\/em> and <code>code &lt;b&gt;<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>a quote<\/p><\/blockquote>/);
  assert.match(html, /<a href="https:\/\/x\.ng\/a\?b=1&amp;c=2" rel="noopener">ok<\/a>/);
  assert.match(html, /<a href="\/docs">rel<\/a>/);
  assert.ok(!/href="javascript/i.test(html), 'no javascript: links');
  assert.match(html, /<\/a> bad/, 'an unsafe link keeps its text but loses the link');
  assert.ok(!/href="\/\/evil/.test(html));
  assert.ok(!/<script|<img/i.test(html), 'raw HTML never becomes tags');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<pre><code>&lt;b&gt;raw&lt;\/b&gt;<\/code><\/pre>/);
  assert.equal(slugify('Why VTU customers fund — & never buy!'), 'why-vtu-customers-fund-never-buy');
});

test('only the admin can write; drafts are hidden; publishing puts the post everywhere', async () => {
  assert.equal((await get('/admin/blog', user)).status, 403);
  assert.equal((await post('/admin/blog', { _csrf: csrf, title: 'x', status: 'published' }, user)).status, 403);

  const draft = await post('/admin/blog', { _csrf: csrf, title: 'How to win back VTU customers', description: 'A short guide.', body: '## Answer first\n\nSend **one** message.', status: 'draft' }, admin);
  assert.match(loc(draft), /ok=Saved as a draft/);
  const id = /\/admin\/blog\/(post_[0-9a-f]+)/.exec(loc(draft))[1];
  assert.equal((await get('/blog/how-to-win-back-vtu-customers')).status, 404, 'drafts are not public');
  assert.ok(!(await (await get('/sitemap.xml')).text()).includes('how-to-win-back'));
  assert.match(await (await get(`/admin/blog/${id}`, admin)).text(), /Preview/);

  await post(`/admin/blog/${id}`, { _csrf: csrf, title: 'How to win back VTU customers', slug: 'win-back-vtu', description: 'A short guide.', body: '## Answer first\n\nSend **one** message.', status: 'published' }, admin);
  const page = await get('/blog/win-back-vtu');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>How to win back VTU customers \| RecoverKit<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/recover\.example\.ng\/blog\/win-back-vtu">/);
  assert.match(html, /<strong>one<\/strong>/);
  assert.ok(!/style="/.test(html) && !/<script(?! type="application\/ld\+json")/.test(html), 'CSP-safe');
  const ld = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
  assert.ok(ld.some((d) => d['@type'] === 'BlogPosting' && d.headline === 'How to win back VTU customers'));
  assert.ok(ld.some((d) => d['@type'] === 'BreadcrumbList'));

  assert.match(await (await get('/blog')).text(), /href="\/blog\/win-back-vtu"/);
  assert.match(await (await get('/sitemap.xml')).text(), /\/blog\/win-back-vtu<\/loc><lastmod>\d{4}-\d\d-\d\d<\/lastmod>/);
  const rss = await get('/blog/rss.xml');
  assert.match(rss.headers.get('content-type'), /rss\+xml/);
  assert.match(await rss.text(), /<item><title>How to win back VTU customers<\/title>/);
  assert.match(await (await get('/llms.txt')).text(), /\[How to win back VTU customers\]\(https:\/\/recover\.example\.ng\/blog\/win-back-vtu\): A short guide\./);

  // Validation: duplicate address, bad address, CSRF.
  assert.match(loc(await post('/admin/blog', { _csrf: csrf, title: 'Other', slug: 'win-back-vtu', status: 'draft' }, admin)), /already uses that web address/);
  assert.match(loc(await post('/admin/blog', { _csrf: csrf, title: 'Other', slug: 'Bad Slug!', status: 'draft' }, admin)), /lower-case letters/);
  assert.equal((await post('/admin/blog', { _csrf: 'x', title: 'Other', status: 'draft' }, admin)).status, 403);

  // Delete.
  await post(`/admin/blog/${id}/delete`, { _csrf: csrf }, admin);
  assert.equal((await get('/blog/win-back-vtu')).status, 404);
});

test('starter articles are added once, as drafts', async () => {
  assert.match(loc(await post('/admin/blog/starters', { _csrf: csrf }, admin)), /Added 3 starter articles as drafts/);
  assert.equal(app.db.get("SELECT COUNT(*) n FROM posts WHERE status = 'draft'").n, 3);
  assert.match(loc(await post('/admin/blog/starters', { _csrf: csrf }, admin)), /already here/);
  assert.equal((await get('/blog/vtu-customers-fund-wallet-never-buy')).status, 404, 'not public until published');
  const t = app.db.get("SELECT title FROM posts WHERE slug = 'win-back-customers-who-bought-once'").title;
  assert.equal(t, 'Customers who bought once and never came back: how to bring them back', 'front-matter quotes are removed');
});
