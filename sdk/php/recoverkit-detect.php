<?php
// RecoverKit SDK. MIT License, Copyright (c) 2026 Light8749. https://github.com/Light8749/recoverkit
/**
 * Finds an app's database login from its own config files, whatever language it's written in.
 * The connector reads the DATABASE, so the app can be PHP, Node, Python, Ruby, Java, .NET or Go;
 * this file just saves the developer from typing the login in.
 *
 * Supported: Laravel, WordPress/WooCommerce, Django, Rails, Prisma, Spring Boot, ASP.NET,
 * and any app with DATABASE_URL or DB_* variables in .env or the environment.
 * Databases: MySQL/MariaDB, PostgreSQL, SQLite. (MongoDB, SQL Server and Oracle are reported as unsupported.)
 *
 * Returns ['dsn' => ..., 'user' => ..., 'pass' => ..., 'source' => 'which file', 'framework' => ...]
 * or ['error' => 'why'] — never throws.
 */

declare(strict_types=1);

final class RecoverKitDetect
{
    public static function detect(string $root, array $env = []): array
    {
        $root = rtrim($root, '/');
        if (!is_dir($root)) return ['error' => "no folder at $root"];
        $dotenv = self::readDotenv("$root/.env");
        $vars = $env + $dotenv; // real environment wins over .env

        $tries = [
            'Laravel' => fn() => is_file("$root/artisan") ? self::fromLaravel($root, $vars) : null,
            'WordPress' => fn() => is_file("$root/wp-config.php") ? self::fromWordPress($root) : null,
            'Rails' => fn() => is_file("$root/config/database.yml") ? self::fromRails($root, $vars) : null,
            'Django' => fn() => self::fromDjango($root, $vars),
            'Prisma' => fn() => is_file("$root/prisma/schema.prisma") ? self::fromPrisma($root, $vars) : null,
            'Spring Boot' => fn() => self::fromSpring($root, $vars),
            'ASP.NET' => fn() => is_file("$root/appsettings.json") ? self::fromDotnet($root) : null,
            '.env' => fn() => self::fromVars($vars, $root),
        ];
        $errors = [];
        foreach ($tries as $framework => $try) {
            $r = $try();
            if ($r === null) continue;
            if (isset($r['error'])) { $errors[] = "$framework: {$r['error']}"; continue; }
            return $r + ['framework' => $framework];
        }
        return ['error' => $errors ? implode('; ', $errors) : 'could not find a database login in this folder. Set RK_DB_DSN, RK_DB_USER and RK_DB_PASS instead.'];
    }

    // ------------------------------------------------------------------ parsers

