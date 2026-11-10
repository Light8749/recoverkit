// Admin CLI.
//   npm run cli -- init                                  write .env with a fresh master key
//   npm run cli -- create-project "My VTU" deposits      create a project (sales|deposits)
//   npm run cli -- create-user <projectId> <email>       create a dashboard login (prompts for password)
//   npm run cli -- send <projectId>                      send approved messages (for cron)
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
  writeFileSync('.env', `RK_MASTER_KEY=${randomBytes(32).toString('base64')}\nPORT=8787\nRK_PUBLIC_URL=http://localhost:8787\n# ANTHROPIC_API_KEY=...\n`, { mode: 0o600 });
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
  } else if (cmd === 'send') {
    console.log(await app.outreach.sendApproved(args[0]));
  } else {
    console.log('commands: init | create-project <name> [sales|deposits] | create-user <projectId> <email> | send <projectId>');
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exitCode = 1;
} finally {
  await app.close();
}
