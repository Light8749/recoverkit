import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PRESETS, validateSpec, verifySignature, extractPayment, getPath } from '../src/gateways.js';
import { validateAiSettings, generateDraftJson, assertSafeUrl, aiFromEnv, createDrafter } from '../src/ai.js';

const SECRET = 'test-secret-123456';
const hmac = (alg, data, enc = 'hex', key = SECRET) => createHmac(alg, key).update(data).digest(enc);
const spec = (name) => validateSpec(PRESETS[name].spec);

test('every preset is a valid spec', () => {
  for (const [name, p] of Object.entries(PRESETS)) assert.doesNotThrow(() => validateSpec(p.spec), name);
});

test('Monnify: HMAC-SHA512 of body, major units', () => {
  const body = { eventType: 'SUCCESSFUL_TRANSACTION', eventData: { paymentReference: 'MNFY-1', transactionReference: 'T1', amountPaid: 2500.5, paymentStatus: 'PAID', currency: 'NGN', customer: { email: 'a@b.ng', name: 'Ada Obi' }, paidOn: new Date().toISOString() } };
  const raw = Buffer.from(JSON.stringify(body));
  assert.ok(verifySignature(spec('monnify'), SECRET, { 'monnify-signature': hmac('sha512', raw) }, raw));
  assert.ok(!verifySignature(spec('monnify'), SECRET, { 'monnify-signature': hmac('sha512', raw, 'hex', 'wrong-secret-xx') }, raw));
  const { payment } = extractPayment(spec('monnify'), body, 'NGN');
  assert.equal(payment.amount, 250050);
  assert.equal(payment.ref, 'MNFY-1');
  assert.equal(payment.firstName, 'Ada');
});

test('Korapay: signature covers only the data object', () => {
  const body = { event: 'charge.success', data: { reference: 'KPY-1', amount: 1000, currency: 'NGN', status: 'success' } };
  const raw = Buffer.from(JSON.stringify(body));
  assert.ok(verifySignature(spec('korapay'), SECRET, { 'x-korapay-signature': hmac('sha256', JSON.stringify(body.data)) }, raw));
  assert.ok(!verifySignature(spec('korapay'), SECRET, { 'x-korapay-signature': hmac('sha256', raw) }, raw));
  assert.equal(extractPayment(spec('korapay'), body, 'NGN').payment.amount, 100000);
});

test('Squad: uppercase hex signature accepted', () => {
  const body = { Event: 'charge_successful', Body: { transaction_ref: 'SQ-1', amount: 500000, transaction_status: 'Success', email: 'x@y.ng', currency: 'NGN' } };
  const raw = Buffer.from(JSON.stringify(body));
  assert.ok(verifySignature(spec('squad'), SECRET, { 'x-squad-encrypted-body': hmac('sha512', raw).toUpperCase() }, raw));
  assert.equal(extractPayment(spec('squad'), body, 'NGN').payment.amount, 500000);
});

test('Stripe: timestamped signature, stale timestamps rejected', () => {
  const body = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { payment_intent: 'pi_1', amount_total: 4200, currency: 'usd', payment_status: 'paid', customer_details: { email: 's@x.com' }, created: Math.floor(Date.now() / 1000) } } };
  const raw = Buffer.from(JSON.stringify(body));
  const t = Math.floor(Date.now() / 1000);
  const sig = (ts) => `t=${ts},v1=${hmac('sha256', Buffer.concat([Buffer.from(`${ts}.`), raw]))}`;
  assert.ok(verifySignature(spec('stripe'), SECRET, { 'stripe-signature': sig(t) }, raw));
  assert.ok(!verifySignature(spec('stripe'), SECRET, { 'stripe-signature': sig(t - 600) }, raw), 'replay of an old signed request');
  const p = extractPayment(spec('stripe'), body, 'NGN').payment;
  assert.equal(p.currency, 'USD');
  assert.equal(p.ref, 'pi_1');
});

