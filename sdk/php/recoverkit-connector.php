<?php
/**
 * RecoverKit Connector: a read-only helper that runs on YOUR server.
 *
 * It reads your database where it lives (your data is never exported), works out
 * who signed up, who bought and who went quiet, scrambles emails and phone numbers
 * into one-way hashes, and sends RecoverKit only those hashes, event types, dates
 * and amounts. It only calls out: nothing on the internet can call in.
 *
 *   php recoverkit-connector.php setup      look at your tables, suggest a mapping, dry run, save it
 *   php recoverkit-connector.php sync       send history the first time, then only what's new
 *   php recoverkit-connector.php status     show the saved mapping and the last sync
 *
 * Cron (every 15 minutes):
 *   * /15 * * * *  php /path/to/recoverkit-connector.php sync >> /path/to/recoverkit-sync.out 2>&1
 *
 * Settings come from environment variables, or from your app's own config with --app=/path/to/app
 * (Laravel, WordPress/WooCommerce, Django, Rails, Prisma/Node, Spring Boot, ASP.NET, any .env with DATABASE_URL):
 *   RK_PUBLIC_KEY, RK_SECRET_KEY, RK_ENDPOINT
 *   RK_DB_DSN (e.g. mysql:host=127.0.0.1;dbname=shop), RK_DB_USER, RK_DB_PASS
 *   RK_TIMEZONE (default Africa/Lagos), RK_HISTORY_DAYS (default 730)
 *
 * Requires PHP 7.4+ with PDO (pdo_mysql, pdo_pgsql or pdo_sqlite) and curl.
 */

declare(strict_types=1);

require_once __DIR__ . '/RecoverKit.php';
require_once __DIR__ . '/recoverkit-detect.php';

final class RecoverKitConnector
{
    public const VERSION = '1.0.0';
    private const NAME_RE = '/^[A-Za-z_][A-Za-z0-9_$]{0,63}$/';
    private const META_KEY_RE = '/^[A-Za-z0-9_-]{1,64}$/';
    private const PAGE = 1000;
    private const BATCH = 400;

    /** @var array<string,string> */
    private array $env;
    private string $dir;
    private bool $assumeYes;
    private ?PDO $pdo = null;
    private string $driver = '';
    private ?RecoverKit $hasher = null;
    /** @var resource|null */
    private $log = null;

    public function __construct(array $env, string $dir, bool $assumeYes)
    {
        $this->env = $env;
        $this->dir = $dir;
        $this->assumeYes = $assumeYes;
        date_default_timezone_set($env['RK_TIMEZONE'] ?? 'Africa/Lagos');
    }

    // ------------------------------------------------------------------ helpers

    private function say(string $s = ''): void { fwrite(STDOUT, $s . PHP_EOL); }
    private function fail(string $s): void { fwrite(STDERR, 'Error: ' . $s . PHP_EOL); exit(1); }

    private function ask(string $q, bool $default = true): bool
    {
        if ($this->assumeYes) {
            $this->say($q . ($default ? ' [Y/n] y (--yes)' : ' [y/N] n (--yes)'));
            return $default;
        }
        if (function_exists('posix_isatty') && !@posix_isatty(STDIN)) $this->fail('setup asks questions: run it in a terminal, or pass --yes to accept the suggested answers');
        fwrite(STDOUT, $q . ($default ? ' [Y/n] ' : ' [y/N] '));
        $a = strtolower(trim((string)fgets(STDIN)));
        return $a === '' ? $default : in_array($a, ['y', 'yes'], true);
    }

    private function path(string $file): string { return $this->dir . DIRECTORY_SEPARATOR . $file; }

    /** Every query is written to a local log the business can read. */
    private function logQuery(string $sql, array $params, int $rows): void
    {
        if ($this->log === null) $this->log = fopen($this->path('recoverkit-connector.log'), 'ab');
        // Filter values and dates are logged; ID lists (which could be emails on some schemas) only as a count.
        $shown = count($params) > 10 ? ['(' . count($params) . ' ids)'] : array_map(fn($p) => is_string($p) && (strlen($p) > 40 || strpos($p, '@') !== false) ? '(hidden)' : $p, $params);
        fwrite($this->log, sprintf("%s rows=%d %s params=%s\n", date('c'), $rows, preg_replace('/\s+/', ' ', $sql), json_encode($shown)));
    }

    private function hasher(): RecoverKit
    {
        if ($this->hasher === null) {
            $this->hasher = new RecoverKit($this->need('RK_PUBLIC_KEY'), $this->need('RK_SECRET_KEY'), $this->endpoint());
        }
        return $this->hasher;
    }

    private function need(string $k): string
    {
        $v = $this->env[$k] ?? '';
        if ($v === '') $this->fail("$k is not set");
        return $v;
    }

    private function endpoint(): string { return rtrim($this->env['RK_ENDPOINT'] ?? 'https://api.recoverkit.app', '/'); }

    // ------------------------------------------------------------------ database (read-only)

    private function connect(): void
    {
        if ($this->pdo) return;
        $dsn = $this->need('RK_DB_DSN');
        $this->driver = strtolower(substr($dsn, 0, (int)strpos($dsn, ':')));
        if (!in_array($this->driver, ['mysql', 'pgsql', 'sqlite'], true)) $this->fail('RK_DB_DSN must start with mysql:, pgsql: or sqlite:');
        $opts = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false];
        if ($this->driver === 'sqlite' && defined('PDO::SQLITE_ATTR_OPEN_FLAGS')) $opts[PDO::SQLITE_ATTR_OPEN_FLAGS] = PDO::SQLITE_OPEN_READONLY;
        try {
            $this->pdo = new PDO($dsn, $this->env['RK_DB_USER'] ?? null, $this->env['RK_DB_PASS'] ?? null, $opts);
        } catch (PDOException $e) {
            $this->fail('could not connect to the database: ' . $e->getMessage());
        }
        // Belt and braces: even if the login could write, this session cannot.
        if ($this->driver === 'mysql') $this->pdo->exec('SET SESSION TRANSACTION READ ONLY');
        if ($this->driver === 'pgsql') $this->pdo->exec('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
        if ($this->driver === 'sqlite') $this->pdo->exec('PRAGMA query_only = ON');
    }

