// Bundles the browser SDK into one plain <script> file (no build tools needed).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['sdk/core/sha256.js', 'sdk/core/identity.js', 'sdk/core/client.js', 'sdk/browser/recoverkit.js'];

export function buildBrowserBundle() {
  const parts = FILES.map((f) => {
    const src = readFileSync(join(root, f), 'utf8')
      .replace(/^import .*?;\s*$/gm, '')
      .replace(/^export \{[^}]*\}( from .*)?;\s*$/gm, '')
      .replace(/^export (const|function|let|class|async function) /gm, '$1 ');
    return `// ---- ${f} ----\n${src}`;
  });
  return `/*! RecoverKit browser SDK. MIT License, Copyright (c) 2026 Light8749. https://github.com/Light8749/recoverkit */\n(function () {\n'use strict';\n${parts.join('\n')}\n})();\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist/recoverkit.js'), buildBrowserBundle());
  console.log('wrote dist/recoverkit.js');
}
