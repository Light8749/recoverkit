// The public website: landing page, robots.txt, sitemap.xml and llms.txt.
// Written for search engines (SEO) and for AI answer engines (GEO): plain HTML, answer-first
// headings, an FAQ, and JSON-LD structured data. Everything here is a fact about the product;
// no invented numbers or testimonials.
import { esc, assets, kobo } from './dashboard/ui.js';
import { renderMarkdown, readingMinutes, plainText } from './blog.js';

const GATEWAYS = ['Paystack', 'Flutterwave', 'Monnify', 'Korapay', 'Squad', 'Stripe', 'any gateway that signs its webhooks'];
const DATABASES = ['MySQL', 'MariaDB', 'PostgreSQL', 'SQLite', 'MongoDB', 'WooCommerce'];

export function siteFacts(config, signupOpen = false) {
  return {
    name: 'RecoverKit',
    url: config.publicUrl,
    fee: config.feePercent ?? 10,
    days: config.attributionDays ?? 7,
    signupOpen,
    description: 'RecoverKit finds the customers a business is losing (people who signed up but never bought, funded a wallet but never bought, or bought once and went quiet), drafts WhatsApp, SMS and email follow-ups in the business\'s own voice, and counts the sales it wins back. Built for Nigerian VTU, fintech, betting, e-commerce and subscription businesses.',
  };
}

export function faq(f) {
  return [
    ['What is RecoverKit?', `RecoverKit is a sales-recovery tool for digital businesses. It finds people who registered but never bought, funded a wallet but never bought, or bought once and stopped, then drafts personal follow-up messages for the business to approve and send by WhatsApp, SMS or email.`],
    ['Who is RecoverKit for?', 'Nigerian and African digital businesses: VTU (airtime and data) sites, fintech and wallet apps, betting platforms, online stores and subscription services. It works with any website or app.'],
    ['How much does RecoverKit cost?', `Setting up is free. RecoverKit charges ${f.fee}% of the revenue it recovers: a verified purchase within ${f.days} days of a follow-up message. If nothing is recovered, you pay nothing.`],
    ['How does RecoverKit know someone really bought?', 'From three places: signed payment webhooks (Paystack, Flutterwave, Monnify and others), your own server calling trackPurchase, or your database through a read-only connector. A "payment successful" screen in the browser is never trusted as proof, so nobody who already paid gets chased.'],
    ['Is a wallet deposit counted as a sale?', 'No. For VTU, betting and fintech apps a deposit is not a purchase. People who fund their wallet and never buy anything are treated as leads, and only real purchases count as sales.'],
    ['Can RecoverKit use my existing customers?', `Yes. A read-only connector runs on your own server and reads your existing database where it is (${DATABASES.join(', ')}), with any table design and any programming language. It sends only hashed IDs, dates and amounts, never raw customer data.`],
    ['Does RecoverKit send messages without my approval?', 'Not by default. Every drafted message waits for you to read, edit and approve it. Before sending, RecoverKit checks again that the person hasn\'t paid, opted out or been messaged recently.'],
    ['Which AI model writes the messages?', 'Any model you choose: Claude, GPT, Gemini, or any OpenAI-compatible provider such as Groq, DeepSeek, Mistral or a local Ollama. The model never sees names, emails or phone numbers. Without a model, built-in templates are used.'],
    ['Is customer data safe?', 'Emails and phone numbers are hashed before they leave the customer\'s device or your server, contact details are encrypted with AES-256-GCM, webhooks must be signed, and every person can be erased on request (NDPA right to erasure).'],
    ['How long does setup take?', 'Most businesses add one script tag to their website and paste one webhook URL into their payment gateway. A developer can follow the Developers page in the dashboard, which has every command filled in with your keys.'],
  ];
}