    /** Warn if the database login could write, and show how to make a read-only one. */
    private function checkReadOnly(array $tables): void
    {
        $writes = false;
        try {
            if ($this->driver === 'mysql') {
                foreach ($this->pdo->query('SHOW GRANTS FOR CURRENT_USER()')->fetchAll(PDO::FETCH_COLUMN) as $g) {
                    if (preg_match('/\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i', (string)$g)) $writes = true;
                }
            } elseif ($this->driver === 'pgsql') {
                foreach (array_slice($tables, 0, 50) as $t) {
                    $st = $this->pdo->prepare("SELECT has_table_privilege(current_user, ?, 'INSERT') OR has_table_privilege(current_user, ?, 'UPDATE') OR has_table_privilege(current_user, ?, 'DELETE')");
                    $st->execute([$t['name'], $t['name'], $t['name']]);
                    if ($st->fetchColumn()) $writes = true;
                }
            }
        } catch (Throwable $e) { /* can't tell: say so below */ }
        if (!$writes) {
            $this->say('✓ Read-only session' . ($this->driver === 'sqlite' ? ' (file opened read-only)' : '') . '.');
            return;
        }
        $this->say('⚠ This database login can also WRITE. The connector itself only reads (and the session is set to read-only),');
        $this->say('  but for safety create a separate read-only login and use that instead:');
        if ($this->driver === 'mysql') {
            $this->say("    CREATE USER 'recoverkit'@'localhost' IDENTIFIED BY '<a long random password>';");
            $this->say("    GRANT SELECT ON <your_database>.* TO 'recoverkit'@'localhost';");
            $this->say('  (Or grant SELECT only on the tables listed below for even less access.)');
        } else {
            $this->say("    CREATE ROLE recoverkit LOGIN PASSWORD '<a long random password>';");
            $this->say('    GRANT SELECT ON ALL TABLES IN SCHEMA public TO recoverkit;');
        }
    }

    private function q(string $name): string
    {
        if (!preg_match(self::NAME_RE, $name)) $this->fail("unsafe name: $name");
        return $this->driver === 'mysql' ? "`$name`" : '"' . $name . '"';
    }

    private function select(string $sql, array $params = []): array
    {
        if (!preg_match('/^\s*SELECT\s/i', $sql)) $this->fail('refusing to run a non-SELECT statement');
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        $rows = $st->fetchAll();
        $this->logQuery($sql, $params, count($rows));
        return $rows;
    }

