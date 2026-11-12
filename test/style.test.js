// A business's own messaging psychology: saved per customer type, sent to the AI only for that type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateStyle, splitExamples, stylePrompt, parseStyle } from '../src/style.js';
import { buildPrompt, createDrafter, SAMPLE_LEADS } from '../src/ai.js';
import { createApp } from '../src/server.js';

test('examples are split by blank lines, limited, and cleaned', () => {
  assert.deepEqual(splitExamples('Hi {first_name}, one.\n\nHey, two?\r\n\r\n\n\nok'), ['Hi {first_name}, one.', 'Hey, two?']);
  assert.equal(splitExamples(Array.from({ length: 9 }, (_, i) => `Example number ${i}`).join('\n\n')).length, 5);
  assert.throws(() => validateStyle({ examples_registered: 'Visit https://padi.ng now' }), /leave links out/);
  assert.throws(() => validateStyle({ examples_bought_once: 'Call 0803 123 4567 today' }), /phone numbers/);
  const s = validateStyle({ playbook: 'Always ask one question.\u0007', rules_funded_not_bought: 'Mention the amount.', examples_funded_not_bought: 'Hi {first_name}, your ₦2,000 is safe. What were you trying to buy?' });
  assert.equal(s.playbook, 'Always ask one question.');
  assert.deepEqual(Object.keys(s.stages), ['funded_not_bought'], 'empty types are not stored');
});

test('the AI sees the playbook always, and only the rules and examples for this customer\'s type', () => {
  const style = validateStyle({
    playbook: 'Sign as Moses. Never say kindly.',
    rules_funded_not_bought: 'Reassure the money is safe.', examples_funded_not_bought: 'Hi {first_name}, your money dey safe. What did you want to buy?\n\nHey {first_name}, quick one: did the data purchase fail?',
    rules_bought_once: 'Thank them first.', examples_bought_once: 'Thanks for your last order {first_name}! Same again?',
  });
  const project = { name: 'Padi', voice_profile: 'Friendly', style_json: JSON.stringify(style) };
  const funded = buildPrompt({ lead: SAMPLE_LEADS.funded_not_bought, project, channel: 'whatsapp' }).system;
  assert.match(funded, /<business_playbook>\nSign as Moses\. Never say kindly\.\n<\/business_playbook>/);
  assert.match(funded, /Reassure the money is safe/);
  assert.match(funded, /<example n="2">\nHey \{first_name\}, quick one: did the data purchase fail\?/);
  assert.ok(!/Thank them first/.test(funded), 'another type\'s rules are not included');
  assert.match(funded, /the business wins/);
  assert.match(funded, /never inventing facts, discounts or deadlines, no links or phone numbers, and no pressure or guilt still always apply/);
  const registered = buildPrompt({ lead: SAMPLE_LEADS.registered, project, channel: 'whatsapp' }).system;
  assert.match(registered, /Sign as Moses/);
  assert.ok(!/<example/.test(registered), 'no examples for a type without any');
  assert.equal(stylePrompt(parseStyle(''), 'registered'), '', 'no style, nothing added');
});

test('preview: the model is asked with the business style for the chosen type', async () => {
  let sent = null;
  const fakeAnthropic = { beta: { messages: { create: async (req) => { sent = req; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ message: 'Hi {first_name}, thanks for your last order. Same again?', tactic: 'check_in', send: true }) }] }; } } } };
  const d = createDrafter({ resolveAi: () => null, logger: { warn() {} }, anthropicFactory: () => fakeAnthropic });
  const project = { name: 'Padi', voice_profile: '', style_json: JSON.stringify(validateStyle({ rules_bought_once: 'Thank them first.' })) };
  const r = await d.test(project, { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-x' }, 'bought_once');
  assert.deepEqual(r, { ok: true, message: 'Hi Ada, thanks for your last order. Same again?' });
  assert.match(JSON.stringify(sent), /Thank them first/);
  assert.match(JSON.stringify(sent), /bought_once/);
});

test('Message style page: save, show again, preview', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-style-'));
  const config = { masterKey: randomBytes(32), port: 0, host: '127.0.0.1', dbPath: join(dir, 't.db'), publicUrl: 'http://127.0.0.1', trustProxy: false, ai: { provider: 'none' }, attributionDays: 7, feePercent: 0, minDaysBetweenMessages: 7, scheduler: false };
  const app = await createApp({ config, logger: { log() {}, warn() {}, error() {} } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  config.publicUrl = base;
  const p = app.projects.create({ name: 'Padi' });
  app.projects.createUser(p.id, 'owner@padi.ng', 'owner-password-long-1');
  const cookie = (await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'owner@padi.ng', password: 'owner-password-long-1' }) })).headers.get('set-cookie').split(';')[0];
  const get = (path) => fetch(base + path, { headers: { Cookie: cookie } });
  const post = (path, body) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const html = await (await get('/dashboard/style')).text();
  assert.match(html, /Funded their wallet, never bought/);
  assert.ok(!/style="/.test(html) && !/<script/i.test(html));
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)[1];
  const r = await post('/dashboard/style', { _csrf: csrf, playbook: 'Ask one question.', rules_registered: 'Offer a walkthrough.', examples_registered: 'Hi {first_name}, want me to show you how it works?\n\nHey {first_name}, what brought you to us?' });
  assert.match(decodeURIComponent(r.headers.get('location')), /ok=Saved/);
  const saved = parseStyle(app.projects.byId(p.id).style_json);
  assert.equal(saved.stages.registered.examples.length, 2);
  assert.match(await (await get('/dashboard/style')).text(), /what brought you to us\?/);
  assert.match(decodeURIComponent((await post('/dashboard/style', { _csrf: csrf, examples_browsed: 'see www.padi.ng' })).headers.get('location')), /err=Browsed, never bought: leave links out/);
  const preview = await (await post('/dashboard/style/test', { _csrf: csrf, stage: 'registered' })).text();
  assert.match(preview, /Sample for "Signed up, never did anything":<\/b><br>Hi Ada/);
});