    public static function readDotenv(string $file): array
    {
        if (!is_file($file)) return [];
        $out = [];
        foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            if (preg_match('/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$/', $line, $m) && strpos(ltrim($line), '#') !== 0) {
                $v = $m[2];
                if (preg_match('/^"(.*)"$/s', $v, $q) || preg_match("/^'(.*)'$/s", $v, $q)) $v = $q[1];
                else $v = preg_replace('/\s+#.*$/', '', $v);
                $out[$m[1]] = $v;
            }
        }
        // ${VAR} references inside .env
        foreach ($out as $k => $v) $out[$k] = preg_replace_callback('/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/', fn($m) => $out[$m[1]] ?? '', $v);
        return $out;
    }

    /** mysql://user:pass@host:3306/db, postgres://..., sqlite:///path or file:./dev.db */
    public static function fromUrl(string $url, string $baseDir = '.'): array
    {
        $url = trim($url);
        if (preg_match('#^(file:|sqlite:)(//)?(.+)$#i', $url, $m)) {
            $path = preg_replace('/\?.*$/', '', $m[3]);
            if ($path[0] !== '/') $path = rtrim($baseDir, '/') . '/' . preg_replace('#^\./#', '', $path);
            return ['dsn' => 'sqlite:' . $path, 'user' => null, 'pass' => null];
        }
        $p = parse_url($url);
        if (!$p || empty($p['scheme'])) return ['error' => 'DATABASE_URL is not a valid URL'];
        $scheme = strtolower($p['scheme']);
        $driver = in_array($scheme, ['mysql', 'mysql2', 'mariadb', 'mysqlx'], true) ? 'mysql' : (in_array($scheme, ['postgres', 'postgresql', 'pgsql'], true) ? 'pgsql' : null);
        if ($driver === null) return ['error' => self::unsupported($scheme)];
        $db = ltrim($p['path'] ?? '', '/');
        return [
            'dsn' => sprintf('%s:host=%s;port=%d;dbname=%s', $driver, $p['host'] ?? '127.0.0.1', $p['port'] ?? ($driver === 'pgsql' ? 5432 : 3306), urldecode($db)),
            'user' => isset($p['user']) ? urldecode($p['user']) : null,
            'pass' => isset($p['pass']) ? urldecode($p['pass']) : null,
        ];
    }

    private static function unsupported(string $what): string
    {
        $w = strtolower($what);
        if (strpos($w, 'mongo') !== false) return 'MongoDB is not supported yet (the connector reads SQL databases: MySQL, PostgreSQL, SQLite)';
        if (preg_match('/sqlserver|mssql|sqlsrv/', $w)) return 'SQL Server is not supported yet';
        if (strpos($w, 'oracle') !== false) return 'Oracle is not supported yet';
        return "unsupported database type \"$what\"";
    }

    private static function build(string $driver, ?string $host, $port, ?string $db, ?string $user, ?string $pass, string $source, string $root): array
    {
        $driver = strtolower($driver);
        if (preg_match('/^(mysql|mysql2|mariadb|mysqli)$/', $driver) || strpos($driver, 'mysql') !== false) $driver = 'mysql';
        elseif (preg_match('/postg|pgsql|psql/', $driver)) $driver = 'pgsql';
        elseif (strpos($driver, 'sqlite') !== false) $driver = 'sqlite';
        else return ['error' => self::unsupported($driver)];
        if ($driver === 'sqlite') {
            $path = (string)$db;
            if ($path === '' ) return ['error' => 'SQLite database path is empty'];
            if ($path[0] !== '/') $path = "$root/$path";
            return ['dsn' => "sqlite:$path", 'user' => null, 'pass' => null, 'source' => $source];
        }
        if (!$db) return ['error' => 'database name is empty'];
        $host = $host ?: '127.0.0.1';
        // "localhost:3307" (WordPress style)
        if (preg_match('/^(.+):(\d+)$/', $host, $m)) { $host = $m[1]; $port = $m[2]; }
        $port = (int)($port ?: ($driver === 'pgsql' ? 5432 : 3306));
        return ['dsn' => "$driver:host=$host;port=$port;dbname=$db", 'user' => $user, 'pass' => $pass, 'source' => $source];
    }

    private static function fromLaravel(string $root, array $v): ?array
    {
        if (!empty($v['DB_URL']) || !empty($v['DATABASE_URL'])) return self::fromUrl($v['DB_URL'] ?? $v['DATABASE_URL'], $root) + ['source' => '.env (DB_URL)'];
        $conn = $v['DB_CONNECTION'] ?? 'mysql';
        $db = $v['DB_DATABASE'] ?? ($conn === 'sqlite' ? 'database/database.sqlite' : null);
        return self::build($conn, $v['DB_HOST'] ?? null, $v['DB_PORT'] ?? null, $db, $v['DB_USERNAME'] ?? null, $v['DB_PASSWORD'] ?? null, '.env', $root);
    }

    private static function fromWordPress(string $root): ?array
    {
        $src = (string)file_get_contents("$root/wp-config.php");
        $get = function (string $k) use ($src) {
            return preg_match("/define\(\s*['\"]" . $k . "['\"]\s*,\s*['\"]((?:[^'\"\\\\]|\\\\.)*)['\"]\s*\)/", $src, $m) ? stripcslashes($m[1]) : null;
        };
        $r = self::build('mysql', $get('DB_HOST'), null, $get('DB_NAME'), $get('DB_USER'), $get('DB_PASSWORD'), 'wp-config.php', $root);
        if (!isset($r['error']) && preg_match("/\\\$table_prefix\s*=\s*['\"]([A-Za-z0-9_]+)['\"]/", $src, $m)) $r['tablePrefix'] = $m[1];
        return $r;
    }

    /** Resolves ERB like <%= ENV['X'] %> and <%= ENV.fetch("X") { "default" } %>. */
    private static function erb(string $s, array $v): string
    {
        return preg_replace_callback('/<%=\s*ENV(?:\.fetch\(\s*|\[\s*)[\'"]([A-Za-z0-9_]+)[\'"]\s*[\])](?:\s*\{\s*[\'"]?([^\'"}]*)[\'"]?\s*\})?(?:\s*\|\|\s*[\'"]([^\'"]*)[\'"])?\s*%>/',
            fn($m) => $v[$m[1]] ?? ($m[2] ?? '') ?: ($m[3] ?? ''), $s);
    }

    private static function fromRails(string $root, array $v): ?array
    {
        $lines = file("$root/config/database.yml", FILE_IGNORE_NEW_LINES) ?: [];
        $sections = []; $anchors = []; $cur = null;
        foreach ($lines as $line) {
            if (preg_match('/^\s*#/', $line) || trim($line) === '') continue;
            if (preg_match('/^([A-Za-z0-9_]+):\s*(?:&([A-Za-z0-9_]+))?\s*$/', $line, $m)) { $cur = $m[1]; $sections[$cur] = []; if (!empty($m[2])) $anchors[$m[2]] = $cur; continue; }
            if ($cur !== null && preg_match('/^\s+<<:\s*\*([A-Za-z0-9_]+)/', $line, $m)) { $sections[$cur]['<<'] = $m[1]; continue; }
            if ($cur !== null && preg_match('/^\s{2}([A-Za-z0-9_]+):\s*(.*?)\s*$/', $line, $m)) $sections[$cur][$m[1]] = trim(self::erb($m[2], $v), " \"'");
        }
        $env = $v['RAILS_ENV'] ?? $v['RACK_ENV'] ?? (isset($sections['production']) ? 'production' : 'development');
        $s = $sections[$env] ?? null;
        if ($s === null) return ['error' => "no \"$env\" section in config/database.yml"];
        if (isset($s['<<']) && isset($anchors[$s['<<']])) $s = $s + $sections[$anchors[$s['<<']]];
        if (!empty($s['url'])) return self::fromUrl($s['url'], $root) + ['source' => "config/database.yml ($env)"];
        if (!empty($v['DATABASE_URL']) && empty($s['database'])) return self::fromUrl($v['DATABASE_URL'], $root) + ['source' => 'DATABASE_URL'];
        return self::build($s['adapter'] ?? '', $s['host'] ?? null, $s['port'] ?? null, $s['database'] ?? null, $s['username'] ?? null, $s['password'] ?? null, "config/database.yml ($env)", $root);
    }

    private static function fromDjango(string $root, array $v): ?array
    {
        $candidates = array_merge(glob("$root/*/settings.py") ?: [], glob("$root/*/settings/*.py") ?: [], glob("$root/settings.py") ?: []);
        foreach ($candidates as $file) {
            $src = (string)file_get_contents($file);
            if (strpos($src, 'DATABASES') === false) continue;
            $rel = substr($file, strlen($root) + 1);
            if (preg_match('/dj_database_url|env\.db\(|env\.db_url\(/', $src)) {
                if (!empty($v['DATABASE_URL'])) return self::fromUrl($v['DATABASE_URL'], $root) + ['source' => "$rel (DATABASE_URL)"];
                if (preg_match('/default\s*=\s*[\'"]([a-z0-9+]+:\/\/[^\'"]+|sqlite:[^\'"]+)[\'"]/i', $src, $m)) return self::fromUrl($m[1], $root) + ['source' => $rel];
            }
            $block = preg_match('/DATABASES\s*=\s*\{(.*?)\n\}/s', $src, $m) ? $m[1] : $src;
            $val = function (string $k) use ($block, $v) {
                if (!preg_match('/[\'"]' . $k . '[\'"]\s*:\s*(.+?),?\s*$/m', $block, $m)) return null;
                $expr = trim($m[1], " ,");
                if (preg_match('/^[\'"]([^\'"]*)[\'"]$/', $expr, $q)) return $q[1];
                if (preg_match('/(?:os\.environ\.get|os\.getenv|env|config|env\.str)\(\s*[\'"]([A-Za-z0-9_]+)[\'"]\s*(?:,\s*(?:default\s*=\s*)?[\'"]([^\'"]*)[\'"])?/', $expr, $q)) return $v[$q[1]] ?? ($q[2] ?? null);
                if (preg_match('/os\.environ\[\s*[\'"]([A-Za-z0-9_]+)[\'"]\s*\]/', $expr, $q)) return $v[$q[1]] ?? null;
                if (preg_match('/[\'"]([^\'"]+\.sqlite3?)[\'"]/', $expr, $q)) return $q[1];
                return null;
            };
            $engine = (string)$val('ENGINE');
            if ($engine === '') continue;
            return self::build($engine, $val('HOST'), $val('PORT'), $val('NAME'), $val('USER'), $val('PASSWORD'), $rel, $root);
        }
        return null;
    }

    private static function fromPrisma(string $root, array $v): ?array
    {
        $src = (string)file_get_contents("$root/prisma/schema.prisma");
        if (!preg_match('/datasource\s+\w+\s*\{(.*?)\}/s', $src, $m)) return null;
        $ds = $m[1];
        $provider = preg_match('/provider\s*=\s*"([^"]+)"/', $ds, $p) ? $p[1] : '';
        if (preg_match('/mongo|sqlserver|cockroach/i', $provider)) return ['error' => self::unsupported($provider)];
        if (preg_match('/url\s*=\s*env\(\s*"([A-Za-z0-9_]+)"\s*\)/', $ds, $u)) {
            if (empty($v[$u[1]])) return ['error' => "prisma/schema.prisma reads {$u[1]}, but it isn't set in .env or the environment"];
            return self::fromUrl($v[$u[1]], "$root/prisma") + ['source' => "prisma/schema.prisma ({$u[1]})"];
        }
        if (preg_match('/url\s*=\s*"([^"]+)"/', $ds, $u)) return self::fromUrl($u[1], "$root/prisma") + ['source' => 'prisma/schema.prisma'];
        return null;
    }

    private static function springValue(string $s, array $v): string
    {
        return preg_replace_callback('/\$\{([A-Za-z0-9_.]+)(?::([^}]*))?\}/', fn($m) => $v[$m[1]] ?? $v[strtoupper(str_replace('.', '_', $m[1]))] ?? ($m[2] ?? ''), trim($s, " \"'"));
    }

    private static function fromSpring(string $root, array $v): ?array
    {
        $props = []; $source = '';
        foreach (['src/main/resources/application.properties', 'application.properties'] as $f) {
            if (!is_file("$root/$f")) continue;
            foreach (file("$root/$f", FILE_IGNORE_NEW_LINES) ?: [] as $line) {
                if (preg_match('/^\s*spring\.datasource\.(url|username|password)\s*[=:]\s*(.*)$/', $line, $m)) $props[$m[1]] = self::springValue($m[2], $v);
            }
            $source = $f;
        }
        foreach (['src/main/resources/application.yml', 'src/main/resources/application.yaml', 'application.yml'] as $f) {
            if ($props || !is_file("$root/$f")) continue;
            $in = false;
            foreach (file("$root/$f", FILE_IGNORE_NEW_LINES) ?: [] as $line) {
                if (preg_match('/^\s*datasource:\s*$/', $line)) { $in = true; continue; }
                if ($in && preg_match('/^\s+(url|username|password):\s*(.*)$/', $line, $m)) $props[$m[1]] = self::springValue($m[2], $v);
                elseif ($in && preg_match('/^\S/', $line)) $in = false;
            }
            $source = $f;
        }
        if (empty($props['url'])) return null;
        if (!preg_match('#^jdbc:(\w+):(?://)?([^/:;?]+)?(?::(\d+))?/?([^?;]*)#', $props['url'], $m)) return ['error' => 'could not read spring.datasource.url'];
        if ($m[1] === 'sqlite') return self::build('sqlite', null, null, $m[4] ?: $m[2], null, null, $source, $root);
        return self::build($m[1], $m[2] ?? null, $m[3] ?? null, $m[4] ?? null, $props['username'] ?? null, $props['password'] ?? null, $source, $root);
    }

    private static function fromDotnet(string $root): ?array
    {
        $j = json_decode((string)file_get_contents("$root/appsettings.json"), true);
        $cs = is_array($j['ConnectionStrings'] ?? null) ? array_values($j['ConnectionStrings']) : [];
        if (!$cs || !is_string($cs[0])) return null;
        $kv = [];
        foreach (explode(';', $cs[0]) as $part) {
            if (strpos($part, '=') === false) continue;
            [$k, $val] = array_map('trim', explode('=', $part, 2));
            $kv[strtolower(str_replace(' ', '', $k))] = $val;
        }
        if (isset($kv['initialcatalog']) || isset($kv['trusted_connection']) || isset($kv['multipleactiveresultsets'])) return ['error' => self::unsupported('sqlserver')];
        if (isset($kv['datasource']) && preg_match('/\.(db|sqlite3?)$/i', $kv['datasource'])) return self::build('sqlite', null, null, $kv['datasource'], null, null, 'appsettings.json', $root);
        $driver = isset($kv['host']) ? 'pgsql' : 'mysql'; // Npgsql uses Host=, MySqlConnector uses Server=
        return self::build($driver, $kv['host'] ?? $kv['server'] ?? null, $kv['port'] ?? null, $kv['database'] ?? null,
            $kv['userid'] ?? $kv['uid'] ?? $kv['username'] ?? $kv['user'] ?? null, $kv['password'] ?? $kv['pwd'] ?? null, 'appsettings.json', $root);
    }

    /** Node, Go, Python, Rust... anything with DATABASE_URL or the usual DB_* names. */
    private static function fromVars(array $v, string $root): ?array
    {
        foreach (['DATABASE_URL', 'DB_URL', 'MYSQL_URL', 'POSTGRES_URL', 'POSTGRESQL_URL', 'PG_URL', 'JDBC_DATABASE_URL'] as $k) {
            if (!empty($v[$k])) return self::fromUrl(preg_replace('/^jdbc:/', '', $v[$k]), $root) + ['source' => $k];
        }
        if (!empty($v['MONGO_URL']) || !empty($v['MONGODB_URI']) || !empty($v['MONGO_URI'])) return ['error' => self::unsupported('mongodb')];
        $pick = function (array $names) use ($v) { foreach ($names as $n) if (isset($v[$n]) && $v[$n] !== '') return $v[$n]; return null; };
        $db = $pick(['DB_DATABASE', 'DB_NAME', 'DATABASE_NAME', 'MYSQL_DATABASE', 'PGDATABASE', 'POSTGRES_DB']);
        if ($db === null) return null;
        $driver = $pick(['DB_CONNECTION', 'DB_DIALECT', 'DB_DRIVER', 'DB_TYPE', 'DB_CLIENT', 'DB_ENGINE']) ?? (isset($v['PGDATABASE']) || isset($v['POSTGRES_DB']) ? 'pgsql' : 'mysql');
        return self::build($driver, $pick(['DB_HOST', 'DATABASE_HOST', 'MYSQL_HOST', 'PGHOST', 'POSTGRES_HOST']), $pick(['DB_PORT', 'DATABASE_PORT', 'MYSQL_PORT', 'PGPORT', 'POSTGRES_PORT']), $db,
            $pick(['DB_USERNAME', 'DB_USER', 'DATABASE_USER', 'MYSQL_USER', 'PGUSER', 'POSTGRES_USER']), $pick(['DB_PASSWORD', 'DB_PASS', 'DATABASE_PASSWORD', 'MYSQL_PASSWORD', 'PGPASSWORD', 'POSTGRES_PASSWORD']), '.env', $root);
    }
}