    /** Table and column NAMES, row counts, and distinct values of short status-like columns. Never row data. */
    private function scanSchema(): array
    {
        $tables = [];
        if ($this->driver === 'sqlite') {
            foreach ($this->select("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as $r) {
                $cols = [];
                foreach ($this->pdo->query('PRAGMA table_info(' . $this->q($r['name']) . ')')->fetchAll() as $c) $cols[] = ['name' => $c['name'], 'type' => strtolower((string)$c['type'])];
                $tables[$r['name']] = ['name' => $r['name'], 'columns' => $cols];
            }
        } else {
            $schemaCond = $this->driver === 'mysql' ? 'table_schema = DATABASE()' : 'table_schema = current_schema()';
            foreach ($this->select("SELECT table_name AS t, column_name AS c, data_type AS d FROM information_schema.columns WHERE $schemaCond ORDER BY table_name, ordinal_position") as $r) {
                $t = $r['t'] ?? $r['T'] ?? ''; $c = $r['c'] ?? $r['C'] ?? ''; $d = $r['d'] ?? $r['D'] ?? '';
                if (!preg_match(self::NAME_RE, $t) || !preg_match(self::NAME_RE, $c)) continue;
                $tables[$t]['name'] = $t;
                $tables[$t]['columns'][] = ['name' => $c, 'type' => strtolower((string)$d)];
            }
        }
        foreach ($tables as $name => &$t) {
            if (!preg_match(self::NAME_RE, $name)) { unset($tables[$name]); continue; }
            $t['rows'] = (int)$this->select('SELECT COUNT(*) AS n FROM ' . $this->q($name))[0]['n'];
            $t['values'] = [];
            foreach ($t['columns'] as $c) {
                if (!preg_match('/(status|state|type|kind|category|service|product|network|channel|plan)$/i', $c['name'])) continue;
                if (!preg_match('/char|text|enum|string|user-defined|^$/', $c['type'])) continue; // user-defined = Postgres ENUM
                $vals = $this->select('SELECT DISTINCT ' . $this->q($c['name']) . ' AS v FROM ' . $this->q($name) . ' LIMIT 26');
                if (count($vals) > 25) continue; // free text, not a status
                $clean = [];
                foreach ($vals as $v) {
                    $s = (string)$v['v'];
                    if ($s !== '' && strlen($s) <= 32 && preg_match('/^[A-Za-z0-9 _.-]+$/', $s) && !preg_match('/@|\d{7,}/', $s)) $clean[] = $s;
                }
                if ($clean) $t['values'][$c['name']] = $clean;
            }
        }
        unset($t);
        return array_values($tables);
    }

    // ------------------------------------------------------------------ mapping

    private static function findCol(array $t, array $patterns): string
    {
        foreach ($patterns as $p) foreach ($t['columns'] as $c) if (preg_match($p, $c['name'])) return $c['name'];
        return '';
    }

    private static function successValues(array $t, string $col): array
    {
        return array_values(array_filter($t['values'][$col] ?? [], fn($v) => preg_match('/^((wc-)?(success|successful|succeeded|completed?|paid|delivered|approved|done|fulfilled|confirmed|active|won|settled)|wc-processing)$/i', $v)));
    }

    /** Built-in guesses from common naming habits, used when there is no AI suggestion. */
    public static function guessMapping(array $tables): array
    {
        $people = null; $best = -1;
        foreach ($tables as $t) {
            $score = preg_match('/^([A-Za-z0-9]+_)?(users?|customers?|members?|accounts?|clients?)$/i', $t['name']) ? 3 : 0; // also wp_users, tbl_members, app_users
            if (self::findCol($t, ['/^e-?mail(_address)?$/i', '/email/i'])) $score += 2;
            if (self::findCol($t, ['/^(phone|mobile|msisdn|phone_number|telephone)$/i', '/phone|mobile/i'])) $score += 1;
            if ($score > $best && $score >= 2) { $best = $score; $people = $t; }
        }
        $mapping = ['people' => ['table' => '', 'id' => '', 'email' => '', 'phone' => '', 'firstName' => '', 'createdAt' => ''], 'conversions' => [], 'signals' => [], 'notes' => 'Built-in guess from table and column names. Check it carefully.'];
        if (!$people) return $mapping;
        $mapping['people'] = [
            'table' => $people['name'],
            'id' => self::findCol($people, ['/^id$/i', '/^(user|customer|member)_?id$/i', '/^ID$/']),
            'email' => self::findCol($people, ['/^e-?mail(_address)?$/i', '/email/i']),
            'phone' => self::findCol($people, ['/^(phone|mobile|msisdn|phone_number|telephone)$/i', '/phone|mobile/i']),
            'firstName' => self::findCol($people, ['/^(first_?name|fname|firstname)$/i', '/^(name|full_?name|username)$/i']),
            'createdAt' => self::findCol($people, ['/^(created_at|createdat|date_joined|registered_at|user_registered|signup_date|reg_date|created|date_created)$/i', '/created|joined|regist/i']),
        ];
        $userPat = ['/^(user|customer|member|account|client)_?id$/i', '/^uid$/i', '/^userid$/i'];
        $timePat = ['/^(paid_at|completed_at|created_at|createdat|date|transaction_date|timestamp|created)$/i', '/date|time|_at$/i'];
        $amountPat = ['/^(amount|total|amount_paid|price|value|total_amount|grand_total)$/i', '/amount|total|price/i'];
        foreach ($tables as $t) {
            if ($t['name'] === $people['name']) continue;
            // Summary and helper tables repeat the same orders (e.g. WooCommerce wc_order_stats): never count them as sales.
            if (preg_match('/(_stats|_lookup|_meta|meta|_logs?|_items?|_notes?|_history|_audit)$/i', $t['name'])) continue;
            $user = self::findCol($t, $userPat);
            $time = self::findCol($t, $timePat);
            if (!$user || !$time) continue;
            $amount = self::findCol($t, $amountPat);
            $status = self::findCol($t, ['/^(status|state|payment_status|transaction_status)$/i']);
            $filters = [];
            $ok = $status ? self::successValues($t, $status) : [];
            if ($ok) $filters[] = ['column' => $status, 'values' => $ok];
            $unit = preg_match('/decimal|numeric|double|float|real|money/', (string)self::typeOf($t, $amount)) ? 'major' : 'minor';
            $base = ['name' => strtolower($t['name']), 'table' => $t['name'], 'key' => self::findCol($t, ['/^id$/i', '/^(reference|ref|transaction_id|txn_id)$/i']),
                'userColumn' => $user, 'timeColumn' => $time, 'amountColumn' => $amount, 'amountUnit' => $unit, 'filters' => $filters,
                // Guest checkouts: the email/phone typed on the order itself.
                'emailColumn' => self::findCol($t, ['/^(billing_|customer_|buyer_)?e-?mail$/i']), 'phoneColumn' => self::findCol($t, ['/^(billing_|customer_|buyer_)?(phone|mobile|msisdn)$/i'])];
            if (preg_match('/wallet|fund|deposit|top_?up|credit|load/i', $t['name'])) {
                $mapping['signals'][] = $base + ['kind' => 'deposit'];
            } elseif (preg_match('/cart|checkout|pending|basket/i', $t['name'])) {
                $mapping['signals'][] = $base + ['kind' => 'checkout'];
            } elseif ($amount && preg_match('/order|transaction|purchase|sale|bill|subscription|recharge|bet|payment|invoice|booking/i', $t['name'])) {
                $mapping['conversions'][] = $base + ['refColumn' => self::findCol($t, ['/^(reference|ref|payment_reference|transaction_ref|tx_ref|txn_ref|order_number)$/i'])];
            }
        }
        return $mapping;
    }

    /**
     * WooCommerce's tables are the same in every store, so no guessing is needed. Stores on the newer
     * order storage (HPOS) use {prefix}wc_orders; older stores keep orders in {prefix}posts + {prefix}postmeta.
     * During a migration both may hold the same orders, so only one is ever used.
     * Returns [mapping, description] or null when this isn't WooCommerce.
     */
    public static function wooRecipe(array $tables): ?array
    {
        $by = [];
        foreach ($tables as $t) $by[$t['name']] = $t;
        $prefix = null;
        foreach (array_keys($by) as $name) {
            if (preg_match('/^(.*)postmeta$/', $name, $m) && isset($by[$m[1] . 'posts'], $by[$m[1] . 'users'])) { $prefix = $m[1]; break; }
        }
        if ($prefix === null) return null;
        $people = ['table' => $prefix . 'users', 'id' => 'ID', 'email' => 'user_email', 'phone' => '', 'firstName' => 'display_name', 'createdAt' => 'user_registered'];
        $paid = ['wc-completed', 'wc-processing'];
        $unpaid = ['wc-pending', 'wc-failed', 'wc-on-hold', 'wc-cancelled'];
        $hpos = $by[$prefix . 'wc_orders'] ?? null;
        if ($hpos && ($hpos['rows'] ?? 0) > 0) {
            $addr = isset($by[$prefix . 'wc_order_addresses']) ? ['table' => $prefix . 'wc_order_addresses', 'fk' => 'order_id', 'keyColumn' => 'address_type', 'valueColumn' => 'phone'] : null;
            $base = ['table' => $prefix . 'wc_orders', 'key' => 'id', 'userColumn' => 'customer_id', 'emailColumn' => 'billing_email', 'phoneColumn' => $addr ? 'meta:billing' : '',
                'timeColumn' => 'date_created_gmt', 'amountColumn' => 'total_amount', 'amountUnit' => 'major', 'meta' => $addr];
            return [[
                'people' => $people,
                'conversions' => [$base + ['name' => 'woocommerce_order', 'refColumn' => 'transaction_id', 'filters' => [['column' => 'type', 'values' => ['shop_order']], ['column' => 'status', 'values' => $paid]]]],
                'signals' => [$base + ['name' => 'woocommerce_unpaid_order', 'kind' => 'checkout', 'filters' => [['column' => 'type', 'values' => ['shop_order']], ['column' => 'status', 'values' => $unpaid]]]],
                'notes' => 'Built-in WooCommerce mapping (newer order storage). Paid = completed or processing; pending/failed/on-hold orders are abandoned checkouts. Guest orders are matched by billing email and phone.',
            ], 'WooCommerce (newer order storage, ' . $prefix . 'wc_orders)'];
        }
        $meta = ['table' => $prefix . 'postmeta', 'fk' => 'post_id', 'keyColumn' => 'meta_key', 'valueColumn' => 'meta_value'];
        $base = ['table' => $prefix . 'posts', 'key' => 'ID', 'userColumn' => 'meta:_customer_user', 'emailColumn' => 'meta:_billing_email', 'phoneColumn' => 'meta:_billing_phone',
            'timeColumn' => 'post_date_gmt', 'amountColumn' => 'meta:_order_total', 'amountUnit' => 'major', 'meta' => $meta];
        return [[
            'people' => $people,
            'conversions' => [$base + ['name' => 'woocommerce_order', 'refColumn' => 'meta:_transaction_id', 'filters' => [['column' => 'post_type', 'values' => ['shop_order']], ['column' => 'post_status', 'values' => $paid]]]],
            'signals' => [$base + ['name' => 'woocommerce_unpaid_order', 'kind' => 'checkout', 'filters' => [['column' => 'post_type', 'values' => ['shop_order']], ['column' => 'post_status', 'values' => $unpaid]]]],
            'notes' => 'Built-in WooCommerce mapping (older order storage in ' . $prefix . 'posts and ' . $prefix . 'postmeta). Paid = completed or processing; pending/failed/on-hold orders are abandoned checkouts. Guest orders are matched by billing email and phone.',
        ], 'WooCommerce (older order storage, ' . $prefix . 'posts + ' . $prefix . 'postmeta)'];
    }

    private static function typeOf(array $t, string $col): string
    {
        foreach ($t['columns'] as $c) if ($c['name'] === $col) return $c['type'];
        return '';
    }

    /** Ask the business's own AI model (through RecoverKit) for a mapping. Only names and status values are sent. */
    private function suggestMapping(array $tables): ?array
    {
        $payload = ['schema' => ['dialect' => $this->driver, 'tables' => array_map(fn($t) => ['name' => $t['name'], 'rows' => $t['rows'], 'columns' => $t['columns'], 'values' => (object)$t['values']], $tables)]];
        $res = $this->post('/v1/connector/suggest', $payload, 90);
        if (!empty($res['mapping'])) return $res['mapping'];
        $this->say('  ' . ($res['reason'] ?? $res['error'] ?? 'No AI suggestion.'));
        return null;
    }

    /**
     * Drop anything that doesn't exist in the scanned schema. With $tables = null nothing is checked,
     * which gives the "expected" shape to compare against (so old config files never look changed).
     */
    private static function checkMapping(array $m, ?array $tables): array
    {
        $cols = [];
        foreach ((array)$tables as $t) $cols[$t['name']] = array_column($t['columns'], 'name');
        $tableOk = fn($t) => is_string($t) && $t !== '' && ($tables === null || isset($cols[$t]));
        $has = fn($t, $c) => is_string($c) && $c !== '' && ($tables === null || (isset($cols[$t]) && in_array($c, $cols[$t], true))) ? $c : '';
        $pt = $tableOk($m['people']['table'] ?? '') ? $m['people']['table'] : '';
        $people = ['table' => $pt];
        foreach (['id', 'email', 'phone', 'firstName', 'createdAt'] as $k) $people[$k] = $has($pt, $m['people'][$k] ?? '');
        $src = function ($s, $isSignal) use ($tableOk, $has) {
            $t = $s['table'] ?? '';
            if (!$tableOk($t)) return null;
            $o = ['name' => preg_match('/^[A-Za-z0-9_.:\/-]{1,64}$/', (string)($s['name'] ?? '')) ? $s['name'] : strtolower($t), 'table' => $t];
            $o['key'] = $has($t, $s['key'] ?? '');
            $o['timeColumn'] = $has($t, $s['timeColumn'] ?? '');
            // Optional key/value side table (e.g. wp_postmeta): fields written as "meta:<key>" are read from it.
            $meta = null;
            if (is_array($s['meta'] ?? null) && $tableOk($s['meta']['table'] ?? '') && $o['key']) {
                $mt = $s['meta']['table'];
                $meta = ['table' => $mt, 'fk' => $has($mt, $s['meta']['fk'] ?? ''), 'keyColumn' => $has($mt, $s['meta']['keyColumn'] ?? ''), 'valueColumn' => $has($mt, $s['meta']['valueColumn'] ?? '')];
                if (!$meta['fk'] || !$meta['keyColumn'] || !$meta['valueColumn']) $meta = null;
            }
            $field = function ($c) use ($t, $has, $meta) {
                if (is_string($c) && strpos($c, 'meta:') === 0) return $meta && preg_match(self::META_KEY_RE, substr($c, 5)) ? $c : '';
                return $has($t, $c);
            };
            foreach (['userColumn', 'emailColumn', 'phoneColumn', 'amountColumn'] as $k) $o[$k] = $field($s[$k] ?? '');
            $o['amountUnit'] = ($s['amountUnit'] ?? '') === 'major' ? 'major' : 'minor';
            $o['filters'] = [];
            foreach (array_slice((array)($s['filters'] ?? []), 0, 3) as $f) {
                $c = $has($t, $f['column'] ?? '');
                $v = array_values(array_filter((array)($f['values'] ?? []), fn($x) => is_string($x) && strlen($x) <= 64));
                if ($c && $v) $o['filters'][] = ['column' => $c, 'values' => array_slice($v, 0, 20)];
            }
            $o['meta'] = $meta;
            // A row needs a time and some way to know who it belongs to: an account, or the email/phone on the row (guest checkout).
            if (!$o['timeColumn'] || (!$o['userColumn'] && !$o['emailColumn'] && !$o['phoneColumn'])) return null;
            if ($isSignal) $o['kind'] = in_array($s['kind'] ?? '', ['deposit', 'checkout', 'login', 'custom'], true) ? $s['kind'] : 'custom';
            else { if (!$o['amountColumn']) return null; $o['refColumn'] = $field($s['refColumn'] ?? ''); }
            return $o;
        };
        return [
            'people' => $people,
            'conversions' => array_values(array_filter(array_map(fn($s) => $src($s, false), array_slice((array)($m['conversions'] ?? []), 0, 5)))),
            'signals' => array_values(array_filter(array_map(fn($s) => $src($s, true), array_slice((array)($m['signals'] ?? []), 0, 10)))),
            'notes' => is_string($m['notes'] ?? null) ? substr($m['notes'], 0, 500) : '',
        ];
    }

    /**
     * FROM/JOIN/WHERE for one source, with the base table aliased "s". Fields written "meta:<key>" become
     * LEFT JOINs on the key/value table; the key name is a bound parameter. Returns [sql, expressions].
     */
    private function sourceSql(array $s, array $fields, array &$params): array
    {
        $joins = ''; $expr = []; $n = 0;
        foreach ($fields as $alias => $field) {
            $col = $s[$field] ?? '';
            if ($col === '') continue;
            if (strpos($col, 'meta:') === 0) {
                $m = $s['meta']; $n++;
                $joins .= ' LEFT JOIN ' . $this->q($m['table']) . " m$n ON m$n." . $this->q($m['fk']) . ' = s.' . $this->q($s['key']) . " AND m$n." . $this->q($m['keyColumn']) . ' = ?';
                $params[] = substr($col, 5);
                $expr[$alias] = "m$n." . $this->q($m['valueColumn']);
            } else {
                $expr[$alias] = 's.' . $this->q($col);
            }
        }
        $where = [];
        foreach ($s['filters'] as $f) {
            $where[] = 's.' . $this->q($f['column']) . ' IN (' . implode(',', array_fill(0, count($f['values']), '?')) . ')';
            foreach ($f['values'] as $v) $params[] = $v;
        }
        return [' FROM ' . $this->q($s['table']) . ' s' . $joins . ($where ? ' WHERE ' . implode(' AND ', $where) : ''), $expr];
    }

    private function asText(string $expr): string
    {
        return 'NULLIF(NULLIF(CAST(' . $expr . ' AS ' . ($this->driver === 'mysql' ? 'CHAR' : 'TEXT') . "), ''), '0')";
    }

    private static function fieldLabel(array $s, string $field): string
    {
        $c = $s[$field] ?? '';
        if ($c === '') return '';
        return strpos($c, 'meta:') === 0 ? '`' . substr($c, 5) . "` (from `{$s['meta']['table']}`)" : "`$c`";
    }

    private function describe(array $m): void
    {
        $p = $m['people'];
        $this->say("  People:      table `{$p['table']}` (id `{$p['id']}`, email `" . ($p['email'] ?: '—') . "`, phone `" . ($p['phone'] ?: '—') . "`, signed up `" . ($p['createdAt'] ?: '—') . '`)');
        $f = fn($s) => $s['filters'] ? ' where ' . implode(' and ', array_map(fn($x) => "{$x['column']} is " . implode('/', $x['values']), $s['filters'])) : ' (every row)';
        $who = function ($s) {
            $parts = [];
            if ($s['userColumn']) $parts[] = 'account ' . self::fieldLabel($s, 'userColumn');
            if ($s['emailColumn'] || $s['phoneColumn']) $parts[] = 'guest ' . trim(self::fieldLabel($s, 'emailColumn') . ' ' . self::fieldLabel($s, 'phoneColumn'));
            return ' · buyer: ' . implode(' or ', $parts);
        };
        foreach ($m['conversions'] as $s) $this->say("  A SALE is:   a row in `{$s['table']}`{$f($s)}, amount " . self::fieldLabel($s, 'amountColumn') . ' in ' . ($s['amountUnit'] === 'major' ? 'naira' : 'kobo') . $who($s));
        if (!$m['conversions']) $this->say('  A SALE is:   (nothing found — sales will only come from webhooks or trackPurchase)');
        foreach ($m['signals'] as $s) $this->say("  Not a sale:  `{$s['table']}`{$f($s)} → {$s['kind']}");
        if ($m['notes'] !== '') $this->say('  Note: ' . $m['notes']);
    }

    /** Counts only, computed here. Nothing is sent. */
    private function dryRun(array $m): array
    {
        $p = $m['people'];
        $out = ['people' => (int)$this->select('SELECT COUNT(*) AS n FROM ' . $this->q($p['table']))[0]['n'], 'buyers' => 0, 'guests' => 0, 'sales' => 0, 'signals' => []];
        $fields = ['u' => 'userColumn', 'e' => 'emailColumn', 'ph' => 'phoneColumn'];
        foreach ($m['conversions'] as $s) {
            $params = [];
            [$from, $x] = $this->sourceSql($s, $fields, $params);
            $user = isset($x['u']) ? $this->asText($x['u']) : 'NULL';
            $contact = 'COALESCE(' . (isset($x['e']) ? $this->asText($x['e']) : 'NULL') . ', ' . (isset($x['ph']) ? $this->asText($x['ph']) : 'NULL') . ')';
            $r = $this->select("SELECT COUNT(*) AS n, COUNT(DISTINCT $user) AS u, COUNT(DISTINCT CASE WHEN $user IS NULL THEN $contact END) AS g" . $from, $params)[0];
            $out['sales'] += (int)$r['n']; $out['buyers'] = max($out['buyers'], (int)$r['u']); $out['guests'] += (int)$r['g'];
        }
        foreach ($m['signals'] as $s) {
            $params = [];
            [$from, $x] = $this->sourceSql($s, $fields, $params);
            $parts = array_map([$this, 'asText'], array_values($x));
            $who = count($parts) === 1 ? $parts[0] : 'COALESCE(' . implode(', ', $parts) . ')';
            $out['signals'][$s['name']] = (int)$this->select("SELECT COUNT(DISTINCT $who) AS u" . $from, $params)[0]['u'];
        }
        return $out;
    }

    // ------------------------------------------------------------------ commands

    public function setup(bool $useAi): void
    {
        $this->say('RecoverKit Connector ' . self::VERSION . ' — setup');
        $this->connect();
        $this->hasher(); // check keys early
        $this->say('Looking at your table and column names (not your data)...');
        $tables = $this->scanSchema();
        if (!$tables) $this->fail('no tables found');
        $this->say(sprintf('Found %d tables.', count($tables)));
        $this->checkReadOnly($tables);

        $mapping = null;
        $woo = self::wooRecipe($tables);
        if ($woo) {
            $this->say('Recognised ' . $woo[1] . '. Using the built-in WooCommerce mapping (no AI needed).');
            $mapping = self::checkMapping($woo[0], $tables);
        }
        if (!$mapping && $useAi && $this->ask('Ask your AI model to suggest the mapping? It will see table names, column names and status values like "successful", never customer data.')) {
            $this->say('Asking...');
            $s = $this->suggestMapping($tables);
            if ($s) $mapping = self::checkMapping($s, $tables);
        }
        if (!$mapping || !$mapping['people']['table']) $mapping = self::checkMapping(self::guessMapping($tables), $tables);
        if (!$mapping['people']['table'] || !$mapping['people']['id'] || (!$mapping['people']['email'] && !$mapping['people']['phone'])) {
            $this->fail('could not find a users table with an id and an email or phone column. Edit recoverkit-connector.json by hand (see the README).');
        }

        $this->say(''); $this->say('Here is what I understood:'); $this->describe($mapping);
        $d = $this->dryRun($mapping);
        $this->say(''); $this->say('Dry run (counted on your server, nothing sent):');
        $this->say(sprintf('  %d people · %d have bought (%d sales) · %d never bought', $d['people'], $d['buyers'], $d['sales'], max(0, $d['people'] - $d['buyers'])));
        if ($d['guests']) $this->say(sprintf('  + %d guest buyers who checked out without an account', $d['guests']));
        foreach ($d['signals'] as $n => $c) $this->say(sprintf('  %d people with %s', $c, $n));
        if (!$this->ask('Does that look right?')) $this->fail('not saved. Edit recoverkit-connector.json by hand, or run setup again.');

        $share = $this->ask('Let RecoverKit keep encrypted email/phone/first name so it can send follow-ups for you? (No = only hashes leave this server, and you send messages yourself.)', false);
        $config = ['version' => 1, 'mapping' => $mapping, 'shareContact' => $share, 'historyDays' => (int)($this->env['RK_HISTORY_DAYS'] ?? 730), 'savedAt' => date('c')];
        file_put_contents($this->path('recoverkit-connector.json'), json_encode($config, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL);
        @chmod($this->path('recoverkit-connector.json'), 0640);
        $this->say(''); $this->say('Saved recoverkit-connector.json. Next:');
        $this->say('  php ' . basename(__FILE__) . ' sync              (first run sends your history)');
        $this->say('  */15 * * * * php ' . __FILE__ . ' sync      (cron, every 15 minutes)');
    }

    private function loadConfig(): array
    {
        $file = $this->path('recoverkit-connector.json');
        if (!is_file($file)) $this->fail('no recoverkit-connector.json yet. Run: php ' . basename(__FILE__) . ' setup');
        $c = json_decode((string)file_get_contents($file), true);
        if (!is_array($c) || !isset($c['mapping'])) $this->fail('recoverkit-connector.json is not valid');
        return $c;
    }

    private function tsOf($v): ?int
    {
        if ($v === null || $v === '') return null;
        if (is_numeric($v)) { $n = (float)$v; return (int)($n < 1e12 ? $n * 1000 : $n); }
        $t = strtotime((string)$v);
        return $t === false ? null : $t * 1000;
    }

    private static function minor($v, string $unit): ?int
    {
        if ($v === null || !is_numeric($v)) return null;
        $n = (float)$v;
        if ($n < 0) return null;
        return (int)round($unit === 'major' ? $n * 100 : $n);
    }

    public function sync(): void
    {
        $config = $this->loadConfig();
        $this->connect();
        $tables = $this->scanSchemaNamesOnly();
        $m = self::checkMapping($config['mapping'], $tables);
        // Safety: if the app's tables changed, stop rather than send something wrong.
        if ($m !== self::checkMapping($config['mapping'], null)) $this->fail('your database tables changed since setup (a table or column in the mapping is gone). Run setup again. Nothing was sent.');

        $stateFile = $this->path('.recoverkit-connector-state.json');
        $state = is_file($stateFile) ? (json_decode((string)file_get_contents($stateFile), true) ?: []) : [];
        $since = fn(string $k) => isset($state[$k]) ? (int)$state[$k] - 86400000 : (int)((time() - 86400 * (int)$config['historyDays']) * 1000);
        $share = !empty($config['shareContact']);
        $p = $m['people'];
        $peopleCache = [];
        $buffer = ['people' => [], 'events' => []];
        $totals = ['people' => 0, 'events' => 0, 'newEvents' => 0];
        $newState = $state;

        $flush = function (bool $final = false) use (&$buffer, &$totals, $share) {
            if (!$final && count($buffer['people']) + count($buffer['events']) < self::BATCH) return;
            if (!$buffer['people'] && !$buffer['events'] && !$final) return;
            $body = ['people' => $buffer['people'], 'events' => $buffer['events'], 'shareContact' => $share, 'source' => 'php-connector', 'version' => self::VERSION];
            if ($final) $body += ['final' => true, 'totals' => $totals];
            $res = $this->post('/v1/connector/sync', $body, 60);
            if (empty($res['ok'])) $this->fail('sync failed: ' . ($res['error'] ?? 'unknown error') . '. Nothing after this point was sent; the next run will retry.');
            $totals['newEvents'] += (int)($res['newEvents'] ?? 0);
            $buffer = ['people' => [], 'events' => []];
        };

        $personPayload = function (array $row) use ($p, $share): ?array {
            $ids = $this->hasher()->hashes(['email' => $p['email'] ? $row[$p['email']] : null, 'phone' => $p['phone'] ? $row[$p['phone']] : null]);
            if (!$ids) return null;
            $out = ['ids' => $ids, 'key' => hash('sha256', 'person|' . $p['table'] . '|' . $row[$p['id']])];
            $ts = $p['createdAt'] ? $this->tsOf($row[$p['createdAt']]) : null;
            if ($ts) $out['createdAt'] = min($ts, (int)(microtime(true) * 1000));
            if ($share) $out['contact'] = ['email' => $p['email'] ? $row[$p['email']] : null, 'phone' => $p['phone'] ? $row[$p['phone']] : null, 'firstName' => $p['firstName'] ? $row[$p['firstName']] : null];
            return $out;
        };

        // 1. People (new or all, on the first run).
        $cols = array_values(array_unique(array_filter([$p['id'], $p['email'], $p['phone'], $p['firstName'], $p['createdAt']])));
        $select = 'SELECT ' . implode(', ', array_map([$this, 'q'], $cols)) . ' FROM ' . $this->q($p['table']);
        $cursorKey = 'people';
        $where = ''; $params = [];
        if ($p['createdAt'] && isset($state[$cursorKey])) { $where = ' WHERE ' . $this->q($p['createdAt']) . ' >= ?'; $params[] = $this->cursor($p['table'], $p['createdAt'], $since($cursorKey)); }
        for ($offset = 0; ; $offset += self::PAGE) {
            $rows = $this->select($select . $where . ' ORDER BY ' . $this->q($p['id']) . ' LIMIT ' . self::PAGE . ' OFFSET ' . $offset, $params);
            foreach ($rows as $row) {
                $pp = $personPayload($row);
                $peopleCache[(string)$row[$p['id']]] = $pp ? $pp['ids'] : [];
                if (!$pp) continue;
                $buffer['people'][] = $pp; $totals['people']++;
                if (!empty($pp['createdAt'])) $newState[$cursorKey] = max($newState[$cursorKey] ?? 0, $pp['createdAt']);
                $flush();
            }
            if (count($rows) < self::PAGE) break;
        }
        $newState[$cursorKey] = $newState[$cursorKey] ?? (int)(microtime(true) * 1000);

        // Look up people referenced by events that weren't in this run's people list.
        $idsFor = function (array $userIds) use (&$peopleCache, $p, $cols): void {
            $missing = array_values(array_filter(array_unique($userIds), fn($u) => !array_key_exists((string)$u, $peopleCache)));
            foreach (array_chunk($missing, 500) as $chunk) {
                $rows = $this->select('SELECT ' . implode(', ', array_map([$this, 'q'], $cols)) . ' FROM ' . $this->q($p['table']) . ' WHERE ' . $this->q($p['id']) . ' IN (' . implode(',', array_fill(0, count($chunk), '?')) . ')', $chunk);
                foreach ($rows as $row) $peopleCache[(string)$row[$p['id']]] = $this->hasher()->hashes(['email' => $p['email'] ? $row[$p['email']] : null, 'phone' => $p['phone'] ? $row[$p['phone']] : null]);
                foreach ($chunk as $u) if (!array_key_exists((string)$u, $peopleCache)) $peopleCache[(string)$u] = [];
            }
        };

        // 2. Sales and signals, oldest first, from the cursor.
        $now = (int)(microtime(true) * 1000);
        $oldest = $now - 5 * 365 * 86400000;
        $sources = array_merge(array_map(fn($s) => $s + ['_kind' => 'conversion'], $m['conversions']), array_map(fn($s) => $s + ['_kind' => 'signal'], $m['signals']));
        $fields = ['k' => 'key', 'u' => 'userColumn', 'e' => 'emailColumn', 'ph' => 'phoneColumn', 't' => 'timeColumn', 'a' => 'amountColumn', 'r' => 'refColumn'];
        foreach ($sources as $s) {
            $ck = $s['_kind'] . ':' . $s['name'] . ':' . $s['table'];
            $params = [];
            [$from, $x] = $this->sourceSql($s, $fields, $params);
            $from .= (strpos($from, ' WHERE ') !== false ? ' AND ' : ' WHERE ') . 's.' . $this->q($s['timeColumn']) . ' >= ?';
            $params[] = $this->cursor($s['table'], $s['timeColumn'], $since($ck));
            $select = 'SELECT ' . implode(', ', array_map(fn($a, $e) => "$e AS $a", array_keys($x), $x));
            $order = ' ORDER BY s.' . $this->q($s['timeColumn']) . ($s['key'] ? ', s.' . $this->q($s['key']) : '');
            for ($offset = 0; ; $offset += self::PAGE) {
                $rows = $this->select($select . $from . $order . ' LIMIT ' . self::PAGE . ' OFFSET ' . $offset, $params);
                $isAccount = fn($u) => $u !== null && $u !== '' && $u !== '0' && $u !== 0;
                $idsFor(array_values(array_filter(array_map(fn($r) => isset($r['u']) ? (string)$r['u'] : null, $rows), $isAccount)));
                foreach ($rows as $row) {
                    $u = $row['u'] ?? null;
                    $ids = $isAccount($u) ? ($peopleCache[(string)$u] ?? []) : [];
                    // Guest checkout (or an account plus the email typed on the order): identify by the order's own email/phone.
                    $own = $this->hasher()->hashes(['email' => $row['e'] ?? null, 'phone' => $row['ph'] ?? null]);
                    $ids = array_slice(array_values(array_unique(array_merge($ids, $own))), 0, 4);
                    $ts = $this->tsOf($row['t'] ?? null);
                    if (!$ids || !$ts || $ts < $oldest) continue; // e.g. WordPress '0000-00-00' dates
                    $amount = isset($x['a']) ? self::minor($row['a'] ?? null, $s['amountUnit']) : null;
                    if ($s['_kind'] === 'conversion' && $amount === null) continue;
                    $rowKey = $s['key'] ? (string)$row['k'] : ($u ?? ($row['e'] ?? '')) . '|' . $ts . '|' . $amount;
                    $ev = ['kind' => $s['_kind'], 'name' => $s['name'], 'ids' => $ids, 'ts' => min($ts, $now), 'amount' => $amount, 'key' => hash('sha256', $ck . '|' . $rowKey)];
                    if ($s['_kind'] === 'signal') $ev['signal'] = $s['kind'];
                    if (isset($row['r']) && preg_match('/^[\x21-\x7e]{1,128}$/', (string)$row['r'])) $ev['ref'] = (string)$row['r'];
                    $buffer['events'][] = $ev; $totals['events']++;
                    $newState[$ck] = max($newState[$ck] ?? 0, $ev['ts']);
                    $flush();
                }
                if (count($rows) < self::PAGE) break;
            }
            $newState[$ck] = $newState[$ck] ?? $now;
        }
        $flush(true);
        $newState['lastSyncAt'] = (int)(microtime(true) * 1000);
        file_put_contents($stateFile, json_encode($newState, JSON_PRETTY_PRINT) . PHP_EOL);
        $this->say(sprintf('Synced: %d people, %d sales and signals checked, %d new.', $totals['people'], $totals['events'], $totals['newEvents']));
    }

    private function scanSchemaNamesOnly(): array
    {
        $tables = [];
        if ($this->driver === 'sqlite') {
            foreach ($this->select("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'") as $r) {
                $tables[] = ['name' => $r['name'], 'columns' => array_map(fn($c) => ['name' => $c['name'], 'type' => ''], $this->pdo->query('PRAGMA table_info(' . $this->q($r['name']) . ')')->fetchAll())];
            }
            return $tables;
        }
        $schemaCond = $this->driver === 'mysql' ? 'table_schema = DATABASE()' : 'table_schema = current_schema()';
        $by = [];
        foreach ($this->select("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE $schemaCond") as $r) {
            $t = $r['t'] ?? $r['T'] ?? ''; $c = $r['c'] ?? $r['C'] ?? '';
            $by[$t][] = ['name' => $c, 'type' => ''];
        }
        foreach ($by as $t => $cols) $tables[] = ['name' => $t, 'columns' => $cols];
        return $tables;
    }

    /** @var array<string,string> */
    private array $timeFormat = [];

    /** Cursor value in the column's own format: datetime text, unix seconds or unix milliseconds. */
    private function cursor(string $table, string $col, int $ms)
    {
        $k = "$table.$col";
        if (!isset($this->timeFormat[$k])) {
            $r = $this->select('SELECT MAX(' . $this->q($col) . ') AS v FROM ' . $this->q($table));
            $v = $r[0]['v'] ?? null;
            $this->timeFormat[$k] = is_numeric($v) ? ((float)$v >= 1e12 ? 'ms' : 's') : 'text';
        }
        $sec = intdiv(max(0, $ms), 1000);
        if ($this->timeFormat[$k] === 'ms') return $sec * 1000;
        if ($this->timeFormat[$k] === 's') return $sec;
        return date('Y-m-d H:i:s', $sec);
    }

    public function status(): void
    {
        $c = $this->loadConfig();
        $this->say('RecoverKit Connector ' . self::VERSION);
        $this->describe($c['mapping']);
        $this->say('Contact details shared: ' . (!empty($c['shareContact']) ? 'yes (encrypted at RecoverKit)' : 'no (hashes only)'));
        $s = $this->path('.recoverkit-connector-state.json');
        $st = is_file($s) ? json_decode((string)file_get_contents($s), true) : null;
        $this->say('Last sync: ' . (!empty($st['lastSyncAt']) ? date('Y-m-d H:i', intdiv((int)$st['lastSyncAt'], 1000)) : 'never'));
        $this->say('Every query is logged in recoverkit-connector.log');
    }

    // ------------------------------------------------------------------ network (outbound only)

    private function post(string $path, array $body, int $timeout): array
    {
        $url = $this->endpoint() . $path;
        $parts = parse_url($url);
        $local = in_array($parts['host'] ?? '', ['localhost', '127.0.0.1', '::1', '[::1]'], true);
        if (($parts['scheme'] ?? '') !== 'https' && !$local) $this->fail('RK_ENDPOINT must use https');
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => $timeout, CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $this->need('RK_SECRET_KEY'), 'User-Agent: recoverkit-connector/' . self::VERSION],
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_FOLLOWLOCATION => false,
        ]);
        $raw = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($raw === false) return ['error' => 'could not reach RecoverKit: ' . $err];
        $json = json_decode((string)$raw, true) ?: [];
        if ($status === 401) return ['error' => 'the secret key was rejected (revoked or wrong)'];
        if ($status < 200 || $status >= 300) return ['error' => 'HTTP ' . $status . ': ' . ($json['error'] ?? 'request failed')];
        return $json;
    }
}