test('custom gateway: any header, algorithm and field layout', () => {
  const custom = validateSpec({
    signatures: [{ scheme: 'hmac', header: 'X-Remita-Sig', algorithm: 'sha512', encoding: 'base64', signs: 'body' }],
    eventPath: 'notificationType', eventValues: 'PAYMENT_SUCCESS', statusPath: '', statusValues: '', amountUnit: 'major',
    fields: { ref: 'rrr', amount: 'payment.amt', email: 'payer.mail', time: 'paidAt' },
  });
  const body = { notificationType: 'PAYMENT_SUCCESS', rrr: '1234-5678', payment: { amt: '150.00' }, payer: { mail: 'p@q.ng' }, paidAt: Math.floor(Date.now() / 1000) };
  const raw = Buffer.from(JSON.stringify(body));
  assert.ok(verifySignature(custom, SECRET, { 'x-remita-sig': hmac('sha512', raw, 'base64') }, raw));
  const p = extractPayment(custom, body, 'NGN').payment;
  assert.equal(p.amount, 15000);
  assert.equal(p.email, 'p@q.ng');
  assert.equal(extractPayment(custom, { ...body, notificationType: 'REFUND' }, 'NGN').ignored, 'event type not tracked');
});

test('specs refuse unsigned webhooks and unsafe paths', () => {
  const base = PRESETS.custom.spec;
  assert.throws(() => validateSpec({ ...base, signatures: [] }), /signature check is required/);
  assert.throws(() => validateSpec({ ...base, fields: { amount: '__proto__.x', ref: 'r' } }), /dotted field names/);
  assert.throws(() => validateSpec({ ...base, fields: { amount: 'constructor', ref: 'r' } }), /dotted field names/);
  assert.throws(() => validateSpec({ ...base, signatures: [{ scheme: 'hmac', header: 'x', algorithm: 'md5', encoding: 'hex' }] }), /algorithm/);
  assert.throws(() => validateSpec({ ...base, fields: { ref: 'r' } }), /amount/);
  assert.equal(getPath({ a: { b: 1 } }, 'a.b'), 1);
  assert.equal(getPath({}, 'toString'), undefined, 'inherited properties are never read');
  assert.ok(!verifySignature(validateSpec(base), '', { 'x-signature': 'x' }, Buffer.from('{}')), 'no secret = never valid');
});

test('AI settings validation', () => {
  assert.deepEqual(validateAiSettings({ provider: 'anthropic', apiKey: 'k' }), { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k' });
  assert.throws(() => validateAiSettings({ provider: 'openai', model: 'x' }), /API key/);
  assert.throws(() => validateAiSettings({ provider: '__proto__', model: 'x' }), /choose an AI provider/);
  assert.throws(() => validateAiSettings({ provider: 'gemini', model: '../../etc', apiKey: 'k' }), /model name/);
  assert.throws(() => validateAiSettings({ provider: 'openai-compatible', model: 'llama', baseUrl: 'ftp://x' }), /base URL/);
  assert.equal(validateAiSettings({ provider: 'openai-compatible', model: 'llama-3', baseUrl: 'https://api.groq.com/openai/v1/' }).baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(aiFromEnv({}).provider, 'none');
  assert.equal(aiFromEnv({ RK_AI_PROVIDER: 'gemini', RK_AI_MODEL: 'gemini-x', RK_AI_API_KEY: 'k' }).provider, 'gemini');
});

test('SSRF: private and loopback base URLs are blocked unless allowed', async () => {
  const fakeDns = (map) => async (host) => map[host].map((address) => ({ address }));
  await assert.rejects(assertSafeUrl('https://127.0.0.1/v1', false), /private/);
  await assert.rejects(assertSafeUrl('https://[::1]/v1', false), /private/);
  await assert.rejects(assertSafeUrl('https://169.254.169.254/latest', false), /private/);
  await assert.rejects(assertSafeUrl('https://internal.example/v1', false, fakeDns({ 'internal.example': ['10.0.0.5'] })), /private/);
  await assert.rejects(assertSafeUrl('https://sneaky.example/v1', false, fakeDns({ 'sneaky.example': ['8.8.8.8', '192.168.1.1'] })), /private/);
  await assert.rejects(assertSafeUrl('http://api.example/v1', false, fakeDns({ 'api.example': ['8.8.8.8'] })), /https/);
  await assertSafeUrl('https://api.example/v1', false, fakeDns({ 'api.example': ['8.8.8.8'] }));
  await assertSafeUrl('http://localhost:11434/v1', true);
});

const prompt = { system: 'sys', user: 'user' };
const reply = { message: 'Hi {first_name}, your order is waiting.', tactic: 'reminder', send: true };
const fakeFetch = (calls, body) => async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return new Response(JSON.stringify(body)); };

test('OpenAI provider: strict JSON schema, bearer key', async () => {
  const calls = [];
  const out = await generateDraftJson({ provider: 'openai', model: 'gpt-test', apiKey: 'sk-1' }, prompt, { fetch: fakeFetch(calls, { choices: [{ message: { content: JSON.stringify(reply) } }] }) });
  assert.equal(out.message, reply.message);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-1');
  assert.equal(calls[0].body.response_format.type, 'json_schema');
  assert.equal(calls[0].body.model, 'gpt-test');
});

test('Gemini provider: API key header, JSON response schema', async () => {
  const calls = [];
  const out = await generateDraftJson({ provider: 'gemini', model: 'gemini-test', apiKey: 'g-1' }, prompt, { fetch: fakeFetch(calls, { candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(reply) + '\n```' }] } }] }) });
  assert.equal(out.send, true);
  assert.match(calls[0].url, /models\/gemini-test:generateContent$/);
  assert.equal(calls[0].headers['x-goog-api-key'], 'g-1');
  assert.equal(calls[0].body.generationConfig.responseSchema.additionalProperties, undefined);
});

