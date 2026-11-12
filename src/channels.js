// Sending channels. Each adapter takes (cfg, {to, body, subject}) and returns {ok, id?, error?}.
// Credentials live encrypted in the database and are only decrypted at send time.

const TIMEOUT = 10_000;

async function postJson(fetchFn, url, headers, body) {
  const res = await fetchFn(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT), redirect: 'error',
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

export const adapters = {
  /** Development: prints instead of sending. */
  async console(_cfg, msg, { logger }) {
    logger.log(`[send:console] to=${msg.toMasked} :: ${msg.body}`);
    return { ok: true, id: 'console' };
  },

  /** Email via Resend (https://resend.com). cfg: { apiKey, from } */
  async email(cfg, msg, { fetch }) {
    if (!cfg?.apiKey || !cfg?.from) return { ok: false, error: 'email channel not configured' };
    const { status, json } = await postJson(fetch, 'https://api.resend.com/emails', { Authorization: `Bearer ${cfg.apiKey}` }, {
      from: cfg.from, to: [msg.to], subject: msg.subject || 'A quick note', text: msg.body + '\n\n' + msg.unsubscribeText,
      headers: { 'List-Unsubscribe': `<${msg.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    return status < 300 ? { ok: true, id: json.id } : { ok: false, error: `resend ${status}` };
  },

  /** SMS via Termii (Nigeria). cfg: { apiKey, senderId } */
  async sms(cfg, msg, { fetch }) {
    if (!cfg?.apiKey || !cfg?.senderId) return { ok: false, error: 'sms channel not configured' };
    const { status, json } = await postJson(fetch, 'https://api.ng.termii.com/api/sms/send', {}, {
      api_key: cfg.apiKey, to: msg.to, from: cfg.senderId, sms: `${msg.body} ${msg.unsubscribeText}`, type: 'plain', channel: 'generic',
    });
    return status < 300 && json.message_id ? { ok: true, id: json.message_id } : { ok: false, error: `termii ${status}` };
  },

  /**
   * WhatsApp Cloud API. Business-started chats must use an approved template.
   * cfg: { accessToken, phoneNumberId, templateName, language }
   * The template needs one body variable ({{1}}), which receives the drafted text.
   */
  async whatsapp(cfg, msg, { fetch }) {
    if (!cfg?.accessToken || !cfg?.phoneNumberId || !cfg?.templateName) return { ok: false, error: 'whatsapp channel not configured' };
    if (!/^\d{5,20}$/.test(cfg.phoneNumberId)) return { ok: false, error: 'bad phoneNumberId' };
    const { status, json } = await postJson(fetch, `https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`, { Authorization: `Bearer ${cfg.accessToken}` }, {
      messaging_product: 'whatsapp', to: msg.to, type: 'template',
      template: {
        name: cfg.templateName, language: { code: cfg.language || 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: msg.body.replace(/\s*\n\s*/g, ' ') }] }],
      },
    });
    return status < 300 ? { ok: true, id: json.messages?.[0]?.id } : { ok: false, error: `whatsapp ${status}` };
  },
};

export const mask = (s) => (!s ? '' : s.includes('@') ? s.replace(/^(.).*(@.*)$/, '$1***$2') : s.slice(0, 5) + '****' + s.slice(-2));

/** A channel counts only when everything needed to send is set (WhatsApp replies alone don't count). */
export function channelReady(channels, c) {
  const cfg = channels?.[c];
  if (!cfg) return false;
  if (c === 'whatsapp') return Boolean(cfg.accessToken && cfg.phoneNumberId && cfg.templateName);
  if (c === 'sms') return Boolean(cfg.apiKey && cfg.senderId);
  if (c === 'email') return Boolean(cfg.apiKey && cfg.from);
  return Boolean(cfg);
}

/** Pick the first configured channel the person can be reached on. */
export function chooseChannel(channels, contact, preferred) {
  const order = preferred ? [preferred] : ['whatsapp', 'sms', 'email', 'console'];
  for (const c of order) {
    if (!channelReady(channels, c)) continue;
    if ((c === 'whatsapp' || c === 'sms') && contact?.phone) return { channel: c, to: contact.phone };
    if (c === 'email' && contact?.email) return { channel: c, to: contact.email };
    if (c === 'console') return { channel: c, to: contact?.phone || contact?.email || '(no contact)' };
  }
  return null;
}