function jsonLdData(f) {
  return [
    {
      '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: f.name, url: f.url,
      applicationCategory: 'BusinessApplication', operatingSystem: 'Web', description: f.description,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'NGN', description: `Free to set up; ${f.fee}% of recovered revenue.` },
      areaServed: [{ '@type': 'Country', name: 'Nigeria' }, { '@type': 'Place', name: 'Africa' }],
      featureList: ['Finds sign-ups who never bought', 'Wallet deposits are not counted as sales', 'AI follow-ups in your own voice', 'Approve before sending', 'WhatsApp, SMS and email', 'Read-only connector for existing databases', 'Revenue attribution'],
    },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq(f).map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  ];
}

const nav = (signedIn) => `<header class="m-nav"><a class="m-brand" href="/">${kobo({ mode: 'mark', size: 32, title: 'RecoverKit' })}<b>RecoverKit</b></a>
  <nav aria-label="Site"><a href="/#how">How it works</a><a href="/#pricing">Pricing</a><a href="/blog">Blog</a><a href="/docs">Developers</a>${signedIn ? '<a href="/dashboard">Dashboard</a>' : '<a href="/login">Sign in</a>'}</nav></header>`;
const footer = (f) => `<footer class="m-foot"><span>© ${new Date().getUTCFullYear()} RecoverKit</span><nav aria-label="Footer"><a href="/blog">Blog</a><a href="/docs">Developer docs</a><a href="https://github.com/Light8749/recoverkit">GitHub</a><a href="/login">Sign in</a>${f.signupOpen ? '<a href="/signup">Create an account</a>' : ''}</nav></footer>`;
const ctaButtons = (f, signedIn) => (signedIn
  ? '<a class="btn prominent" href="/dashboard">Open your dashboard</a>'
  : `${f.signupOpen ? '<a class="btn prominent" href="/signup">Create a free account</a>' : ''}<a class="btn ${f.signupOpen ? 'tinted' : 'prominent'}" href="/login">Sign in</a>`);
const ld = (data) => data.map((d) => `<script type="application/ld+json">${JSON.stringify(d).replace(/</g, '\\u003c')}</script>`).join('');

/** <head> with SEO, Open Graph and Twitter tags. path is the canonical path, e.g. "/blog/x". */
function head(f, { title, desc, path, type = 'website', extra = '', structured = [] }) {
  const url = `${f.url}${path}`;
  return `<!doctype html><html lang="en-NG"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta name="geo.region" content="NG"><meta name="geo.placename" content="Nigeria">
<meta property="og:type" content="${type}"><meta property="og:site_name" content="RecoverKit"><meta property="og:locale" content="en_NG">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(f.url)}/static/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Kobo the pigeon, RecoverKit's mascot, bringing back a coin">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(f.url)}/static/og.png">
<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#007aff">
<link rel="icon" type="image/svg+xml" href="/static/kobo.svg"><link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">
<link rel="alternate" type="application/rss+xml" href="/blog/rss.xml" title="RecoverKit blog">${extra}
<link rel="stylesheet" href="${assets.css}">${ld(structured)}</head>`;
}

