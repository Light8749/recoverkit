// Shared view helpers for the dashboard (Apple HIG-style, server-rendered, no JS).

/** Asset URLs carry a content hash (set by the server) so browsers never use a stale stylesheet. */
export const assets = { css: '/static/app.css' };
import { kobo } from './mascot.js';
export { kobo };

export const esc = (v) => String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]);
export const money = (minor, currency = 'NGN') => {
  const sym = { NGN: '₦', USD: '$', GBP: '£', EUR: '€', GHS: 'GH₵', KES: 'KSh ' }[currency] || `${currency} `;
  return sym + (Number(minor || 0) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
};
export const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

// Simple line icons (our own drawings; Apple's SF Symbols are not licensed for the web).
const ICONS = {
  overview: '<path d="M4 13h4v7H4zM10 8h4v12h-4zM16 4h4v16h-4z"/>',
  leads: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.6c1.8.8 3 2.6 3.5 5.4"/>',
  messages: '<path d="M4 5h16v11H9l-5 4z"/>',
  payments: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>',
  ai: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
  channels: '<path d="M21 3L3 10.5l7 2.5 2.5 7z"/><path d="M10 13l5-5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
};
export const icon = (name, cls = 'icon') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;

const NAV = [
  { group: null, items: [['overview', '/dashboard', 'Overview'], ['leads', '/dashboard/leads', 'Leads'], ['messages', '/dashboard/messages', 'Messages']] },
  { group: 'Setup', items: [['payments', '/dashboard/payments', 'Payments'], ['ai', '/dashboard/ai', 'AI model'], ['channels', '/dashboard/channels', 'Channels'], ['settings', '/dashboard/settings', 'Settings']] },
];
const TABS = [['overview', '/dashboard', 'Overview'], ['leads', '/dashboard/leads', 'Leads'], ['messages', '/dashboard/messages', 'Messages'], ['payments', '/dashboard/payments', 'Payments'], ['settings', '/dashboard/settings', 'Settings']];

export const csrfField = (ctx) => `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`;

export function banner(q) {
  const ok = q?.get('ok'); const err = q?.get('err');
  return (ok ? `<div class="banner ok" role="status">${icon('check')}<span>${esc(ok)}</span></div>` : '')
    + (err ? `<div class="banner err" role="alert">${icon('warn')}<span>${esc(err)}</span></div>` : '');
}

/** Page shell. `active` is the nav key; `badge` shows pending drafts on Messages. */
export function page({ title, active, ctx, body, actions = '', subtitle = '' }) {
  const badge = ctx?.badge ? `<span class="badge" aria-label="${ctx.badge} waiting">${ctx.badge}</span>` : '';
  const navItem = ([key, href, label]) => `<a href="${href}" class="nav-item"${key === active ? ' aria-current="page"' : ''}>${icon(key)}<span>${label}</span>${key === 'messages' ? badge : ''}</a>`;
  const sidebar = ctx?.user ? `<aside class="sidebar" aria-label="Main">
      <div class="brand">${kobo({ mode: 'mark', size: 36 })}<div><b>RecoverKit</b><small>${esc(ctx.project.name)}</small></div></div>
      ${NAV.map((g) => `<nav class="nav-group">${g.group ? `<h2 class="nav-title">${g.group}</h2>` : ''}${g.items.map(navItem).join('')}</nav>`).join('')}
      <form method="post" action="/logout" class="sidebar-foot">${csrfField(ctx)}<span>${esc(ctx.user.email)}</span><button class="btn plain small">Log out</button></form>
    </aside>
    <nav class="tabbar" aria-label="Main">${TABS.map(([key, href, label]) => `<a href="${href}"${key === active || (key === 'settings' && ['ai', 'channels'].includes(active)) ? ' aria-current="page"' : ''}>${icon(key)}<span>${label}</span>${key === 'messages' ? badge : ''}</a>`).join('')}</nav>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><link rel="icon" type="image/svg+xml" href="/static/kobo.svg"><title>${esc(title)} · RecoverKit</title><link rel="stylesheet" href="${assets.css}"></head>
<body class="${ctx?.user ? 'signed-in' : 'signed-out'}">${sidebar}
<main class="content" id="main"><header class="page-head"><div><h1>${esc(title)}</h1>${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}</div>${actions ? `<div class="head-actions">${actions}</div>` : ''}</header>
${body}</main></body></html>`;
}

/** Inset grouped list section (iOS Settings style). rows are HTML strings. */
export const group = (header, rows, footer = '') => `<section class="group">${header ? `<h2 class="group-head">${header}</h2>` : ''}<div class="group-body">${rows.join('')}</div>${footer ? `<p class="group-foot">${footer}</p>` : ''}</section>`;
export const row = (label, value = '', { href, sub } = {}) => href
  ? `<a class="row link" href="${href}"><span class="row-label">${label}${sub ? `<small>${sub}</small>` : ''}</span><span class="row-value">${value}</span>${icon('chevron', 'icon chev')}</a>`
  : `<div class="row"><span class="row-label">${label}${sub ? `<small>${sub}</small>` : ''}</span><span class="row-value">${value}</span></div>`;

/** Switch that lives in a list row (it's a real checkbox, so it's accessible). */
export const switchRow = (name, label, checked, sub = '') => `<label class="row"><span class="row-label">${label}${sub ? `<small>${sub}</small>` : ''}</span>
  <span class="switch"><input type="checkbox" role="switch" name="${name}" value="1"${checked ? ' checked' : ''}><span class="track" aria-hidden="true"></span></span></label>`;

export const field = (name, label, value = '', { type = 'text', placeholder = '', max = 200, hint = '', required = false, autocomplete = 'off' } = {}) =>
  `<label class="row field"><span class="row-label">${label}${hint ? `<small>${hint}</small>` : ''}</span><input name="${name}" type="${type}" value="${type === 'password' ? '' : esc(value)}" placeholder="${esc(placeholder)}" maxlength="${max}" autocomplete="${autocomplete}"${required ? ' required' : ''}></label>`;

export const select = (name, label, options, current, hint = '') => `<label class="row field"><span class="row-label">${label}${hint ? `<small>${hint}</small>` : ''}</span><select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(current) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;

/** Segmented control made of links (for switching views/filters). */
export const segmented = (label, items, current) => `<nav class="segmented" aria-label="${esc(label)}">${items.map(([v, l, href]) => `<a href="${href}"${v === current ? ' aria-current="true"' : ''}>${l}</a>`).join('')}</nav>`;

/** Horizontal bar. A <progress> element: its width comes from attributes (CSP forbids inline styles),
 *  and unlike a stretched SVG its rounded ends stay round at any width. The number beside it is the
 *  accessible value, so the bar itself is hidden from screen readers. */
export const bar = (value, max, tone = 'accent') =>
  `<progress class="bar ${tone}" value="${Math.max(0, Number(value) || 0)}" max="${Math.max(1, Number(max) || 1)}" aria-hidden="true"></progress>`;

export const pill = (text, tone = 'neutral') => `<span class="pill ${tone}">${esc(text)}</span>`;
export const empty = (title, text, action = '') => `<div class="empty">${kobo({ mode: 'mark', size: 64, title: 'Kobo' })}<h2>${esc(title)}</h2><p>${text}</p>${action}</div>`;
