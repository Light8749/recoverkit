// One-command connector install.
//   Dashboard  -> "Create install command": a one-time code (works once, for 60 minutes)
//   GET  /install.php          the installer, with this server's address built in
//   POST /v1/connector/claim   {code} -> this project's public key and a new secret key for the connector
// The developer never handles keys or edits .env: the code is the only thing they copy.
import { randomBytes } from 'node:crypto';
import { HttpError, send, readBody, parseJson, clientIp } from './http.js';
import { sha256Hex } from './crypto.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const CODE_MINUTES = 60;
const normalize = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function newCode() {
  const b = randomBytes(12);
  let s = '';
  for (const x of b) s += ALPHABET[x % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

export function createInstall({ db, config, projects, limiter }) {
  function createCode(projectId, actor) {
    const code = newCode();
    db.run('DELETE FROM install_codes WHERE expires_at < ? OR used_at IS NOT NULL', Date.now() - 864e5);
    db.run('INSERT INTO install_codes (code_hash, project_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?)',
      sha256Hex(normalize(code)), projectId, actor, Date.now(), Date.now() + CODE_MINUTES * 60e3);
    projects.audit(projectId, actor, 'install_code_created');
    return code;
  }

  const command = (code) => `curl -fsSLo recoverkit-install.php ${config.publicUrl}/install.php && php recoverkit-install.php ${code}`;

  async function claim(req, res) {
    const ip = clientIp(req, config.trustProxy);
    if (!limiter.hit(`claim-ip:${ip}`, 10, 15 * 60e3)) throw new HttpError(429, 'too many attempts, try again in 15 minutes');
    const body = parseJson(await readBody(req, 2048));
    const code = normalize(body.code);
    if (code.length !== 12) throw new HttpError(400, 'that install code looks wrong: copy it again from the Developers page');
    const now = Date.now();
    const hash = sha256Hex(code);
    // Claim atomically so a code can only ever be used once.
    const won = db.run('UPDATE install_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', now, hash, now).changes === 1;
    if (!won) throw new HttpError(401, 'this install code has expired or was already used: create a new one on the Developers page');
    const row = db.get('SELECT project_id FROM install_codes WHERE code_hash = ?', hash);
    const p = projects.byId(row.project_id);
    if (!p) throw new HttpError(401, 'this business no longer exists');
    const secretKey = projects.createSecretKey(p.id, 'connector (installed)');
    projects.audit(p.id, 'installer', 'connector_installed', ip);
    send(res, 200, { publicKey: p.public_key, secretKey, endpoint: config.publicUrl, projectName: p.name });
  }

  function installerScript() {
    const endpoint = JSON.stringify(config.publicUrl).replace(/'/g, "\\'");
    return `<?php
// RecoverKit installer: connects this app to RecoverKit in one step.
// In your app's folder:   php recoverkit-install.php <INSTALL-CODE>
// Get the code from the RecoverKit dashboard (Developers page). It works once, for ${CODE_MINUTES} minutes.
// It downloads the read-only connector, finds your database, shows what it found and asks before sending anything.
// MIT License. https://github.com/Light8749/recoverkit

$endpoint = json_decode('${endpoint}');
if (PHP_SAPI !== 'cli') { http_response_code(403); exit("Run this in a terminal: php recoverkit-install.php <code>\\n"); }
$fail = function ($m) { fwrite(STDERR, "Error: $m\\n"); exit(1); };
if (PHP_VERSION_ID < 70400) $fail('PHP 7.4 or newer is needed (this is ' . PHP_VERSION . ').');
foreach (['curl', 'json', 'pdo'] as $ext) if (!extension_loaded($ext)) $fail("the PHP extension '$ext' is missing.");
$code = '';
$extra = [];
foreach (array_slice($argv, 1) as $a) { if ($a !== '' && $a[0] !== '-' && $code === '') $code = $a; else $extra[] = $a; }
if ($code === '') $fail('give the install code from your RecoverKit dashboard: php recoverkit-install.php XXXX-XXXX-XXXX');

$tmp = rtrim(sys_get_temp_dir(), '/') . '/recoverkit-' . bin2hex(random_bytes(6));
if (!@mkdir($tmp, 0700)) $fail("could not create $tmp");
$self = __FILE__;
register_shutdown_function(function () use ($tmp, $self) {
    foreach (glob("$tmp/*") ?: [] as $f) @unlink($f);
    @rmdir($tmp);
    @unlink($self); // the installer removes itself from your app folder
});
foreach (['RecoverKit.php', 'recoverkit-detect.php', 'recoverkit-connector.php'] as $f) {
    $ch = curl_init("$endpoint/sdk/php/$f");
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 30, CURLOPT_SSL_VERIFYPEER => true]);
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($status !== 200 || !is_string($body) || strpos($body, '<?php') !== 0) $fail("could not download $f from $endpoint (HTTP $status)");
    file_put_contents("$tmp/$f", $body);
}
$app = getcwd();
foreach ($extra as $a) if (strpos($a, '--app=') === 0) $app = substr($a, 6);
$argv = array_merge(['recoverkit-connector.php', 'install', '--code=' . $code, '--endpoint=' . $endpoint, '--app=' . $app],
    array_values(array_filter($extra, fn($a) => strpos($a, '--app=') !== 0)));
define('RECOVERKIT_CONNECTOR_CLI', true);
require "$tmp/recoverkit-connector.php";
`;
  }

  return { createCode, command, claim, installerScript };
}