test('OpenAI-compatible provider (Groq, Ollama...): custom base URL, SSRF-checked', async () => {
  const calls = [];
  const deps = { fetch: fakeFetch(calls, { choices: [{ message: { content: JSON.stringify(reply) } }] }), resolver: async () => [{ address: '8.8.8.8' }] };
  await generateDraftJson({ provider: 'openai-compatible', model: 'llama', apiKey: '', baseUrl: 'https://llm.example/v1' }, prompt, deps);
  assert.equal(calls[0].url, 'https://llm.example/v1/chat/completions');
  assert.equal(calls[0].body.response_format.type, 'json_object');
  assert.equal(calls[0].headers.Authorization, undefined);
  await assert.rejects(generateDraftJson({ provider: 'openai-compatible', model: 'llama', baseUrl: 'https://llm.example/v1' }, prompt, { ...deps, resolver: async () => [{ address: '127.0.0.1' }] }), /private/);
});

test('Anthropic provider: official SDK path with fallbacks only on supported models', async () => {
  const reqs = [];
  const client = { messages: { create: async (r) => { reqs.push(['std', r]); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] }; } },
    beta: { messages: { create: async (r) => { reqs.push(['beta', r]); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] }; } } } };
  const deps = { anthropicFactory: () => client };
  await generateDraftJson({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k' }, prompt, deps);
  await generateDraftJson({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' }, prompt, deps);
  assert.equal(reqs[0][0], 'beta');
  assert.equal(reqs[0][1].fallbacks, 'default');
  assert.deepEqual(reqs[0][1].thinking, { type: 'adaptive' });
  assert.equal(reqs[1][0], 'std');
  assert.equal(reqs[1][1].thinking, undefined, 'older models get no adaptive thinking');
});

test('drafter falls back to templates when the model fails, and test() reports the error', async () => {
  const logs = [];
  const drafter = createDrafter({
    resolveAi: () => ({ provider: 'openai', model: 'm', apiKey: 'k' }),
    fetch: async () => new Response('{"error":"bad key"}', { status: 401 }), logger: { warn: (m) => logs.push(m) },
  });
  const d = await drafter.draft({ lead: { stage: 'browsed', leadType: 'never_bought', journey: [] }, project: { name: 'X', payment_link: '' }, channel: 'sms', contact: { firstName: 'Ada' } });
  assert.equal(d.draftedBy, 'template');
  assert.match(d.body, /^Hi Ada,/);
  assert.ok(logs.some((l) => /401/.test(l)) && !logs.some((l) => /\bk\b.*bearer/i.test(l)));
  const t = await drafter.test({ name: 'X' }, { provider: 'openai', model: 'm', apiKey: 'k' });
  assert.equal(t.ok, false);
  assert.match(t.error, /401/);
});

test('AI base URL: a pasted full endpoint is trimmed to the base', async () => {
  const { validateAiSettings } = await import('../src/ai.js');
  const v = validateAiSettings({ provider: 'openai-compatible', model: 'llama-3.3-70b-versatile', apiKey: 'gsk_x', baseUrl: 'https://api.groq.com/openai/v1/chat/completions/' });
  assert.equal(v.baseUrl, 'https://api.groq.com/openai/v1');
});
