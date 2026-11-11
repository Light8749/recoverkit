// Files a business's developer downloads straight from this server, so nobody needs the
// RecoverKit source or GitHub: the PHP SDK and connector (one by one, or as a zip).
import { readFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PHP_FILES = ['RecoverKit.php', 'recoverkit-connector.php', 'recoverkit-detect.php'];

const README = `RecoverKit for PHP
==================

RecoverKit.php            server SDK: identify customers and record real sales
recoverkit-connector.php  read-only connector: brings in your past customers
recoverkit-detect.php     used by the connector to find your database login

Put this folder on your server OUTSIDE public_html (for example /home/you/recoverkit-php),
so nobody can open these files from the web.

Your RecoverKit dashboard has a Developers page with every command filled in for your
business. The short version:

  export RK_PUBLIC_KEY=rk_pub_...
  export RK_SECRET_KEY=rk_sec_...         # keep this secret
  export RK_ENDPOINT=https://your-recoverkit-server
  php recoverkit-connector.php setup --app=/path/to/your/app
  php recoverkit-connector.php sync

The connector only reads. Every query it runs is written to recoverkit-connector.log
next to it, and only hashes, dates and amounts are sent.

MIT License. See LICENSE.
`;

/** A minimal ZIP writer (deflate, no dependencies). entries: [{ name, data: Buffer }] */
export function makeZip(entries, date = new Date('2026-01-01T00:00:00Z')) {
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const locals = []; const centrals = []; let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(dosTime, 10); head.writeUInt16LE(dosDate, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    locals.push(head, nameBuf, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(0x031e, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10); cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38); cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);
    offset += head.length + nameBuf.length + packed.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

/** Everything is read once at start-up: requests can only ever get these exact bytes. */
export function loadDownloads() {
  const php = Object.fromEntries(PHP_FILES.map((f) => [f, readFileSync(join(root, 'sdk/php', f))]));
  const license = readFileSync(join(root, 'sdk/LICENSE'));
  const zip = makeZip([
    ...PHP_FILES.map((f) => ({ name: `recoverkit-php/${f}`, data: php[f] })),
    { name: 'recoverkit-php/LICENSE', data: license },
    { name: 'recoverkit-php/README.txt', data: Buffer.from(README) },
  ]);
  return { php, zip, license };
}