// ---------------------------------------------------------------------- CLI
if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    $args = array_slice($argv, 1);
    $cmd = $args[0] ?? 'help';
    $env = getenv();
    $dir = getcwd();
    foreach ($args as $a) {
        // --app=/path/to/your/app works for any framework; --laravel= is kept as an alias.
        if (strpos($a, '--app=') === 0 || strpos($a, '--laravel=') === 0) {
            $root = rtrim(substr($a, strpos($a, '=') + 1), '/');
            $dotenv = RecoverKitDetect::readDotenv("$root/.env");
            foreach (['RK_PUBLIC_KEY', 'RK_SECRET_KEY', 'RK_ENDPOINT', 'RK_DB_DSN', 'RK_DB_USER', 'RK_DB_PASS', 'RK_TIMEZONE', 'RK_HISTORY_DAYS'] as $k) {
                if (!isset($env[$k]) && isset($dotenv[$k])) $env[$k] = $dotenv[$k];
            }
            if (!isset($env['RK_DB_DSN'])) {
                $found = RecoverKitDetect::detect($root, $env);
                if (isset($found['error'])) { fwrite(STDERR, 'Error: ' . $found['error'] . PHP_EOL); exit(1); }
                $env['RK_DB_DSN'] = $found['dsn'];
                // A dedicated read-only login (RK_DB_USER / RK_DB_PASS) always wins over the app's own login.
                if (!isset($env['RK_DB_USER'])) $env['RK_DB_USER'] = (string)($found['user'] ?? '');
                if (!isset($env['RK_DB_PASS'])) $env['RK_DB_PASS'] = (string)($found['pass'] ?? '');
                fwrite(STDOUT, sprintf("Found your database in %s (%s): %s%s\n", $found['source'], $found['framework'], preg_replace('/password=[^;]*/i', 'password=***', $found['dsn']),
                    isset($found['tablePrefix']) ? " · table prefix {$found['tablePrefix']}" : ''));
            }
            $dir = $root;
        }
        if (strpos($a, '--dir=') === 0) $dir = substr($a, 6);
    }
    $c = new RecoverKitConnector($env, $dir, in_array('--yes', $args, true));
    if ($cmd === 'setup') $c->setup(!in_array('--no-ai', $args, true));
    elseif ($cmd === 'sync') $c->sync();
    elseif ($cmd === 'status') $c->status();
    elseif ($cmd === 'detect') { $r = RecoverKitDetect::detect(rtrim($args[1] ?? $dir, '/'), $env); unset($r['pass']); fwrite(STDOUT, json_encode($r, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL); }
    else fwrite(STDOUT, "Usage: php recoverkit-connector.php setup|sync|status [--app=/path/to/your/app] [--yes] [--no-ai]\n       php recoverkit-connector.php detect /path/to/your/app\n");
}
