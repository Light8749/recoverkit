// Account pages (forgot password, reset and invite links, change password) and the Admin
// section, where whoever runs this RecoverKit server adds businesses and their logins.
import { HttpError, sendHtml, redirect, readBody, parseForm, clientIp } from '../http.js';
import { checkPassword, RESET_MINUTES, INVITE_DAYS } from '../accounts.js';
import { normalizeEmail } from '../../sdk/core/identity.js';
import { esc, money, ago, csrfField, banner, page, group, row, field, select, pill, empty } from './ui.js';
import { kobo } from './mascot.js';

const ADMIN_RESET_HOURS = 24;

export function createAccountPages({ db, config, projects, engine, limiter, accounts, mailer, logger = console, requireSession, postCtx, sameOrigin, back }) {
  const link = (token) => `${config.publicUrl}/reset/${token}`;

  const hide = (e) => e.replace(/^(.).*@/, '$1***@');
  async function mail(to, subject, text) {
    if (!mailer.enabled) { logger.warn?.(`[mail] not sent to ${hide(to)}: email is not set up (RK_MAIL_FROM is missing from .env)`); return false; }
    const r = await mailer.send({ to, subject, text });
    if (r.ok) logger.warn?.(`[mail] sent "${subject}" to ${hide(to)} by ${mailer.mode}`);
    else logger.warn?.(`[mail] to ${hide(to)} failed: ${r.error}`);
    return r.ok;
  }

  const inviteText = (name, token) => `Hello,\n\nYou've been given a RecoverKit login for ${name}. RecoverKit finds people who signed up and never bought, or bought once and went quiet, and drafts follow-ups for you to approve.\n\nChoose your password here (the link works for ${INVITE_DAYS} days):\n${link(token)}\n\nThen sign in at ${config.publicUrl}/login\n`;
  const resetText = (token, minutes) => `Hello,\n\nSomeone asked to reset the password for your RecoverKit login. If it was you, choose a new password here (the link works for ${minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`}):\n${link(token)}\n\nIf it wasn't you, ignore this email: your password hasn't changed.\n`;

  // A page anyone can open (signed out): narrow, with Kobo on top.
  const authPage = (title, subtitle, inner) => page({ title, subtitle, body: `<div class="auth"><div class="auth-hero">${kobo({ mode: 'mark', size: 96, title: 'Kobo' })}</div>${inner}</div>` });

  // ================= forgot password =================
  function forgotPage(_req, res, _p, url) {
    sendHtml(res, 200, authPage('Reset your password', 'We\'ll email you a link to choose a new one.', `${banner(url.searchParams)}
      <form method="post" action="/forgot">${group('', [field('email', 'Email', '', { type: 'email', max: 254, required: true, autocomplete: 'username', placeholder: 'you@yourbusiness.ng' })])}
      <button class="btn prominent wide">Send reset link</button></form>
      <p class="subtitle"><a href="/login">Back to sign in</a></p>`));
  }

  async function forgot(req, res) {
    if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin request blocked');
    const form = parseForm(await readBody(req, 4096));
    const email = normalizeEmail(form.email) || '';
    const ip = clientIp(req, config.trustProxy);
    // Same answer whether or not the email exists, so this can't be used to find accounts.
    // The email address is never put in the redirect URL (browser history, server logs).
    const done = () => redirect(res, '/forgot?ok=' + encodeURIComponent(`If that email has a RecoverKit login, a reset link is on its way. It works for ${RESET_MINUTES} minutes. Check your spam folder too. No email? Ask whoever set up your RecoverKit account.`));
    if (!limiter.hit(`forgot-ip:${ip}`, 10, 15 * 60e3)) return redirect(res, '/forgot?err=' + encodeURIComponent('Too many requests. Try again in 15 minutes.'));
    if (!email || !limiter.hit(`forgot-email:${email}`, 3, 60 * 60e3)) return done();
    const u = accounts.byEmail(email);
    if (!u) logger.warn?.(`[mail] password reset asked for ${hide(email)}: no login with that email, nothing sent`);
    if (u) {
      const token = accounts.issue(u.id, 'reset');
      projects.audit(u.project_id, u.email, 'password_reset_requested', ip);
      await mail(u.email, 'Reset your RecoverKit password', resetText(token, RESET_MINUTES));
    }
    done();
  }

  // ================= reset / invite link =================
  function resetPage(_req, res, params, url) {
    const t = accounts.lookup(params.token);
    if (!t) {
      return sendHtml(res, 410, authPage('This link has expired', 'Links work once, for a limited time. Ask for a new one.', '<a class="btn tinted wide" href="/forgot">Get a new link</a>'), { 'Referrer-Policy': 'no-referrer' });
    }
    const invite = t.purpose === 'invite';
    const p = projects.byId(t.user.project_id);
    sendHtml(res, 200, authPage(invite ? 'Choose your password' : 'Choose a new password', invite ? `Your RecoverKit login for ${esc(p?.name || 'your business')}: ${esc(t.user.email)}` : esc(t.user.email), `${banner(url.searchParams)}
      <form method="post" action="/reset/${esc(params.token)}">
        <input type="email" name="username" value="${esc(t.user.email)}" autocomplete="username" readonly hidden>
        ${group('', [
          field('password', 'New password', '', { type: 'password', max: 200, required: true, autocomplete: 'new-password', placeholder: '12+ characters' }),
          field('confirm', 'Again', '', { type: 'password', max: 200, required: true, autocomplete: 'new-password', placeholder: 'Same password' }),
        ], 'A short sentence you\'ll remember works well, like "kobo flies home at 6".')}
        <button class="btn prominent wide">${invite ? 'Set password' : 'Save new password'}</button></form>`), { 'Referrer-Policy': 'no-referrer' });
  }

  async function reset(req, res, params) {
    if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin request blocked');
    if (!limiter.hit(`reset-ip:${clientIp(req, config.trustProxy)}`, 20, 15 * 60e3)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const form = parseForm(await readBody(req, 4096));
    const path = `/reset/${params.token}`;
    try { checkPassword(form.password, form.confirm); } catch (e) { return back(res, path, null, e.message); }
    let user;
    try { user = accounts.redeem(params.token, form.password); } catch (e) { return redirect(res, '/login?err=' + encodeURIComponent(e.message)); }
    projects.audit(user.project_id, user.email, user.password_hash ? 'password_reset' : 'invite_accepted');
    if (user.password_hash) await mail(user.email, 'Your RecoverKit password was changed', `Hello,\n\nThe password for your RecoverKit login was just changed, and you were signed out everywhere.\n\nIf this wasn't you, reset it now: ${config.publicUrl}/forgot\n`);
    redirect(res, '/login?ok=' + encodeURIComponent('Password saved. Sign in with it now.'));
  }

  // ================= change password (signed in) =================
  async function changePasswordAction(req, res) {
    const { ctx, form } = await postCtx(req);
    if (!limiter.hit(`pwchange:${ctx.user.id}`, 10, 15 * 60e3)) return back(res, '/dashboard/settings', null, 'Too many attempts. Try again in 15 minutes.');
    try {
      checkPassword(form.newPassword, form.confirm);
      accounts.changePassword(ctx.user.id, form.currentPassword, form.newPassword, ctx.tokenHash);
    } catch (e) { return back(res, '/dashboard/settings', null, e.message); }
    projects.audit(ctx.project.id, ctx.user.email, 'password_changed');
    await mail(ctx.user.email, 'Your RecoverKit password was changed', `Hello,\n\nThe password for your RecoverKit login was just changed. Other devices were signed out.\n\nIf this wasn't you, reset it now: ${config.publicUrl}/forgot\n`);
    back(res, '/dashboard/settings', 'Password changed. You\'re still signed in here; other devices were signed out.');
  }

  const passwordGroup = (ctx) => `<form method="post" action="/dashboard/password">${csrfField(ctx)}
    <input type="email" name="username" value="${esc(ctx.user.email)}" autocomplete="username" readonly hidden>
    ${group('Password', [
      field('currentPassword', 'Current password', '', { type: 'password', max: 200, required: true, autocomplete: 'current-password' }),
      field('newPassword', 'New password', '', { type: 'password', max: 200, required: true, autocomplete: 'new-password', placeholder: '12+ characters' }),
      field('confirm', 'New password again', '', { type: 'password', max: 200, required: true, autocomplete: 'new-password' }),
    ], 'Changing it signs you out on every other device.')}
    <button class="btn tinted">Change password</button></form>`;

  // ================= admin =================
  function requireAdmin(req) {
    const ctx = requireSession(req);
    if (!ctx.user.is_admin) throw new HttpError(403, 'Only the admin of this RecoverKit server can open this page.');
    return ctx;
  }
  async function adminPost(req) {
    const r = await postCtx(req);
    if (!r.ctx.user.is_admin) throw new HttpError(403, 'Only the admin of this RecoverKit server can do this.');
    return r;
  }

  /** Shown once after creating a link: emailed if possible, always copyable. */
  const linkBanner = (email, token, sent, what) => `<div class="banner ok" role="status"><span><b>${sent ? `${what} emailed to ${esc(email)}.` : `Send this ${what.toLowerCase()} to ${esc(email)} yourself`}</b>${sent ? ' You can also send the link below by WhatsApp.' : mailer.enabled ? ' (the email didn\'t go through).' : ' by WhatsApp or SMS: email isn\'t set up on this server.'} It works once.
    <input class="copy" readonly value="${esc(link(token))}" aria-label="Link for ${esc(email)}"></span></div>`;

  function adminPage(req, res, _p, url, extra = '') {
    const ctx = requireAdmin(req);
    const list = db.all('SELECT p.id, p.name, p.gateway_mode, p.created_at, (SELECT COUNT(*) FROM users u WHERE u.project_id = p.id) users, (SELECT COUNT(*) FROM persons x WHERE x.project_id = p.id) people FROM projects p ORDER BY p.created_at DESC LIMIT 500');
    const rows = list.map((p) => {
      const rev = engine.revenue(p.id);
      return row(`${esc(p.name)}<small>${p.gateway_mode === 'deposits' ? 'Wallet deposits' : 'Sales'} · ${Number(p.users)} login${p.users === 1 ? '' : 's'} · ${Number(p.people)} people · added ${ago(p.created_at)}</small>`,
        `<span class="num">${money(rev.recoveredAmount, 'NGN')}</span>`, { href: `/admin/businesses/${p.id}` });
    });
    sendHtml(res, 200, page({
      title: 'Businesses', active: 'admin', ctx,
      subtitle: 'Every business on this RecoverKit server. Only you (the admin) can see this page.',
      body: `${banner(url.searchParams)}${extra}
      <form method="post" action="/admin/businesses" autocomplete="off">${csrfField(ctx)}
        ${group('Add a business', [
          field('name', 'Business name', '', { max: 80, required: true, placeholder: 'Ada VTU' }),
          select('mode', 'They take', [['deposits', 'Wallet deposits (VTU, betting, fintech)'], ['sales', 'Sales (stores, subscriptions)']], 'deposits'),
          field('email', 'Owner\'s email', '', { type: 'email', max: 254, required: true, placeholder: 'owner@theirbusiness.ng' }),
        ], `The owner gets a link to choose their password (it works for ${INVITE_DAYS} days). Then they connect their app from their Developers page.`)}
        <button class="btn prominent">Add business</button></form>
      ${rows.length ? group(`${rows.length} business${rows.length === 1 ? '' : 'es'}`, rows, 'Recovered revenue is all time.') : empty('No businesses yet', 'Add the first one above.')}
      ${group('Email', [row('Invites and password resets', mailer.enabled ? pill(`Sent by ${mailer.mode}`, 'green') : pill('Not set up', 'orange'),
        { sub: mailer.enabled ? 'Links are emailed, and shown here too' : 'Links are shown here for you to send. Set RK_MAIL_FROM in .env to email them.' })])}
      ${mailer.enabled ? `<form method="post" action="/admin/mail-test">${csrfField(ctx)}<button class="btn tinted">Send a test email to ${esc(ctx.user.email)}</button></form>` : ''}`,
    }));
  }

  async function addBusinessAction(req, res, _p, url) {
    const { ctx, form } = await adminPost(req);
    let p, inv;
    try {
      if (!normalizeEmail(form.email)) throw new Error('Enter a valid email address.');
      if (db.get('SELECT 1 FROM users WHERE email = ?', normalizeEmail(form.email))) throw new Error('That email already has a RecoverKit login.');
      db.tx(() => {
        p = projects.create({ name: form.name, gatewayMode: form.mode, withKey: false });
        inv = accounts.invite(p.id, form.email);
      });
    } catch (e) { return back(res, '/admin', null, e.message); }
    projects.audit(p.id, ctx.user.email, 'business_added', form.name);
    const email = normalizeEmail(form.email);
    const sent = await mail(email, `Your RecoverKit login for ${String(form.name).slice(0, 80)}`, inviteText(String(form.name).slice(0, 80), inv.token));
    adminBusinessPage(req, res, { id: p.id }, url, linkBanner(email, inv.token, sent, 'Invite'));
  }

  function adminBusinessPage(req, res, params, url, extra = '') {
    const ctx = requireAdmin(req);
    const p = projects.byId(params.id);
    if (!p) return redirect(res, '/admin');
    const users = db.all('SELECT id, email, password_hash, is_admin, created_at FROM users WHERE project_id = ? ORDER BY created_at', p.id);
    const rev = engine.revenue(p.id);
    const events = db.get('SELECT COUNT(*) n FROM events WHERE project_id = ?', p.id).n;
    const lastSync = db.get('SELECT at FROM connector_runs WHERE project_id = ? ORDER BY at DESC LIMIT 1', p.id);
    const gws = projects.listGateways(p.id).length;
    const userRows = users.map((u) => `<div class="row"><span class="row-label">${esc(u.email)}<small>${u.password_hash ? 'Active' : 'Invited, no password yet'}${u.is_admin ? ' · admin' : ''} · added ${ago(u.created_at)}</small></span>
      <span class="row-value"><form method="post" action="/admin/users/${esc(u.id)}/link">${csrfField(ctx)}<button class="btn plain small">${u.password_hash ? 'Reset link' : 'New invite link'}</button></form></span></div>`);
    sendHtml(res, 200, page({
      title: p.name, active: 'admin', ctx,
      subtitle: `${p.gateway_mode === 'deposits' ? 'Wallet deposits' : 'Sales'} · added ${ago(p.created_at)}`,
      body: `${banner(url.searchParams)}${extra}
      ${group('Setup', [
        row('Website or server connected', events ? pill(`${events} events`, 'green') : pill('Not yet')),
        row('Payment gateways', gws ? pill(String(gws), 'green') : pill('None')),
        row('Past customers (connector)', lastSync ? `Synced ${ago(lastSync.at)}` : pill('Not yet')),
        row('Recovered revenue', money(rev.recoveredAmount, p.currency), { sub: `${rev.recoveredPurchases} sale${rev.recoveredPurchases === 1 ? '' : 's'} · ${rev.messagesSent} messages sent` }),
      ])}
      ${group('Logins', userRows, `Reset links work for ${ADMIN_RESET_HOURS} hours, invite links for ${INVITE_DAYS} days. Making a new link cancels the previous one.`)}
      <form method="post" action="/admin/businesses/${esc(p.id)}/users" autocomplete="off">${csrfField(ctx)}
        ${group('Add a login', [field('email', 'Email', '', { type: 'email', max: 254, required: true, placeholder: 'colleague@theirbusiness.ng' })], 'For a colleague of the owner. They see this business\'s dashboard only.')}
        <button class="btn tinted">Send invite</button></form>
      <p><a class="btn plain" href="/admin">All businesses</a></p>`,
    }));
  }

  async function addUserAction(req, res, params, url) {
    const { ctx, form } = await adminPost(req);
    const p = projects.byId(params.id);
    if (!p) return redirect(res, '/admin');
    let inv;
    try { inv = accounts.invite(p.id, form.email); } catch (e) { return back(res, `/admin/businesses/${p.id}`, null, e.message); }
    const email = normalizeEmail(form.email);
    projects.audit(p.id, ctx.user.email, 'user_invited', email);
    const sent = await mail(email, `Your RecoverKit login for ${p.name}`, inviteText(p.name, inv.token));
    adminBusinessPage(req, res, { id: p.id }, url, linkBanner(email, inv.token, sent, 'Invite'));
  }

  async function userLinkAction(req, res, params, url) {
    const { ctx } = await adminPost(req);
    const u = accounts.byId(params.id);
    if (!u) return redirect(res, '/admin');
    const p = projects.byId(u.project_id);
    const invite = !u.password_hash;
    const token = accounts.issue(u.id, invite ? 'invite' : 'reset', invite ? undefined : ADMIN_RESET_HOURS * 60);
    projects.audit(u.project_id, ctx.user.email, invite ? 'invite_link_created' : 'reset_link_created', u.email);
    const sent = await mail(u.email, invite ? `Your RecoverKit login for ${p.name}` : 'Reset your RecoverKit password', invite ? inviteText(p.name, token) : resetText(token, ADMIN_RESET_HOURS * 60));
    adminBusinessPage(req, res, { id: u.project_id }, url, linkBanner(u.email, token, sent, invite ? 'Invite' : 'Reset link'));
  }

  async function mailTestAction(req, res) {
    const { ctx } = await adminPost(req);
    if (!limiter.hit(`mailtest:${ctx.user.id}`, 5, 60 * 60e3)) return back(res, '/admin', null, 'Test limit reached. Try again in an hour.');
    const r = mailer.enabled ? await mailer.send({ to: ctx.user.email, subject: 'RecoverKit test email', text: `It works. Invites and password resets from ${config.publicUrl} will be sent this way (${mailer.mode}).\n` }) : { ok: false, error: 'email is not set up' };
    if (r.ok) back(res, '/admin', `Sent to ${ctx.user.email} by ${mailer.mode}. Check your inbox (and spam).`);
    else back(res, '/admin', null, `Email failed: ${r.error}`);
  }

  return {
    mailTestAction, forgotPage, forgot, resetPage, reset, changePasswordAction, passwordGroup,
    adminPage, addBusinessAction, adminBusinessPage, addUserAction, userLinkAction,
  };
}