export function landingPage(config, { signedIn = false, signupOpen = false } = {}) {
  const f = siteFacts(config, signupOpen);
  const title = 'RecoverKit: win back customers who signed up but never bought';
  const desc = `Find people who registered, funded a wallet or bought once and never came back. RecoverKit drafts WhatsApp, SMS and email follow-ups in your voice. Free to start; ${f.fee}% of recovered sales.`;
  const cta = ctaButtons(f, signedIn);
  const card = (t, d) => `<article class="m-card"><h3>${t}</h3><p>${d}</p></article>`;
  return `${head(f, { title, desc, path: '/', structured: jsonLdData(f) })}
<body class="marketing">
${nav(signedIn)}
<main id="main">
<section class="m-hero">
  <div><p class="m-eyebrow">Sales recovery for Nigerian digital businesses</p>
  <h1>Win back the customers who signed up and never bought.</h1>
  <p class="m-lead">RecoverKit finds people who registered, funded a wallet or bought once and went quiet. It drafts a personal WhatsApp, SMS or email follow-up in your own voice, you approve it, and it counts every sale it wins back.</p>
  <div class="m-cta">${cta}<a class="btn plain" href="#how">See how it works</a></div>
  <p class="m-small">Free to set up. You pay ${f.fee}% of recovered sales, and nothing if nothing is recovered.</p></div>
  <div class="m-hero-art">${kobo({ mode: 'hero', size: 260, title: 'Kobo the pigeon flying out and bringing back a coin' })}</div>
</section>

<section class="m-section" aria-labelledby="problem"><h2 id="problem">Most of your sign-ups never become customers</h2>
  <div class="m-grid">
    ${card('Signed up, never bought', 'They made an account, looked around and left. Nobody followed up.')}
    ${card('Funded a wallet, never bought', 'On VTU, betting and fintech apps a deposit is not a sale. RecoverKit treats these people as leads, not customers.')}
    ${card('Bought once, then went quiet', 'A first purchase and then silence. A friendly nudge at the right time brings many of them back.')}
  </div></section>

<section class="m-section" id="how" aria-labelledby="how-h"><h2 id="how-h">How RecoverKit works</h2>
  <ol class="m-steps">
    <li><b>Connect</b><span>Add one script to your website and paste one webhook URL into Paystack, Flutterwave or your gateway. Bring in past customers with a read-only connector.</span></li>
    <li><b>Find</b><span>RecoverKit ranks who is worth following up, and how sure it is that they haven't already paid.</span></li>
    <li><b>Draft and approve</b><span>An AI model of your choice writes a short message in your voice. You read it, edit it and approve it.</span></li>
    <li><b>Send and count</b><span>Messages go out by WhatsApp, SMS or email. A verified purchase within ${f.days} days counts as recovered revenue.</span></li>
  </ol></section>

<section class="m-section" aria-labelledby="features"><h2 id="features">Built so you never chase someone who already paid</h2>
  <div class="m-grid">
    ${card('Real purchases only', `Signed webhooks, your server or your database decide what a sale is. A "payment successful" screen in the browser never counts.`)}
    ${card('Works with your gateways', `${GATEWAYS.join(', ')}.`)}
    ${card('Your existing customers', `A read-only connector reads ${DATABASES.join(', ')} where your data lives. Nothing is exported; only hashes, dates and amounts are sent.`)}
    ${card('Any AI model', 'Claude, GPT, Gemini, Groq, DeepSeek, Mistral or Ollama. The model never sees names, emails or phone numbers.')}
    ${card('You stay in control', 'Every message waits for your approval. Opted-out people, recent buyers and anyone messaged in the last week are skipped.')}
    ${card('Private by design', 'Hashed identities, AES-256-GCM encryption, signed webhooks and erasure on request under the NDPA.')}
  </div></section>

<section class="m-section" aria-labelledby="who"><h2 id="who">Who uses RecoverKit</h2>
  <p class="m-lead">VTU sites selling airtime and data, fintech and wallet apps, betting platforms, online stores and subscription services across Nigeria and Africa. If people sign up on your website or app and pay you online, RecoverKit can follow up with the ones who didn't.</p></section>

<section class="m-section" id="pricing" aria-labelledby="pricing-h"><h2 id="pricing-h">Pricing</h2>
  <div class="m-price"><b>${f.fee}%</b><span>of recovered revenue</span></div>
  <ul class="m-list"><li>Free to set up, no monthly fee</li><li>Recovered means a verified purchase within ${f.days} days of a follow-up</li><li>Nothing to pay if nothing is recovered</li></ul>
  <div class="m-cta">${cta}</div></section>

<section class="m-section" id="faq" aria-labelledby="faq-h"><h2 id="faq-h">Frequently asked questions</h2>
  ${faq(f).map(([q, a]) => `<details class="m-faq"><summary><h3>${esc(q)}</h3></summary><p>${esc(a)}</p></details>`).join('')}</section>
</main>
${footer(f)}
</body></html>`;
}

