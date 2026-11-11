// Blog posts: storage and a small, safe Markdown renderer.
// Everything is escaped first; only the formatting below becomes HTML, and links must be
// http(s), mailto or same-site paths, so a post can never inject scripts or styles.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomId } from './crypto.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');

function safeHref(url) {
  const u = String(url).trim();
  if (/^(https?:\/\/|mailto:)/i.test(u) || (u.startsWith('/') && !u.startsWith('//')) || u.startsWith('#')) return u;
  return null;
}

/** Inline formatting on already-escaped text. */
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
    const h = safeHref(href.replace(/&amp;/g, '&'));
    if (!h) return text;
    const external = /^https?:\/\//i.test(h);
    return `<a href="${esc(h)}"${external ? ' rel="noopener"' : ''}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
}

/** Markdown subset: ## / ### headings, paragraphs, lists, > quotes, ``` code, **bold**, *italic*, `code`, [links](url). */
export function renderMarkdown(md) {
  const lines = esc(String(md || '').replace(/\r\n?/g, '\n')).split('\n');
  const out = []; let para = []; let list = null; let quote = [];
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; };
  const flushQuote = () => { if (quote.length) out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`); quote = []; };
  const flush = () => { flushPara(); flushList(); flushQuote(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = /^(#{2,4})\s+(.+)$/.exec(line))) { flush(); const n = m[1].length; out.push(`<h${n} id="${slugify(m[2].replace(/&[a-z#0-9]+;/g, ''))}">${inline(m[2])}</h${n}>`); continue; }
    if ((m = /^&gt;\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote.push(m[1]); continue; }
    if ((m = /^\s*[-*]\s+(.+)$/.exec(line)) || (m = /^\s*\d+[.)]\s+(.+)$/.exec(line))) {
      flushPara(); flushQuote();
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(m[1]);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flush(); out.push('<hr>'); continue; }
    flushList(); flushQuote();
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

export const readingMinutes = (md) => Math.max(1, Math.round(String(md || '').split(/\s+/).filter(Boolean).length / 220));
export const plainText = (md) => String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/[#>*`_[\]()-]/g, ' ').replace(/\s+/g, ' ').trim();

export function createBlog(db) {
  function validate({ title, slug, description, body, status }) {
    const t = String(title || '').trim();
    if (!t || t.length > 140) throw new Error('Give the post a title (up to 140 characters).');
    const s = slug ? String(slug).trim().toLowerCase() : slugify(t);
    if (!SLUG_RE.test(s) || s.length > 80) throw new Error('The web address can only use lower-case letters, numbers and dashes.');
    const d = String(description || '').trim();
    if (d.length > 300) throw new Error('Keep the summary under 300 characters (about 155 is best for Google).');
    const b = String(body || '');
    if (b.length > 100_000) throw new Error('The post is too long (100,000 characters at most).');
    if (!['draft', 'published'].includes(status)) throw new Error('Choose draft or published.');
    return { title: t, slug: s, description: d, body: b, status };
  }

  function save(id, input, author) {
    const v = validate(input);
    const clash = db.get('SELECT id FROM posts WHERE slug = ? AND id != ?', v.slug, id || '');
    if (clash) throw new Error('Another post already uses that web address.');
    const now = Date.now();
    if (id) {
      const cur = db.get('SELECT * FROM posts WHERE id = ?', id);
      if (!cur) throw new Error('Post not found.');
      const publishedAt = v.status === 'published' ? (cur.published_at || now) : cur.published_at;
      db.run('UPDATE posts SET title=?, slug=?, description=?, body=?, status=?, published_at=?, updated_at=? WHERE id=?',
        v.title, v.slug, v.description, v.body, v.status, publishedAt, now, id);
      return id;
    }
    const nid = randomId('post_');
    db.run('INSERT INTO posts (id, slug, title, description, body, status, author, created_at, updated_at, published_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      nid, v.slug, v.title, v.description, v.body, v.status, String(author || '').slice(0, 254), now, now, v.status === 'published' ? now : null);
    return nid;
  }

  const byId = (id) => db.get('SELECT * FROM posts WHERE id = ?', id) || null;
  const published = (slug) => (SLUG_RE.test(slug || '') ? db.get("SELECT * FROM posts WHERE slug = ? AND status = 'published'", slug) || null : null);
  const listAll = () => db.all('SELECT id, slug, title, status, updated_at, published_at FROM posts ORDER BY COALESCE(published_at, updated_at) DESC');
  const listPublished = (limit = 200) => db.all("SELECT slug, title, description, body, published_at, updated_at FROM posts WHERE status = 'published' ORDER BY published_at DESC LIMIT ?", limit);
  const remove = (id) => db.run('DELETE FROM posts WHERE id = ?', id).changes > 0;

  /** Adds the starter articles in content/blog as drafts (skips any whose address is taken). */
  function importStarters(author) {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../content/blog');
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      const raw = readFileSync(join(dir, f), 'utf8');
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(raw);
      if (!fm) continue;
      const meta = Object.fromEntries(fm[1].split('\n').map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^"|"$/g, '')]));
      const slug = meta.slug || slugify(meta.title);
      if (db.get('SELECT 1 FROM posts WHERE slug = ?', slug)) continue;
      save(null, { title: meta.title, slug, description: meta.description, body: raw.slice(fm[0].length).trim(), status: 'draft' }, author);
      n++;
    }
    return n;
  }

  return { save, byId, published, listAll, listPublished, remove, importStarters };
}
