// Builds standalone brand files from the one mascot source (src/dashboard/mascot.js + the
// KOBO block in app.css), so the logo files and the dashboard can never drift apart.
//   node scripts/build-brand.js   -> assets/brand/{kobo.svg, kobo-mark.svg, kobo-animated.svg, kobo-app-icon.svg, index.html}
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { kobo } from '../src/dashboard/mascot.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function koboCss() {
  const css = readFileSync(join(root, 'src/dashboard/app.css'), 'utf8');
  const m = /\/\* =+ KOBO START[\s\S]*?KOBO END =+ \*\//.exec(css);
  if (!m) throw new Error('KOBO block missing from app.css');
  return m[0];
}

/** A self-contained SVG file (with its own <style>) for one mode. */
export function brandSvg(mode, { size = 512, background = false } = {}) {
  let svg = kobo({ mode, size, title: 'Kobo, the RecoverKit pigeon' })
    .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  if (background) {
    // App-icon style: Kobo on a rounded blue square.
    svg = svg.replace(/viewBox="[^"]+"/, 'viewBox="-6 -4 130 130"')
      .replace(/(<svg[^>]*>)/, '$1<rect x="-6" y="-4" width="130" height="130" rx="29" fill="#e9f0ff"/>');
  }
  return svg.replace('</svg>', `<style>${koboCss()}</style></svg>`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const out = join(root, 'assets/brand');
  mkdirSync(out, { recursive: true });
  const files = {
    'kobo.svg': brandSvg('still'),
    'kobo-mark.svg': brandSvg('mark'),
    'kobo-animated.svg': brandSvg('hero'),
    'kobo-app-icon.svg': brandSvg('still', { background: true }),
  };
  for (const [name, svg] of Object.entries(files)) writeFileSync(join(out, name), svg);
  writeFileSync(join(out, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Kobo · RecoverKit brand</title><style>
:root{color-scheme:light dark;--bg:#f2f2f7;--card:#fff;--fg:#000;--muted:rgba(60,60,67,.6)}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#fff;--muted:rgba(235,235,245,.6)}}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.45 -apple-system,"SF Pro Text",system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px}h1{font-size:34px;margin:0}p{color:var(--muted);max-width:62ch}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-top:24px}
figure{margin:0;background:var(--card);border-radius:16px;padding:20px;text-align:center}figure img{width:100%;max-width:220px;height:auto}
figcaption{font-size:14px;color:var(--muted);margin-top:8px}.hero{max-width:340px}</style></head><body><main>
<h1>Meet Kobo</h1>
<p>Kobo is a homing pigeon. Homing pigeons always find their way back and carry messages, which is what RecoverKit does for the customers a business is losing. Every kobo counts.</p>
<div class="grid">
<figure><img class="hero" src="kobo-animated.svg" alt="Kobo crouches, flies a boomerang loop, lands and pops a naira coin out of his satchel"><figcaption>Animated logo (6 s loop)</figcaption></figure>
<figure><img src="kobo-mark.svg" alt="Kobo blinking"><figcaption>Logo mark (idle blink and head bob)</figcaption></figure>
<figure><img src="kobo.svg" alt="Kobo"><figcaption>Static logo</figcaption></figure>
<figure><img src="kobo-app-icon.svg" alt="Kobo app icon"><figcaption>App icon</figcaption></figure>
</div>
<p>The animation follows Disney's 12 principles: anticipation (the crouch), arcs (the boomerang flight out and back), squash and stretch (take-off and landing), follow-through (the tail lags the turns), secondary action (wing flaps, the pigeon head-bob, blinks), and a long rest so it never nags. It stops for people who turn on Reduce Motion.</p>
</main></body></html>`);
  console.log(`wrote ${Object.keys(files).length + 1} files to assets/brand/`);
}
