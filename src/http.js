// Minimal HTTP helpers: routing, bounded body reading, security headers, rate limiting.

export class HttpError extends Error {
  constructor(status, message, expose = true) { super(message); this.status = status; this.expose = expose; }
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // same-origin (not no-referrer): with no-referrer, browsers send `Origin: null` on form posts.
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  const payload = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...(res.rkSecure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    ...headers,
  });
  res.end(payload);
}

export const CSP = "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function sendHtml(res, status, html, headers = {}) {
  send(res, status, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, ...headers });
}

export function redirect(res, location, headers = {}) {
  // Only same-site relative redirects are ever issued.
  if (!location.startsWith('/') || location.startsWith('//')) location = '/dashboard';
  send(res, 303, '', { Location: location, ...headers });
}

/** Read the body with a hard size limit. Rejects early on Content-Length. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) { reject(new HttpError(413, 'body too large')); req.resume(); return; }
    const chunks = []; let size = 0; let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(new HttpError(413, 'body too large')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

export function parseJson(buf) {
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch { throw new HttpError(400, 'invalid JSON body'); }
}

export function parseForm(buf) {
  const out = Object.create(null);
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) out[k] = v;
  return out;
}

export function parseCookies(header = '') {
  const out = Object.create(null);
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export function isSecure(req, trustProxy) {
  return Boolean(req.socket.encrypted) || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
}

/** Fixed-window rate limiter held in memory. */
export class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [k, b] of this.buckets) if (b.reset <= now) this.buckets.delete(k);
    }, 60_000);
    this.timer.unref();
  }
  /** Returns true if allowed. */
  hit(key, limit, windowMs) {
    const now = Date.now();
    let b = this.buckets.get(key);
    // Hard cap so a flood of distinct keys (spoofed IPs) can't exhaust memory.
    if (!b && this.buckets.size >= 100_000) {
      for (const [k, v] of this.buckets) if (v.reset <= now) this.buckets.delete(k);
      if (this.buckets.size >= 100_000) return false;
    }
    if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; this.buckets.set(key, b); }
    b.count++;
    return b.count <= limit;
  }
  reset(key) { this.buckets.delete(key); }
  stop() { clearInterval(this.timer); }
}

export class Router {
  constructor() { this.routes = []; }
  add(method, path, handler) {
    // '/v1/webhooks/:provider/:pk' -> named groups limited to safe characters
    const re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, '(?<$1>[A-Za-z0-9_-]{1,128})') + '/?$');
    this.routes.push({ method, re, handler });
    return this;
  }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method === method) return { handler: r.handler, params: { ...m.groups } };
    }
    return pathMatched ? { status: 405 } : null;
  }
}
