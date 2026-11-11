// The connector must hash exactly like every other RecoverKit SDK, so it ships a copy of the
// shared identity code. This copies it in before testing and before packing for npm.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, '../lib'), { recursive: true });
for (const f of ['identity.js', 'sha256.js']) copyFileSync(join(here, '../../core', f), join(here, '../lib', f));
