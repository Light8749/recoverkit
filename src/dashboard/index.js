// Business dashboard: overview, leads, messages, payments, AI model, channels, settings.
// Server-rendered HTML, no JavaScript, strict CSP. Every dynamic value is escaped.
import { randomToken, sha256Hex, safeEqual, verifyPassword, hashPassword, signToken, verifyToken } from '../crypto.js';
import { HttpError, sendHtml, redirect, readBody, parseForm, parseCookies, clientIp } from '../http.js';
import { mask } from '../channels.js';
import { PRESETS, FIELD_NAMES, ALGORITHMS } from '../gateways.js';
import { AI_PROVIDERS } from '../ai.js';
import { normalizeEmail } from '../../sdk/core/identity.js';
import { kobo } from './mascot.js';
import { developerGuide, apiReference } from './devguide.js';
import { esc, money, ago, icon, csrfField, banner, page, group, row, switchRow, field, select, segmented, bar, pill, empty } from './ui.js';

export { esc };

const SESSION_HOURS = 12;
const DUMMY_HASH = hashPassword('not-a-real-password-' + randomToken());
const STAGE_LABEL = {
  registered: 'Signed up, no activity', browsed: 'Browsed, never bought', checkout_abandoned: 'Started checkout, never paid',
  funded_not_bought: 'Funded wallet, never bought', new_customer: 'New customer', repeat_customer: 'Repeat customer',
  bought_once: 'Bought once, gone quiet', lapsed_repeat: 'Regular, gone quiet',
};
const FIELD_LABEL = { ref: 'Payment reference', amount: 'Amount', currency: 'Currency', email: 'Customer email', phone: 'Customer phone', name: 'Customer name', time: 'Paid at', eventId: 'Unique event ID', kind: 'Sale or deposit tag' };

