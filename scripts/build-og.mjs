// Builds assets/brand/og.png (1200x630), the link-preview image for WhatsApp, X, LinkedIn and Google.
// Needs Google Chrome (or set CHROME=/path/to/chrome).   node scripts/build-og.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const svg = readFileSync(join(root, 'assets/brand/kobo.svg'), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:1200px;height:630px;overflow:hidden}
body{background:linear-gradient(135deg,#eef3ff 0%,#fff 55%,#e9f9f0 100%);font-family:-apple-system,"SF Pro Display","Helvetica Neue",Arial,sans-serif;display:flex;align-items:center;padding:0 80px;box-sizing:border-box;gap:40px}
.t{flex:1}.b{display:flex;align-items:center;gap:14px;font-size:34px;font-weight:700;color:#111;margin-bottom:34px}
.dot{width:14px;height:14px;border-radius:50%;background:#007aff}
h1{font-size:66px;line-height:1.04;letter-spacing:-2px;margin:0 0 26px;color:#000}
p{font-size:29px;color:#3c3c43;margin:0;line-height:1.3}
.k{width:400px;height:400px;flex:none}.k svg{width:100%;height:100%}
.pill{display:inline-block;margin-top:30px;padding:10px 22px;border-radius:999px;background:#007aff;color:#fff;font-size:26px;font-weight:600}
</style></head><body><div class="t"><div class="b"><span class="dot"></span>RecoverKit</div>
<h1>Win back customers who signed up and never bought.</h1>
<p>AI follow-ups by WhatsApp, SMS and email, in your voice. Built for Nigerian VTU, fintech and online stores.</p>
<span class="pill">Free for every business · no card needed</span></div>
<div class="k">${svg}</div></body></html>`;
const dir = mkdtempSync(join(tmpdir(), 'rk-og-'));
writeFileSync(join(dir, 'og.html'), html);
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1200,630', `--screenshot=${join(root, 'assets/brand/og.png')}`, `file://${join(dir, 'og.html')}`], { stdio: 'ignore' });
rmSync(dir, { recursive: true, force: true });
console.log('wrote assets/brand/og.png');
