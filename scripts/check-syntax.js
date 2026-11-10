// Syntax-checks every JS file, including the built browser bundle.
import { readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildBrowserBundle } from './build-browser.js';

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    if (f === 'node_modules' || f.startsWith('.')) continue;
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
  }
};
for (const d of ['src', 'sdk', 'scripts', 'test']) walk(d);
const bundle = join(mkdtempSync(join(tmpdir(), 'rk-')), 'bundle.cjs');
writeFileSync(bundle, buildBrowserBundle());
for (const f of [...files, bundle]) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log(`syntax ok: ${files.length + 1} files`);
