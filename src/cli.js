// Admin CLI.
//   npm run cli -- init [--public-url=https://…]         write .env with a fresh master key
//   npm run cli -- create-project "My VTU" deposits      create a project (sales|deposits)
//   npm run cli -- create-user <projectId> <email>       create a dashboard login (prompts for password)
//   npm run cli -- make-admin <email>                    let this login open the Admin pages (add businesses)
//   npm run cli -- reset-link <email>                    print a one-hour password reset link
//   npm run cli -- tick                                  background work: drafts, sending, emails, backups (cron, every 15 min)
//   npm run cli -- send <projectId>                      send approved messages now
// node:sqlite prints an "experimental" warning on every run; it's expected, so keep cron logs clean.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w?.message || w).includes('SQLite is an experimental') ? undefined : emitWarning.call(process, w, ...rest));
import { writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { loadDotEnv, readConfig } from './config.js';
import { createApp } from './server.js';

const [cmd, ...args] = process.argv.slice(2);

function askHidden(q) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

if (cmd === 'init') {
  if (existsSync('.env')) { console.error('.env already exists; not overwriting it.'); process.exit(1); }
  // --public-url=https://recover.example.com for a server behind HTTPS (cPanel, a VPS, Render…)
  const pub = (args.find((a) => a.startsWith('--public-url=')) || '').slice(13).replace(/\/+$/, '');
  if (pub && !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(pub)) { console.error('--public-url must look like https://recover.example.com'); process.exit(1); }
  const lines = [
    `RK_MASTER_KEY=${randomBytes(32).toString('base64')}`,
    'PORT=8787',
    `RK_PUBLIC_URL=${pub || 'http://localhost:8787'}`,
    ...(pub.startsWith('https://') ? ['RK_TRUST_PROXY=1'] : []),
    '# ANTHROPIC_API_KEY=...',
    '# RK_MAIL_FROM=RecoverKit <no-reply@yourdomain.com>   (emails invites and password resets)',
  ];
  writeFileSync('.env', lines.join('\n') + '\n', { mode: 0o600 });
  console.log('Wrote .env (permissions 600). Back up RK_MASTER_KEY: without it, stored contacts and secrets cannot be decrypted.');
  process.exit(0);
}

loadDotEnv();
const config = readConfig();
const app = await createApp({ config });
try {
  if (cmd === 'create-project') {
    const [name, mode = 'sales'] = args;
    const p = app.projects.create({ name, gatewayMode: mode });
    console.log(`Project ${p.id}\n  public key: ${p.publicKey}\n  secret key: ${p.secretKey}\n(The secret key is shown once. Keep it on your server only.)`);
  } else if (cmd === 'create-user') {
    const [projectId, email] = args;
    if (!app.projects.byId(projectId)) throw new Error('unknown project id');
    const pw = process.env.RK_NEW_PASSWORD || await askHidden('Password (12+ characters): ');
    app.projects.createUser(projectId, email, pw);
    console.log('User created.');
  } else if (cmd === 'make-admin') {
    app.accounts.setAdmin(args[0]);
    console.log(`${args[0]} is now an admin. Sign in again to see Businesses in the sidebar.`);
  } else if (cmd === 'reset-link') {
    const u = app.accounts.byEmail(args[0]);
    if (!u) throw new Error('no user with that email');
    const token = app.accounts.issue(u.id, u.password_hash ? 'reset' : 'invite');
    app.projects.audit(u.project_id, 'cli', 'reset_link_created', u.email);
    console.log(`${config.publicUrl}/reset/${token}\n(Works once, for ${u.password_hash ? '1 hour' : '7 days'}.)`);
  } else if (cmd === 'tick') {
    const r = await app.scheduler.tick();
    console.log(new Date().toISOString(), JSON.stringify(r));
  } else if (cmd === 'send') {
    console.log(await app.outreach.sendApproved(args[0]));
  } else {
    console.log('commands: init | create-project <name> [sales|deposits] | create-user <projectId> <email> | make-admin <email> | reset-link <email> | tick | send <projectId>');
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exitCode = 1;
} finally {
  await app.close();
}
