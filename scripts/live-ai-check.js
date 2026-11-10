// One real call to YOUR AI model for each thing RecoverKit asks it to do, so you know it works
// before customers rely on it. Costs a few kobo. Nothing about any real customer is sent.
//
//   ANTHROPIC_API_KEY=sk-ant-...  npm run check:ai
//   RK_AI_PROVIDER=openai RK_AI_MODEL=<model> RK_AI_API_KEY=sk-...  npm run check:ai
//   RK_AI_PROVIDER=gemini | openai-compatible (+ RK_AI_BASE_URL) work the same way.
import { loadDotEnv } from '../src/config.js';
import { aiFromEnv, createDrafter, generateJson } from '../src/ai.js';
import { suggestPrompt, validateMapping, cleanSchemaInput } from '../src/connector.js';

loadDotEnv();
const settings = aiFromEnv(process.env);
if (settings.provider === 'none') {
  console.log('No AI model configured. Set ANTHROPIC_API_KEY, or RK_AI_PROVIDER + RK_AI_MODEL + RK_AI_API_KEY, then run: npm run check:ai');
  process.exit(2);
}
let anthropicFactory;
if (settings.provider === 'anthropic') {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  anthropicFactory = (apiKey) => new Anthropic({ ...(apiKey ? { apiKey } : {}), timeout: 90_000, maxRetries: 2 });
}
const deps = { fetch: globalThis.fetch, anthropicFactory, allowPrivateAiUrls: process.env.RK_ALLOW_PRIVATE_AI_URLS === '1' };
console.log(`Checking ${settings.provider} · ${settings.model}\n`);
let failed = 0;
const check = (ok, label, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `\n    ${detail}` : ''}`); if (!ok) failed++; };

// 1. A follow-up draft.
const drafter = createDrafter({ resolveAi: () => settings, logger: { warn() {} }, ...deps });
const draft = await drafter.test({ name: 'Ada Data & Airtime', voice_profile: 'Friendly Lagos tone. Small Pidgin is fine.' }, settings);
check(draft.ok, 'Writes a safe follow-up draft', draft.ok ? `"${draft.message}"` : draft.error);

// 2. A database mapping from names only (the same sample VTU schema the tests use).
const tables = cleanSchemaInput({ tables: [
  { name: 'users', rows: 12403, columns: [{ name: 'id', type: 'bigint' }, { name: 'fullname', type: 'varchar' }, { name: 'email', type: 'varchar' }, { name: 'phone', type: 'varchar' }, { name: 'password', type: 'varchar' }, { name: 'created_at', type: 'datetime' }] },
  { name: 'wallet_fundings', rows: 8210, columns: [{ name: 'id', type: 'bigint' }, { name: 'user_id', type: 'bigint' }, { name: 'amount', type: 'decimal' }, { name: 'status', type: 'varchar' }, { name: 'created_at', type: 'datetime' }], values: { status: ['success', 'failed', 'pending'] } },
  { name: 'transactions', rows: 54000, columns: [{ name: 'id', type: 'bigint' }, { name: 'user_id', type: 'bigint' }, { name: 'service', type: 'enum' }, { name: 'amount', type: 'decimal' }, { name: 'status', type: 'enum' }, { name: 'reference', type: 'varchar' }, { name: 'created_at', type: 'timestamp' }],
    values: { service: ['data', 'airtime', 'wallet_credit', 'electricity'], status: ['pending', 'successful', 'failed'] } },
] });
try {
  const m = validateMapping(await generateJson(settings, suggestPrompt(tables, 'mysql'), deps), tables);
  check(m.people.table === 'users' && m.people.email === 'email', 'Finds the users table and email column', JSON.stringify(m.people));
  const sale = m.conversions.find((c) => c.table === 'transactions');
  const svc = sale?.filters.find((f) => f.column === 'service')?.values || [];
  const st = sale?.filters.find((f) => f.column === 'status')?.values || [];
  check(Boolean(sale) && st.includes('successful') && !st.includes('failed'), 'A sale is a successful transaction', JSON.stringify(sale?.filters));
  check(svc.includes('data') && svc.includes('airtime') && !svc.includes('wallet_credit'), 'Wallet credits are NOT counted as sales', `service filter: ${JSON.stringify(svc)}`);
  check(m.signals.some((x) => x.table === 'wallet_fundings' && x.kind === 'deposit'), 'Wallet fundings are a deposit signal', JSON.stringify(m.signals.map((x) => `${x.table}:${x.kind}`)));
} catch (e) {
  check(false, 'Suggests a database mapping', String(e.message || e));
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
