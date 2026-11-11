// Builds dist/recoverkit-cpanel.zip: only what the server needs, ready to upload to cPanel.
//   node scripts/package-cpanel.mjs
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/cpanel');
const app = join(out, 'recoverkit');
rmSync(out, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

for (const dir of ['src', 'sdk/core', 'sdk/browser', 'sdk/php', 'assets/brand']) cpSync(join(root, dir), join(app, dir), { recursive: true });
mkdirSync(join(app, 'scripts'), { recursive: true });
for (const f of ['build-browser.js', 'build-brand.js']) copyFileSync(join(root, 'scripts', f), join(app, 'scripts', f));
for (const f of ['app.cjs', 'LICENSE']) copyFileSync(join(root, f), join(app, f));
copyFileSync(join(root, 'deploy/CPANEL.md'), join(app, 'DEPLOY.md'));
copyFileSync(join(root, 'sdk/LICENSE'), join(app, 'sdk/LICENSE'));

// Only runtime dependencies: cPanel's "Run NPM Install" also installs devDependencies otherwise.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(join(app, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, private: true, license: pkg.license, type: 'module',
  engines: pkg.engines, main: 'app.cjs',
  scripts: { start: 'node src/server.js', cli: 'node src/cli.js' },
  dependencies: pkg.dependencies,
}, null, 2) + '\n');

execFileSync('zip', ['-qr', '../recoverkit-cpanel.zip', 'recoverkit', '-x', '*.DS_Store'], { cwd: out });
console.log('wrote dist/recoverkit-cpanel.zip');