const DATE = new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' });
const iso = (ts) => new Date(ts).toISOString();

export function blogIndexPage(config, { posts, signedIn = false, signupOpen = false }) {
  const f = siteFacts(config, signupOpen);
  const title = 'RecoverKit blog: win back lost customers in Nigeria';
  const desc = 'Practical guides for Nigerian VTU, fintech, betting and online businesses on following up with customers who signed up, funded a wallet or bought once and went quiet.';
  const items = posts.map((p) => `<article class="m-post-item"><h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2>
    <p class="m-meta"><time datetime="${iso(p.published_at)}">${DATE.format(p.published_at)}</time> · ${readingMinutes(p.body)} min read</p>${p.description ? `<p>${esc(p.description)}</p>` : ''}</article>`).join('');
  const structured = [{ '@context': 'https://schema.org', '@type': 'Blog', name: 'RecoverKit blog', url: `${f.url}/blog`, description: desc,
    blogPost: posts.slice(0, 50).map((p) => ({ '@type': 'BlogPosting', headline: p.title, url: `${f.url}/blog/${p.slug}`, datePublished: iso(p.published_at) })) }];
  return `${head(f, { title, desc, path: '/blog', structured })}
<body class="marketing">${nav(signedIn)}
<main id="main" class="m-article-wrap"><header class="m-blog-head"><h1>Blog</h1><p class="m-lead">${esc(desc)}</p></header>
${items || '<p class="m-lead">The first articles are on their way.</p>'}
</main>${footer(f)}</body></html>`;
}