export function createDashboard({ db, config, keys, projects, engine, outreach, people, limiter, drafter, resolveAi }) {
  const secureCookie = config.publicUrl.startsWith('https://');
  const cookie = (v, maxAge) => `rk_session=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;

  function session(req) {
    const token = parseCookies(req.headers.cookie).rk_session;
    if (!token || token.length > 100) return null;
    const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256Hex(token));
    if (!s || s.expires_at < Date.now()) return null;
    const user = db.get('SELECT id, email, project_id FROM users WHERE id = ?', s.user_id);
    if (!user) return null;
    const project = projects.byId(user.project_id);
    const badge = db.get("SELECT COUNT(*) n FROM messages WHERE project_id = ? AND status = 'draft'", project.id).n;
    return { user, project, csrf: s.csrf, tokenHash: s.token_hash, badge };
  }

  function requireSession(req) {
    const ctx = session(req);
    if (!ctx) throw Object.assign(new HttpError(303, 'login required'), { location: '/login' });
    return ctx;
  }

  /** CSRF defence in depth: the request must come from our own pages. */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    if (!origin) return true;
    if (origin === 'null') return site === 'same-origin'; // privacy modes hide the origin; trust the browser's own signal
    return origin === new URL(config.publicUrl).origin || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
  }

  /** POST guard: valid session, matching CSRF token, and same-origin request. */
  async function postCtx(req, limit = 32 * 1024) {
    const ctx = requireSession(req);
    if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin request blocked');
    const form = parseForm(await readBody(req, limit));
    if (!safeEqual(form._csrf || '', ctx.csrf)) throw new HttpError(403, 'invalid CSRF token, reload the page');
    return { ctx, form };
  }

  const back = (res, path, ok, err) => redirect(res, `${path}${path.includes('?') ? '&' : '?'}${ok ? 'ok=' + encodeURIComponent(ok) : 'err=' + encodeURIComponent(err)}`);

  // ================= auth =================
  function loginPage(req, res, _p, url) {
    if (session(req)) return redirect(res, '/dashboard');
    sendHtml(res, 200, page({
      title: 'Sign in to RecoverKit',
      subtitle: 'Recover the sales you\'re already losing.',
      body: `<div class="auth"><div class="auth-hero">${kobo({ mode: 'hero', size: 200, title: 'Kobo the pigeon flying out and bringing back a coin' })}</div>${banner(url.searchParams)}
      <form method="post" action="/login">
        ${group('', [field('email', 'Email', '', { type: 'email', max: 254, required: true, autocomplete: 'username', placeholder: 'you@yourbusiness.ng' }), field('password', 'Password', '', { type: 'password', max: 200, required: true, autocomplete: 'current-password', placeholder: 'Required' })])}
        <button class="btn prominent wide">Sign in</button></form>
      <p class="subtitle">Connecting an app for a business? <a href="/docs">Developer docs</a></p></div>`,
    }));
  }

  async function login(req, res) {
    if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin request blocked');
    const ip = clientIp(req, config.trustProxy);
    const form = parseForm(await readBody(req, 4096));
    const email = normalizeEmail(form.email) || '';
    if (!limiter.hit(`login-ip:${ip}`, 20, 15 * 60e3) || !limiter.hit(`login-email:${email}`, 8, 15 * 60e3)) {
      return redirect(res, '/login?err=' + encodeURIComponent('Too many attempts. Try again in 15 minutes.'));
    }
    const user = email ? db.get('SELECT * FROM users WHERE email = ?', email) : null;
    // Always run scrypt so response time doesn't reveal whether the email exists.
    const ok = verifyPassword(String(form.password || '').slice(0, 200), user?.password_hash || DUMMY_HASH) && Boolean(user);
    if (!ok) return redirect(res, '/login?err=' + encodeURIComponent('Wrong email or password.'));
    limiter.reset(`login-email:${email}`);
    const token = randomToken(32);
    db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    db.run('INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES (?,?,?,?)', sha256Hex(token), user.id, randomToken(24), Date.now() + SESSION_HOURS * 36e5);
    projects.audit(user.project_id, user.email, 'login', ip);
    redirect(res, '/dashboard', { 'Set-Cookie': cookie(token, SESSION_HOURS * 3600) });
  }

  async function logout(req, res) {
    const { ctx } = await postCtx(req);
    db.run('DELETE FROM sessions WHERE token_hash = ?', ctx.tokenHash);
    redirect(res, '/login', { 'Set-Cookie': cookie('', 0) });
  }

  // ================= overview =================
  function overview(req, res, _p, url) {
    const ctx = requireSession(req);
    const p = ctx.project;
    const rev = engine.revenue(p.id);
    const f = engine.funnel(p.id);
    const gws = projects.listGateways(p.id);
    const warn = f.verified ? '' : `<div class="banner warn" role="status">${icon('warn')}<span>RecoverKit can't tell buyers from non-buyers yet. Connect a payment gateway or call <code>trackPurchase</code> from your server so nobody who already paid gets a message.</span>
      <a class="btn tinted small" href="/dashboard/payments">${gws.length ? 'Check gateways' : 'Connect a gateway'}</a></div>`;
    const tiles = [
      ['Recovered revenue', money(rev.recoveredAmount, p.currency), `${rev.recoveredPurchases} purchase${rev.recoveredPurchases === 1 ? '' : 's'} within ${config.attributionDays} days of a message`],
      [`Fee (${config.feePercent}%)`, money(rev.fee, p.currency), 'Only charged on recovered sales'],
      ['Messages sent', String(rev.messagesSent), 'All time'],
      ['Waiting for you', String(ctx.badge), ctx.badge ? '<a href="/dashboard/messages">Review drafts</a>' : 'No drafts to review'],
    ];
    const leadStages = ['registered', 'browsed', 'checkout_abandoned', 'funded_not_bought', 'bought_once', 'lapsed_repeat'];
    const custStages = ['new_customer', 'repeat_customer'];
    const max = Math.max(1, ...[...leadStages, ...custStages].map((k) => f[k] || 0));
    const funnelRow = (k, tone) => `<div class="row bar-row"><span class="row-label">${esc(STAGE_LABEL[k])}</span>${bar(f[k] || 0, max, tone)}<span class="row-value num">${Number(f[k] || 0)}</span></div>`;
    const totalLeads = leadStages.reduce((s, k) => s + (f[k] || 0), 0);
    sendHtml(res, 200, page({
      title: 'Overview', active: 'overview', ctx,
      actions: `<form method="post" action="/dashboard/drafts">${csrfField(ctx)}<button class="btn prominent">Draft follow-ups</button></form>`,
      body: `${banner(url.searchParams)}${warn}
      <div class="tiles">${tiles.map(([k, v, s]) => `<div class="tile"><span class="tile-label">${k}</span><b class="tile-value">${v}</b><small>${s}</small></div>`).join('')}</div>
      ${group('People worth following up', leadStages.map((k) => funnelRow(k, 'accent')), `${totalLeads} people in total. Anonymous visitors not yet identified: ${Number(f.anonymous || 0)}.`)}
      ${group('Customers', custStages.map((k) => funnelRow(k, 'green')))}`,
    }));
  }

  // ================= leads =================
  function leadsPage(req, res, _p, url) {
    const ctx = requireSession(req);
    const pid = ctx.project.id;
    const filter = ['never_bought', 'lapsed'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'all';
    const list = engine.leads(pid, { limit: 100, minConfidence: 0 }).filter((l) => filter === 'all' || l.leadType === filter);
    const rows = list.map((l) => {
      const c = people.getContact(pid, l.personId) || {};
      const who = c.email ? mask(c.email) : c.phone ? mask(c.phone) : 'No contact yet';
      const conf = Math.round(l.confidence * 100);
      const tone = conf >= 80 ? 'green' : conf >= 60 ? 'orange' : 'neutral';
      return `<div class="row lead${conf < 60 ? ' dim' : ''}">
        <span class="row-label">${esc(who)}<small>${esc(STAGE_LABEL[l.stage] || l.stage)} · idle ${l.idleDays} d · ${l.purchases} purchase${l.purchases === 1 ? '' : 's'}${l.reasons.length ? ` · ${esc(l.reasons.join('; '))}` : ''}</small></span>
        <span class="row-value"><span class="score" title="Score">${l.score}</span>${pill(`${conf}% sure`, tone)}</span></div>`;
    });
    sendHtml(res, 200, page({
      title: 'Leads', active: 'leads', ctx,
      subtitle: 'Ranked by score × confidence. People below 60% confidence are dimmed and won\'t get drafts.',
      actions: `<form method="post" action="/dashboard/drafts">${csrfField(ctx)}<button class="btn prominent">Draft top 20</button></form>`,
      body: `${banner(url.searchParams)}
      ${segmented('Filter leads', [['all', 'All', '/dashboard/leads'], ['never_bought', 'Never bought', '/dashboard/leads?type=never_bought'], ['lapsed', 'Gone quiet', '/dashboard/leads?type=lapsed']], filter)}
      ${rows.length ? group(`${rows.length} ${rows.length === 1 ? 'person' : 'people'}`, rows) : empty('No leads yet', 'Install the SDK and connect a payment gateway. People who sign up and don\'t buy will appear here.', '<a class="btn tinted" href="/dashboard/settings">Install instructions</a>')}`,
    }));
  }

  // ================= messages =================
  function messagesPage(req, res, _p, url) {
    const ctx = requireSession(req);
    const pid = ctx.project.id;
    const view = ['approved', 'history'].includes(url.searchParams.get('view')) ? url.searchParams.get('view') : 'waiting';
    const count = (st) => db.get(`SELECT COUNT(*) n FROM messages WHERE project_id = ? AND status = ?`, pid, st).n;
    const nApproved = count('approved');
    let body = '';
    if (view === 'waiting') {
      const drafts = db.all("SELECT * FROM messages WHERE project_id = ? AND status = 'draft' ORDER BY score DESC LIMIT 100", pid);
      body = drafts.length ? drafts.map((m) => `<article class="card draft">
        <div class="meta">${pill(m.channel)} ${pill(m.lead_type === 'lapsed' ? 'Gone quiet' : 'Never bought')} <small>Score ${m.score} · ${Math.round(m.confidence * 100)}% sure · ${esc(m.tactic.replace(/_/g, ' '))} · ${esc(m.drafted_by)}</small></div>
        <form method="post" action="/dashboard/messages/${esc(m.id)}/approve">${csrfField(ctx)}
          <label class="sr-only" for="b-${esc(m.id)}">Message</label><textarea id="b-${esc(m.id)}" name="body" rows="3" maxlength="1600">${esc(m.body)}</textarea>
          <div class="actions"><button class="btn prominent">Approve</button>
          <button class="btn plain destructive" formaction="/dashboard/messages/${esc(m.id)}/reject">Reject</button></div></form></article>`).join('')
        : empty('Nothing waiting', 'Drafts appear here for you to check before anything is sent.', `<form method="post" action="/dashboard/drafts">${csrfField(ctx)}<button class="btn tinted">Draft follow-ups now</button></form>`);
    } else if (view === 'approved') {
      const list = db.all("SELECT * FROM messages WHERE project_id = ? AND status = 'approved' ORDER BY created_at LIMIT 100", pid);
      body = list.length ? `${group('', list.map((m) => row(esc(m.body.slice(0, 120)), pill(m.channel))), `Before sending, each person is checked again: anyone who has paid, opted out or was messaged in the last ${config.minDaysBetweenMessages} days is skipped.`)}
        <form method="post" action="/dashboard/send">${csrfField(ctx)}<button class="btn prominent wide">Send ${list.length} message${list.length === 1 ? '' : 's'}</button></form>`
        : empty('Nothing approved', 'Approve drafts in Waiting and they\'ll be ready to send here.');
    } else {
      const list = db.all("SELECT * FROM messages WHERE project_id = ? AND status NOT IN ('draft','approved') ORDER BY created_at DESC LIMIT 100", pid);
      const tone = { sent: 'green', failed: 'red', skipped: 'orange', rejected: 'neutral', sending: 'orange' };
      body = list.length ? group('', list.map((m) => row(`${esc(m.body.slice(0, 120))}${m.status_reason ? `<small>${esc(m.status_reason)}</small>` : ''}`, `${pill(m.channel)} ${pill(m.status, tone[m.status])}`)))
        : empty('No history yet', 'Sent, skipped and failed messages show up here.');
    }
    sendHtml(res, 200, page({
      title: 'Messages', active: 'messages', ctx,
      body: `${banner(url.searchParams)}${segmented('Message status', [['waiting', `Waiting${ctx.badge ? ` (${ctx.badge})` : ''}`, '/dashboard/messages'], ['approved', `Approved${nApproved ? ` (${nApproved})` : ''}`, '/dashboard/messages?view=approved'], ['history', 'History', '/dashboard/messages?view=history']], view)}${body}`,
    }));
  }

  // ================= payments (gateways) =================
  const webhookUrl = (id) => `${config.publicUrl}/v1/webhooks/${id}`;

  function paymentsPage(req, res, _p, url) {
    const ctx = requireSession(req);
    const p = ctx.project;
    const gws = projects.listGateways(p.id);
    const rows = gws.map((g) => row(`${esc(g.label)}<small>${esc(PRESETS[g.provider]?.label || g.provider)} · last webhook ${ago(g.last_event_at)}${g.last_result ? ` · ${esc(g.last_result)}` : ''}</small>`,
      g.enabled ? pill('On', 'green') : pill('Off'), { href: `/dashboard/payments/${g.id}` }));
    const presetRows = Object.entries(PRESETS).map(([k, v]) => row(esc(v.label), '', { href: `/dashboard/payments/new?provider=${k}`, sub: k === 'custom' ? 'Any gateway that signs its webhooks: Remita, Interswitch, OPay, your bank...' : '' }));
    sendHtml(res, 200, page({
      title: 'Payments', active: 'payments', ctx,
      subtitle: 'Connect every gateway you take payments with. Each one gets its own webhook URL.',
      body: `${banner(url.searchParams)}
      ${gws.length ? group('Connected', rows) : ''}
      ${group('Add a gateway', presetRows)}
      <form method="post" action="/dashboard/payments/mode">${csrfField(ctx)}
        ${group('What a gateway payment means', [select('gatewayMode', 'Payments are', [['sales', 'Sales (stores, subscriptions)'], ['deposits', 'Wallet deposits (VTU, betting, fintech)']], p.gateway_mode)],
          'With wallet deposits, only <code>trackPurchase</code> from your server counts as a sale, and people who fund but never buy become leads. You can tag single payments with <code>recoverkit_kind: "sale"</code> or <code>"deposit"</code> in the payment metadata.')}
        <button class="btn tinted">Save</button></form>`,
    }));
  }

  function gatewayForm(ctx, { provider, gw, action }) {
    const preset = PRESETS[provider];
    const spec = gw?.spec || preset.spec;
    const s1 = spec.signatures[0] || {}; const s2 = spec.signatures[1] || {};
    const sigFields = (prefix, s, optional) => [
      select(`${prefix}_scheme`, 'Signature type', [...(optional ? [['', 'None']] : []), ['hmac', 'HMAC of the request'], ['secret', 'Header equals the secret'], ['stripe', 'Stripe-style timestamped HMAC']], s.scheme || (optional ? '' : 'hmac')),
      field(`${prefix}_header`, 'Header name', s.header || '', { placeholder: 'x-signature', max: 64 }),
      select(`${prefix}_algorithm`, 'Algorithm', ALGORITHMS.map((a) => [a, a.toUpperCase().replace('SHA', 'SHA-')]), s.algorithm || 'sha256'),
      select(`${prefix}_encoding`, 'Encoding', [['hex', 'Hex'], ['base64', 'Base64']], s.encoding || 'hex'),
      field(`${prefix}_signs`, 'Signed part', s.signs || 'body', { hint: 'body, or field:data to sign only one JSON field', max: 80 }),
    ];
    return `<form method="post" action="${action}" autocomplete="off">${csrfField(ctx)}<input type="hidden" name="provider" value="${esc(provider)}">
      ${group('', [
        field('label', 'Name', gw?.label || preset.label, { max: 60 }),
        field('secret', esc(preset.secretLabel), '', { type: 'password', max: 500, hint: gw ? 'Saved and encrypted. Leave blank to keep it.' : 'Stored encrypted. Used only to check webhook signatures.', required: !gw }),
        ...(gw ? [switchRow('enabled', 'Accept webhooks', gw.enabled)] : []),
      ])}
      <details class="advanced"${provider === 'custom' ? ' open' : ''}><summary>Webhook format${provider === 'custom' ? '' : ' (pre-filled for ' + esc(preset.label) + ')'}</summary>
        <p class="group-foot">Use dotted field names from the webhook JSON, like <code>data.customer.email</code>. Check your gateway's webhook docs.</p>
        ${group('Signature check', sigFields('sig1', s1, false))}
        ${group('Second signature (optional)', sigFields('sig2', s2, true), 'Accepted if either check passes. Leave as None if your gateway has one method.')}
        ${group('Which webhooks count', [
          field('eventPath', 'Event field', spec.eventPath, { placeholder: 'event', max: 200 }),
          field('eventValues', 'Event values', spec.eventValues.join(', '), { placeholder: 'charge.success', max: 300, hint: 'Comma separated' }),
          field('statusPath', 'Status field', spec.statusPath, { placeholder: 'data.status', max: 200 }),
          field('statusValues', 'Success values', spec.statusValues.join(', '), { placeholder: 'success', max: 300 }),
          select('amountUnit', 'Amount is in', [['minor', 'Kobo / cents (minor units)'], ['major', 'Naira / dollars (major units)']], spec.amountUnit),
        ])}
        ${group('Where the details are', FIELD_NAMES.map((f) => field(`f_${f}`, FIELD_LABEL[f], spec.fields[f] || '', { max: 200, placeholder: f === 'amount' ? 'required' : 'optional' })))}
      </details>
      <button class="btn prominent wide">${gw ? 'Save changes' : 'Connect gateway'}</button></form>`;
  }

  function specFromForm(form) {
    const sig = (prefix) => ({ scheme: form[`${prefix}_scheme`], header: form[`${prefix}_header`], algorithm: form[`${prefix}_algorithm`], encoding: form[`${prefix}_encoding`], signs: (form[`${prefix}_signs`] || 'body').trim() });
    const signatures = [sig('sig1')];
    if (form.sig2_scheme) signatures.push(sig('sig2'));
    return {
      signatures, eventPath: form.eventPath, eventValues: form.eventValues, statusPath: form.statusPath, statusValues: form.statusValues,
      amountUnit: form.amountUnit, fields: Object.fromEntries(FIELD_NAMES.map((f) => [f, form[`f_${f}`]])),
    };
  }

  function newGatewayPage(req, res, _p, url) {
    const ctx = requireSession(req);
    const provider = url.searchParams.get('provider');
    if (!Object.prototype.hasOwnProperty.call(PRESETS, provider || '')) return redirect(res, '/dashboard/payments');
    sendHtml(res, 200, page({
      title: `Connect ${PRESETS[provider].label}`, active: 'payments', ctx,
      subtitle: 'After you connect, copy the webhook URL into your gateway\'s dashboard.',
      body: `${banner(url.searchParams)}${gatewayForm(ctx, { provider, action: '/dashboard/payments' })}`,
    }));
  }

  async function createGatewayAction(req, res) {
    const { ctx, form } = await postCtx(req, 64 * 1024);
    const provider = Object.prototype.hasOwnProperty.call(PRESETS, form.provider || '') ? form.provider : null;
    try {
      if (!provider) throw new Error('unknown gateway type');
      const id = projects.addGateway(ctx.project.id, { provider, label: form.label, secret: form.secret, spec: specFromForm(form) });
      projects.audit(ctx.project.id, ctx.user.email, 'gateway_added', `${provider} ${id}`);
      back(res, `/dashboard/payments/${id}`, 'Connected. Now paste the webhook URL into your gateway dashboard.');
    } catch (e) { back(res, `/dashboard/payments/new?provider=${provider || 'custom'}`, null, e.message); }
  }

  function gatewayPage(req, res, params, url) {
    const ctx = requireSession(req);
    const gw = projects.listGateways(ctx.project.id).find((g) => g.id === params.id);
    if (!gw) return redirect(res, '/dashboard/payments');
    sendHtml(res, 200, page({
      title: gw.label, active: 'payments', ctx,
      body: `${banner(url.searchParams)}
      ${group('Webhook URL', [`<div class="row"><input class="copy" readonly value="${esc(webhookUrl(gw.id))}" aria-label="Webhook URL"></div>`],
        `Paste this into your ${esc(PRESETS[gw.provider]?.label || 'gateway')} webhook settings. Last webhook: ${ago(gw.last_event_at)}${gw.last_result ? ` (${esc(gw.last_result)})` : ''}.`)}
      ${gatewayForm(ctx, { provider: gw.provider, gw, action: `/dashboard/payments/${gw.id}` })}
      <details class="danger"><summary>Remove this gateway…</summary>
        <form method="post" action="/dashboard/payments/${esc(gw.id)}/delete">${csrfField(ctx)}<p>Webhooks sent to this URL will be rejected. Purchases already recorded stay.</p>
        <button class="btn destructive-fill">Remove gateway</button></form></details>`,
    }));
  }

  async function updateGatewayAction(req, res, params) {
    const { ctx, form } = await postCtx(req, 64 * 1024);
    try {
      projects.updateGateway(ctx.project.id, params.id, { label: form.label, secret: form.secret, spec: specFromForm(form), enabled: form.enabled === '1' });
      projects.audit(ctx.project.id, ctx.user.email, 'gateway_updated', params.id);
      back(res, `/dashboard/payments/${params.id}`, 'Saved.');
    } catch (e) { back(res, `/dashboard/payments/${params.id}`, null, e.message); }
  }

  async function deleteGatewayAction(req, res, params) {
    const { ctx } = await postCtx(req);
    if (projects.deleteGateway(ctx.project.id, params.id)) projects.audit(ctx.project.id, ctx.user.email, 'gateway_removed', params.id);
    back(res, '/dashboard/payments', 'Gateway removed.');
  }

  async function modeAction(req, res) {
    const { ctx, form } = await postCtx(req);
    try { projects.update(ctx.project.id, { gatewayMode: form.gatewayMode }); back(res, '/dashboard/payments', 'Saved.'); }
    catch (e) { back(res, '/dashboard/payments', null, e.message); }
  }

  // ================= AI model =================
  function aiPage(req, res, _p, url) {
    const ctx = requireSession(req);
    const own = projects.getAiSettings(ctx.project);
    const current = own || { provider: '' };
    const def = config.ai || { provider: 'none' };
    const defLabel = def.provider === 'none' ? 'built-in templates' : `${AI_PROVIDERS[def.provider].label} · ${def.model}`;
    const radios = Object.entries(AI_PROVIDERS).map(([k, v]) => `<label class="row radio"><span class="row-label">${esc(v.label)}${v.modelHint ? `<small>Model: ${esc(v.modelHint)}</small>` : ''}${k === 'anthropic' ? '<small>Default model: claude-opus-5-5</small>' : ''}</span>
      <input type="radio" name="provider" value="${k}"${current.provider === k ? ' checked' : ''} required></label>`);
    sendHtml(res, 200, page({
      title: 'AI model', active: 'ai', ctx,
      subtitle: 'Choose the model that writes your follow-ups. It never sees names, emails or phone numbers.',
      body: `${banner(url.searchParams)}
      ${group('Right now', [row('Writing drafts with', esc(own ? (own.provider === 'none' ? 'Built-in templates' : `${AI_PROVIDERS[own.provider].label} · ${own.model}`) : `Server default (${defLabel})`))])}
      <form method="post" action="/dashboard/ai" autocomplete="off">${csrfField(ctx)}
        ${group('Provider', radios)}
        ${group('Model', [
          field('model', 'Model name', own?.model || '', { placeholder: 'e.g. claude-opus-5-5', max: 120 }),
          field('apiKey', 'API key', '', { type: 'password', max: 500, hint: own?.apiKey ? 'Saved and encrypted. Leave blank to keep it.' : 'Stored encrypted. Never shown again.' }),
          field('baseUrl', 'API base URL', own?.baseUrl || '', { placeholder: 'https://api.groq.com/openai/v1', max: 300, hint: 'Only for "Other (OpenAI-compatible)": Groq, DeepSeek, Mistral, OpenRouter, Together, Ollama...' }),
        ], 'If the model fails or writes something unsafe (links, phone numbers), RecoverKit uses a built-in template instead.')}
        <div class="actions"><button class="btn prominent">Save</button></div></form>
      <div class="actions">
        <form method="post" action="/dashboard/ai/test">${csrfField(ctx)}<button class="btn tinted">Test with a sample lead</button></form>
        ${own ? `<form method="post" action="/dashboard/ai/reset">${csrfField(ctx)}<button class="btn plain">Use server default</button></form>` : ''}
      </div>`,
    }));
  }

  async function aiSaveAction(req, res) {
    const { ctx, form } = await postCtx(req);
    try {
      projects.setAiSettings(ctx.project.id, { provider: form.provider, model: form.model, apiKey: form.apiKey, baseUrl: form.baseUrl });
      projects.audit(ctx.project.id, ctx.user.email, 'ai_settings', form.provider);
      back(res, '/dashboard/ai', 'Saved. Use "Test with a sample lead" to check it works.');
    } catch (e) { back(res, '/dashboard/ai', null, e.message); }
  }

  async function aiResetAction(req, res) {
    const { ctx } = await postCtx(req);
    projects.setAiSettings(ctx.project.id, null);
    back(res, '/dashboard/ai', 'Now using the server default.');
  }

  async function aiTestAction(req, res) {
    const { ctx } = await postCtx(req);
    if (!limiter.hit(`aitest:${ctx.project.id}`, 10, 60 * 60e3)) return back(res, '/dashboard/ai', null, 'Test limit reached. Try again in an hour.');
    const r = await drafter.test(ctx.project, resolveAi(ctx.project));
    if (r.ok) back(res, '/dashboard/ai', `It works. Sample: "${r.message.slice(0, 280)}"`);
    else back(res, '/dashboard/ai', null, `Test failed: ${r.error}`);
  }

  // ================= channels =================
  function channelsPage(req, res, _p, url) {
    const ctx = requireSession(req);
    const ch = projects.getChannels(ctx.project);
    const on = (v) => (v ? pill('Connected', 'green') : pill('Not set'));
    const keep = 'Leave blank to keep the saved value.';
    sendHtml(res, 200, page({
      title: 'Channels', active: 'channels', ctx,
      subtitle: 'Where follow-ups are sent. RecoverKit tries WhatsApp, then SMS, then email.',
      body: `${banner(url.searchParams)}<form method="post" action="/dashboard/channels" autocomplete="off">${csrfField(ctx)}
      ${group(`WhatsApp Cloud API ${on(ch.whatsapp)}`, [
        field('wa_accessToken', 'Access token', '', { type: 'password', max: 500 }), field('wa_phoneNumberId', 'Phone number ID', ch.whatsapp?.phoneNumberId || '', { max: 20 }),
        field('wa_templateName', 'Template name', ch.whatsapp?.templateName || '', { max: 100, hint: 'An approved template with one {{1}} body variable' }), field('wa_language', 'Template language', ch.whatsapp?.language || '', { placeholder: 'en', max: 10 }),
      ], keep)}
      ${group(`SMS (Termii) ${on(ch.sms)}`, [field('sms_apiKey', 'API key', '', { type: 'password', max: 200 }), field('sms_senderId', 'Sender ID', ch.sms?.senderId || '', { max: 11 })], keep)}
      ${group(`Email (Resend) ${on(ch.email)}`, [field('email_apiKey', 'API key', '', { type: 'password', max: 200 }), field('email_from', 'From', ch.email?.from || '', { placeholder: 'Ada <ada@yourshop.ng>', max: 200 })], keep)}
      ${group('', [switchRow('console', 'Test mode', Boolean(ch.console), 'Write messages to the server log instead of sending them')])}
      <button class="btn prominent wide">Save channels</button></form>`,
    }));
  }

  async function channelsAction(req, res) {
    const { ctx, form } = await postCtx(req);
    const cur = projects.getChannels(ctx.project);
    const pick = (name, prefix, fields) => {
      const next = { ...(cur[name] || {}) };
      let touched = false;
      for (const f of fields) { const v = (form[`${prefix}_${f}`] || '').trim(); if (v) { next[f] = v; touched = true; } }
      return touched ? next : null;
    };
    const wa = pick('whatsapp', 'wa', ['accessToken', 'phoneNumberId', 'templateName', 'language']);
    if (wa) projects.setChannel(ctx.project.id, 'whatsapp', wa);
    const sms = pick('sms', 'sms', ['apiKey', 'senderId']);
    if (sms) projects.setChannel(ctx.project.id, 'sms', sms);
    const email = pick('email', 'email', ['apiKey', 'from']);
    if (email) projects.setChannel(ctx.project.id, 'email', email);
    projects.setChannel(ctx.project.id, 'console', form.console === '1' ? { enabled: true } : null);
    projects.audit(ctx.project.id, ctx.user.email, 'channels');
    back(res, '/dashboard/channels', 'Saved.');
  }

  // ================= settings =================
  function settingsPage(req, res, _p, url, extra = '') {
    const ctx = requireSession(req);
    const p = ctx.project;
    const keys = db.all('SELECT id, label, created_at, revoked_at FROM api_keys WHERE project_id = ? ORDER BY created_at', p.id);
    const base = config.publicUrl;
    const runs = db.all('SELECT * FROM connector_runs WHERE project_id = ? ORDER BY at DESC LIMIT 5', p.id);
    sendHtml(res, 200, page({
      title: 'Settings', active: 'settings', ctx,
      body: `${banner(url.searchParams)}${extra}
      <div class="mobile-only">${group('', [row('Payments', '', { href: '/dashboard/payments' }), row('AI model', '', { href: '/dashboard/ai' }), row('Channels', '', { href: '/dashboard/channels' }), row('Developers', '', { href: '/dashboard/developers' })])}</div>
      <form method="post" action="/dashboard/settings">${csrfField(ctx)}
        ${group('Your business', [
          `<label class="row field stacked"><span class="row-label">Your voice<small>How you talk to customers. Slang or Pidgin welcome. Mention anything that's genuinely limited.</small></span><textarea name="voiceProfile" rows="4" maxlength="2000">${esc(p.voice_profile)}</textarea></label>`,
          field('paymentLink', 'Payment link', p.payment_link, { placeholder: 'https://yourshop.ng/pay', max: 300, hint: 'Added to every message' }),
          field('allowedOrigins', 'Allowed websites', JSON.parse(p.allowed_origins).join(' '), { placeholder: 'https://yourshop.ng', max: 1000, hint: 'Blank means any site can use your public key' }),
          switchRow('requireApproval', 'Approve every message', Boolean(p.require_approval), 'Recommended while you build trust in the drafts'),
        ])}
        <button class="btn prominent">Save</button></form>
      ${group('Install', [
        row('Public key', `<code>${esc(p.public_key)}</code>`, { sub: 'Safe to put in your website or app' }),
        `<div class="row"><pre>&lt;script src="${esc(base)}/sdk/recoverkit.js"&gt;&lt;/script&gt;
&lt;script&gt;RecoverKit.init({ key: '${esc(p.public_key)}', endpoint: '${esc(base)}' });&lt;/script&gt;</pre></div>`,
        row('Full setup for your developer', '', { href: '/dashboard/developers', sub: 'Website, server, payments and past customers, with your keys filled in' }),
      ], 'Then call <code>RecoverKit.identify({ email, phone })</code> after login, and <code>trackPurchase</code> from your server when a sale really happens.')}
      ${group('Existing data (read-only connector)', runs.length
        ? runs.map((r) => row(`Synced ${ago(r.at)}<small>${esc(r.source)} ${esc(r.version)}</small>`, `${Number(r.people)} people · ${Number(r.events)} records · ${Number(r.new_events)} new`))
        : [row('Not connected yet', '', { sub: 'Bring in your past customers without exporting anything' })],
        `The connector runs on your own server with a read-only database login. Only hashes, dates and amounts leave it, and every query it runs is logged on your server. Set it up from the <a href="/dashboard/developers">Developers</a> page. To cut it off instantly, revoke the secret key it uses below.`)}
      ${group('Secret keys', [
        ...keys.map((k) => `<div class="row"><span class="row-label"><code>${esc(k.id)}</code><small>${esc(k.label)} · created ${ago(k.created_at)}</small></span><span class="row-value">${k.revoked_at ? pill('Revoked') : `<form method="post" action="/dashboard/keys/${esc(k.id)}/revoke">${csrfField(ctx)}<button class="btn plain destructive small">Revoke</button></form>`}</span></div>`),
      ], 'For your server only. Never put a secret key in a website or app.')}
      <form method="post" action="/dashboard/keys">${csrfField(ctx)}<button class="btn tinted">Create a secret key</button></form>
      <div class="mobile-only"><form method="post" action="/logout">${csrfField(ctx)}<button class="btn plain destructive wide">Log out ${esc(ctx.user.email)}</button></form></div>`,
    }));
  }

  async function settingsAction(req, res) {
    const { ctx, form } = await postCtx(req);
    try {
      projects.update(ctx.project.id, {
        voiceProfile: form.voiceProfile ?? '', paymentLink: form.paymentLink ?? '',
        allowedOrigins: form.allowedOrigins ?? '', requireApproval: form.requireApproval === '1',
      });
      projects.audit(ctx.project.id, ctx.user.email, 'settings');
      back(res, '/dashboard/settings', 'Saved.');
    } catch (e) { back(res, '/dashboard/settings', null, e.message); }
  }

  async function newKeyAction(req, res, _p, url) {
    const { ctx } = await postCtx(req);
    const key = projects.createSecretKey(ctx.project.id, 'dashboard');
    projects.audit(ctx.project.id, ctx.user.email, 'key_created');
    settingsPage(req, res, null, url, `<div class="banner ok" role="status">${icon('check')}<span>Copy your new secret key now. It won't be shown again.<input class="copy" readonly value="${esc(key)}" aria-label="New secret key"></span></div>`);
  }

  async function revokeKeyAction(req, res, params) {
    const { ctx } = await postCtx(req);
    projects.revokeSecretKey(ctx.project.id, params.id);
    projects.audit(ctx.project.id, ctx.user.email, 'key_revoked', params.id);
    back(res, '/dashboard/settings', 'Key revoked.');
  }

  // ================= developers =================
  const GUIDE_DAYS = 30;
  const guideLink = (projectId) => `${config.publicUrl}/dev/${signToken(keys.sign, { g: projectId }, GUIDE_DAYS * 86400)}`;

  function developersPage(req, res, _p, url, secretKey = null) {
    const ctx = requireSession(req);
    const p = ctx.project;
    const share = group('Send this to your developer', [
      `<div class="row share-row"><input class="copy" readonly value="${esc(guideLink(p.id))}" aria-label="Guide link for your developer"></div>`,
    ], `A read-only copy of this page with your public key filled in, valid for ${GUIDE_DAYS} days. It doesn't contain a secret key or your data. Create a secret key below and send it separately, in a private message.`);
    const keyForm = secretKey ? '' : `<form method="post" action="/dashboard/developers/key">${csrfField(ctx)}<button class="btn tinted">Create a secret key for your developer</button></form>`;
    sendHtml(res, 200, page({
      title: 'Developers', active: 'developers', ctx,
      subtitle: 'Everything your developer needs to connect your website, server and past customers. They don\'t need any RecoverKit code or access to this dashboard.',
      body: `${banner(url.searchParams)}${share}${keyForm}<div class="guide">${developerGuide({ base: config.publicUrl, publicKey: p.public_key, secretKey, mode: p.gateway_mode })}</div>`,
    }));
  }

  async function developerKeyAction(req, res, _p, url) {
    const { ctx } = await postCtx(req);
    if (!limiter.hit(`devkey:${ctx.project.id}`, 10, 60 * 60e3)) return back(res, '/dashboard/developers', null, 'Too many new keys. Try again in an hour.');
    const key = projects.createSecretKey(ctx.project.id, 'developer');
    projects.audit(ctx.project.id, ctx.user.email, 'key_created', 'developer');
    developersPage(req, res, null, url, key);
  }

  /** The shareable guide: public key and server address only, no session needed. */
  function sharedGuidePage(_req, res, params) {
    const t = verifyToken(keys.sign, params.token);
    const p = t?.g ? projects.byId(t.g) : null;
    if (!p) {
      return sendHtml(res, 404, page({ wide: true, title: 'This link has expired', subtitle: 'Ask the business owner for a new link from their RecoverKit dashboard (Developers page).', body: '' }));
    }
    sendHtml(res, 200, page({
      wide: true, title: `Connect ${p.name} to RecoverKit`,
      subtitle: 'Developer setup guide. You don\'t need any RecoverKit code: everything is below.',
      body: `<div class="guide docs">${developerGuide({ base: config.publicUrl, publicKey: p.public_key, mode: p.gateway_mode, links: false })}</div>
        <p class="docs-intro">Full API reference: <a href="/docs#api">${esc(config.publicUrl)}/docs</a></p>`,
    }), { 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  }

  function docsPage(_req, res) {
    sendHtml(res, 200, page({
      wide: true, title: 'RecoverKit developer docs',
      subtitle: 'Connect a website, a server and past customers to this RecoverKit server. Your keys are on the Developers page of your dashboard.',
      body: `<div class="guide docs">${developerGuide({ base: config.publicUrl, publicKey: null, links: false })}${apiReference(config.publicUrl)}</div>`,
    }));
  }

  // ================= draft & send =================
  async function draftsAction(req, res) {
    const { ctx } = await postCtx(req);
    if (!limiter.hit(`drafts:${ctx.project.id}`, 10, 60 * 60e3)) return back(res, '/dashboard/leads', null, 'Draft limit reached, try again later.');
    const r = await outreach.generateDrafts(ctx.project.id, { limit: 20 });
    const extra = r.noContact ? ` ${r.noContact} lead${r.noContact === 1 ? ' has' : 's have'} no contact details, or no channel is set up for them.` : '';
    back(res, '/dashboard/messages', `Drafted ${r.drafted}.${r.skipped ? ` Skipped ${r.skipped}.` : ''}${extra}`);
  }

  async function approveAction(req, res, params) {
    const { ctx, form } = await postCtx(req);
    try { outreach.approve(ctx.project.id, params.id, ctx.user.email, form.body); back(res, '/dashboard/messages', 'Approved.'); }
    catch (e) { back(res, '/dashboard/messages', null, e.message); }
  }

  async function rejectAction(req, res, params) {
    const { ctx } = await postCtx(req);
    try { outreach.reject(ctx.project.id, params.id, ctx.user.email); back(res, '/dashboard/messages', 'Rejected.'); }
    catch (e) { back(res, '/dashboard/messages', null, e.message); }
  }

  async function sendAction(req, res) {
    const { ctx } = await postCtx(req);
    const r = await outreach.sendApproved(ctx.project.id);
    projects.audit(ctx.project.id, ctx.user.email, 'send_clicked', JSON.stringify(r));
    back(res, '/dashboard/messages?view=history', `Sent ${r.sent}. Failed ${r.failed}. Skipped ${r.skipped} (already paid, opted out or messaged recently).`);
  }

  return {
    loginPage, login, logout, overview, leadsPage, messagesPage,
    paymentsPage, newGatewayPage, createGatewayAction, gatewayPage, updateGatewayAction, deleteGatewayAction, modeAction,
    aiPage, aiSaveAction, aiResetAction, aiTestAction, channelsPage, channelsAction,
    settingsPage, settingsAction, newKeyAction, revokeKeyAction, draftsAction, approveAction, rejectAction, sendAction,
    developersPage, developerKeyAction, sharedGuidePage, docsPage,
  };
}
