// Admin > Blog: write posts in Markdown, preview them, publish or keep as drafts.
import { sendHtml, redirect } from '../http.js';
import { renderMarkdown, readingMinutes } from '../blog.js';
import { esc, ago, csrfField, banner, page, group, row, field, select, pill, empty } from './ui.js';

export function createBlogAdmin({ blog, projects, config, requireAdmin, adminPost, back }) {
  const audit = (ctx, action, detail) => projects.audit(ctx.project.id, ctx.user.email, action, detail);

  function listPage(req, res, _p, url) {
    const ctx = requireAdmin(req);
    const posts = blog.listAll();
    const rows = posts.map((p) => row(`${esc(p.title)}<small>/blog/${esc(p.slug)} · updated ${ago(p.updated_at)}</small>`,
      p.status === 'published' ? pill('Published', 'green') : pill('Draft'), { href: `/admin/blog/${p.id}` }));
    sendHtml(res, 200, page({
      title: 'Blog', active: 'blog', ctx,
      subtitle: 'Articles on your public website. Each one is a page Google can rank and AI assistants can quote.',
      actions: '<a class="btn prominent" href="/admin/blog/new">New post</a>',
      body: `${banner(url.searchParams)}
      ${rows.length ? group(`${posts.length} post${posts.length === 1 ? '' : 's'}`, rows, `Published posts appear at <a href="/blog">${esc(config.publicUrl)}/blog</a>, in the sitemap, the RSS feed and llms.txt.`)
        : empty('No posts yet', 'Write your first article, or start from the ready-made drafts.', '')}
      <form method="post" action="/admin/blog/starters">${csrfField(ctx)}<button class="btn tinted">Add the starter articles as drafts</button></form>
      ${group('Tips for posts that get found', [
        row('Answer one real question', '', { sub: 'Use the words your customers would type into Google, like "how to follow up on abandoned checkout in Nigeria"' }),
        row('Put the answer first', '', { sub: 'AI assistants quote the first clear sentence under a heading' }),
        row('Write a summary of about 155 characters', '', { sub: 'It becomes the Google snippet and the link preview' }),
        row('Use ## headings and short lists', '', { sub: 'Easier to read, and easier for search engines to understand' }),
      ])}`,
    }));
  }

  function form(ctx, post, action, extra = '') {
    const p = post || { title: '', slug: '', description: '', body: '', status: 'draft' };
    const preview = p.body ? `<section class="group"><h2 class="group-head">Preview · ${readingMinutes(p.body)} min read</h2><div class="group-body"><div class="m-prose blog-preview"><h1>${esc(p.title)}</h1>${renderMarkdown(p.body)}</div></div></section>` : '';
    return `${extra}<form method="post" action="${action}" autocomplete="off">${csrfField(ctx)}
      ${group('', [
        field('title', 'Title', p.title, { max: 140, required: true, placeholder: 'How to win back VTU customers who funded but never bought' }),
        field('slug', 'Web address', p.slug, { max: 80, placeholder: 'made from the title if blank', hint: `${esc(config.publicUrl)}/blog/…` }),
        `<label class="row field stacked"><span class="row-label">Summary<small>Shown in Google and link previews. About 155 characters.</small></span><textarea name="description" rows="2" maxlength="300">${esc(p.description)}</textarea></label>`,
        `<label class="row field stacked"><span class="row-label">Article<small>Markdown: ## Heading, **bold**, *italic*, - list, 1. list, &gt; quote, [link](https://…), \`code\`</small></span><textarea name="body" rows="22" maxlength="100000" class="blog-body">${esc(p.body)}</textarea></label>`,
        select('status', 'Status', [['draft', 'Draft (only you can see it)'], ['published', 'Published (on the website)']], p.status),
      ])}
      <div class="actions"><button class="btn prominent">Save</button>${post?.status === 'published' ? ` <a class="btn plain" href="/blog/${esc(post.slug)}">View on the website</a>` : ''}</div></form>
      ${preview}`;
  }

  function newPage(req, res, _p, url) {
    const ctx = requireAdmin(req);
    sendHtml(res, 200, page({ title: 'New post', active: 'blog', ctx, body: `${banner(url.searchParams)}${form(ctx, null, '/admin/blog')}` }));
  }

  async function createAction(req, res) {
    const { ctx, form: f } = await adminPost(req, 256 * 1024);
    let id;
    try { id = blog.save(null, f, ctx.user.email); } catch (e) { return back(res, '/admin/blog/new', null, e.message); }
    audit(ctx, 'post_created', f.title);
    back(res, `/admin/blog/${id}`, f.status === 'published' ? 'Published.' : 'Saved as a draft.');
  }

  function editPage(req, res, params, url) {
    const ctx = requireAdmin(req);
    const post = blog.byId(params.id);
    if (!post) return redirect(res, '/admin/blog');
    sendHtml(res, 200, page({
      title: post.title, active: 'blog', ctx, subtitle: post.status === 'published' ? `Published · ${esc(config.publicUrl)}/blog/${esc(post.slug)}` : 'Draft',
      body: `${banner(url.searchParams)}${form(ctx, post, `/admin/blog/${post.id}`)}
      <details class="danger"><summary>Delete this post…</summary><form method="post" action="/admin/blog/${esc(post.id)}/delete">${csrfField(ctx)}<p>The page will stop working. This can't be undone.</p><button class="btn destructive-fill">Delete post</button></form></details>
      <p><a class="btn plain" href="/admin/blog">All posts</a></p>`,
    }));
  }

  async function updateAction(req, res, params) {
    const { ctx, form: f } = await adminPost(req, 256 * 1024);
    try { blog.save(params.id, f, ctx.user.email); } catch (e) { return back(res, `/admin/blog/${params.id}`, null, e.message); }
    audit(ctx, 'post_updated', params.id);
    back(res, `/admin/blog/${params.id}`, f.status === 'published' ? 'Saved and published.' : 'Saved as a draft.');
  }

  async function deleteAction(req, res, params) {
    const { ctx } = await adminPost(req);
    if (blog.remove(params.id)) audit(ctx, 'post_deleted', params.id);
    back(res, '/admin/blog', 'Post deleted.');
  }

  async function startersAction(req, res) {
    const { ctx } = await adminPost(req);
    const n = blog.importStarters(ctx.user.email);
    audit(ctx, 'post_starters', String(n));
    back(res, '/admin/blog', n ? `Added ${n} starter article${n === 1 ? '' : 's'} as drafts. Read and edit them, then publish.` : 'The starter articles are already here.');
  }

  return { blogList: listPage, blogNew: newPage, blogCreate: createAction, blogEdit: editPage, blogUpdate: updateAction, blogDelete: deleteAction, blogStarters: startersAction };
}