export function blogPostPage(config, { post, more = [], signedIn = false, signupOpen = false }) {
  const f = siteFacts(config, signupOpen);
  const desc = post.description || plainText(post.body).slice(0, 155);
  const url = `${f.url}/blog/${post.slug}`;
  const structured = [
    { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: post.title, description: desc, url, mainEntityOfPage: url,
      datePublished: iso(post.published_at), dateModified: iso(post.updated_at), inLanguage: 'en-NG', image: `${f.url}/static/og.png`,
      author: { '@type': 'Organization', name: 'RecoverKit', url: f.url }, publisher: { '@type': 'Organization', name: 'RecoverKit', url: f.url, logo: { '@type': 'ImageObject', url: `${f.url}/static/kobo.svg` } } },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${f.url}/` }, { '@type': 'ListItem', position: 2, name: 'Blog', item: `${f.url}/blog` },
      { '@type': 'ListItem', position: 3, name: post.title, item: url }] },
  ];
  const extra = `\n<meta property="article:published_time" content="${iso(post.published_at)}"><meta property="article:modified_time" content="${iso(post.updated_at)}">`;
  return `${head(f, { title: `${post.title} | RecoverKit`, desc, path: `/blog/${post.slug}`, type: 'article', extra, structured })}
<body class="marketing">${nav(signedIn)}
<main id="main" class="m-article-wrap"><article class="m-article">
<nav class="m-crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/blog">Blog</a></nav>
<h1>${esc(post.title)}</h1>
<p class="m-meta"><time datetime="${iso(post.published_at)}">${DATE.format(post.published_at)}</time> · ${readingMinutes(post.body)} min read</p>
<div class="m-prose">${renderMarkdown(post.body)}</div>
<aside class="m-cta-box"><h2>Recover the customers you're already losing</h2><p>RecoverKit finds people who signed up, funded a wallet or bought once and went quiet, and drafts follow-ups in your voice for you to approve. Free to set up; ${f.fee}% of recovered sales.</p><div class="m-cta">${ctaButtons(f, signedIn)}</div></aside>
</article>
${more.length ? `<section class="m-more"><h2>More from the blog</h2>${more.map((p) => `<p><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></p>`).join('')}</section>` : ''}
</main>${footer(f)}</body></html>`;
}

export function rssXml(config, posts) {
  const f = siteFacts(config);
  const x = (s) => esc(s);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>RecoverKit blog</title><link>${x(f.url)}/blog</link><description>Win back customers who signed up and never bought.</description><language>en-ng</language>
${posts.map((p) => `<item><title>${x(p.title)}</title><link>${x(f.url)}/blog/${x(p.slug)}</link><guid>${x(f.url)}/blog/${x(p.slug)}</guid><pubDate>${new Date(p.published_at).toUTCString()}</pubDate><description>${x(p.description || plainText(p.body).slice(0, 300))}</description></item>`).join('\n')}
</channel></rss>
`;
}

export function robotsTxt(config) {
  return `User-agent: *
Allow: /
Disallow: /dashboard
Disallow: /admin
Disallow: /reset/
Disallow: /dev/
Disallow: /u/
Disallow: /v1/

Sitemap: ${config.publicUrl}/sitemap.xml
`;
}

export function sitemapXml(config, signupOpen = false, posts = []) {
  const pages = ['/', '/blog', '/docs', ...(signupOpen ? ['/signup'] : []), '/login', '/llms.txt'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${esc(config.publicUrl + p)}</loc></url>`).join('\n')}
${posts.map((p) => `  <url><loc>${esc(`${config.publicUrl}/blog/${p.slug}`)}</loc><lastmod>${new Date(p.updated_at).toISOString().slice(0, 10)}</lastmod></url>`).join('\n')}
</urlset>
`;
}

/** llms.txt (llmstxt.org): a plain summary for AI assistants and answer engines. */
export function llmsTxt(config, signupOpen = false, posts = []) {
  const f = siteFacts(config, signupOpen);
  return `# RecoverKit

> ${f.description}

RecoverKit is a sales-recovery SDK and web dashboard. Website: ${f.url}

## Key facts

- Finds three kinds of lost customers: signed up but never bought; funded a wallet but never bought; bought once and went quiet.
- A wallet deposit is not counted as a purchase (important for VTU, betting and fintech apps).
- Purchases are only trusted from signed payment webhooks (${GATEWAYS.join(', ')}), the business's own server, or its database. Browser "payment successful" screens never count.
- AI drafts follow-up messages in the business's own voice with any model (Claude, GPT, Gemini, or OpenAI-compatible providers such as Groq, DeepSeek, Mistral, Ollama). The model never sees names, emails or phone numbers. Built-in templates are used if no model is set.
- Every message is approved by the business before it is sent, by WhatsApp (Cloud API), SMS (Termii) or email.
- Existing customers can be imported with a read-only connector that reads ${DATABASES.join(', ')} in place, with any schema or programming language.
- Privacy: emails and phones are hashed before they leave the device or server; contact details are encrypted with AES-256-GCM; people can be erased on request (Nigeria Data Protection Act).
- Pricing: free to set up; ${f.fee}% of recovered revenue, meaning a verified purchase within ${f.days} days of a follow-up. Nothing to pay if nothing is recovered.
- Built for Nigerian and African digital businesses: VTU (airtime and data), fintech, betting, e-commerce and subscriptions.

## Links

- [Home](${f.url}/)
- [Developer docs and API reference](${f.url}/docs)
- [Blog](${f.url}/blog)
${posts.map((p) => `- [${p.title}](${f.url}/blog/${p.slug})${p.description ? `: ${p.description}` : ''}`).join('\n')}${posts.length ? '\n' : ''}${f.signupOpen ? `- [Create an account](${f.url}/signup)\n` : ''}- [Source code (SDKs MIT-licensed)](https://github.com/Light8749/recoverkit)
- npm: recoverkit (Node.js server SDK), recoverkit-connector (MongoDB connector)
- Composer: light8749/recoverkit (PHP SDK and SQL connector)

## Frequently asked questions

${faq(f).map(([q, a]) => `### ${q}\n\n${a}`).join('\n\n')}
`;
}
