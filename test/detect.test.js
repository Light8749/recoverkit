// Finding the database login from any framework's own config files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const CONNECTOR = join(dirname(fileURLToPath(import.meta.url)), '../sdk/php/recoverkit-connector.php');
const base = mkdtempSync(join(tmpdir(), 'rk-detect-'));

function app(name, files) {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
const detect = (root, env = {}) => JSON.parse(execFileSync('php', [CONNECTOR, 'detect', root], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
// The PHP detector also returns the password internally; the CLI hides it. Check user + DSN.

test.after(() => rmSync(base, { recursive: true, force: true }));

test('Laravel .env', () => {
  const r = detect(app('laravel', { artisan: '', '.env': 'APP_NAME=Shop\nDB_CONNECTION=mysql\nDB_HOST=10.0.0.5\nDB_PORT=3307\nDB_DATABASE=vtu\nDB_USERNAME=app\nDB_PASSWORD="p#ss word"\n' }));
  assert.equal(r.dsn, 'mysql:host=10.0.0.5;port=3307;dbname=vtu');
  assert.equal(r.user, 'app');
  assert.equal(r.framework, 'Laravel');
  assert.equal(r.pass, undefined, 'password never printed');
});

test('WordPress / WooCommerce wp-config.php, host with port, table prefix', () => {
  const r = detect(app('wp', { 'wp-config.php': "<?php\ndefine( 'DB_NAME', 'shop_wp' );\ndefine( 'DB_USER', 'wpuser' );\ndefine( 'DB_PASSWORD', 'it\\'s secret' );\ndefine( 'DB_HOST', 'localhost:3307' );\n$table_prefix = 'wpx_';\n" }));
  assert.equal(r.dsn, 'mysql:host=localhost;port=3307;dbname=shop_wp');
  assert.equal(r.user, 'wpuser');
  assert.equal(r.tablePrefix, 'wpx_');
});

test('Rails database.yml with anchors and ERB', () => {
  const yml = `default: &default\n  adapter: mysql2\n  host: <%= ENV.fetch("DB_HOST") { "localhost" } %>\n  username: rails\n  password: <%= ENV['DB_PASSWORD'] %>\n\ndevelopment:\n  <<: *default\n  database: shop_dev\n\nproduction:\n  <<: *default\n  database: shop_prod\n`;
  const r = detect(app('rails', { 'config/database.yml': yml }), { DB_HOST: 'db.internal' });
  assert.equal(r.dsn, 'mysql:host=db.internal;port=3306;dbname=shop_prod');
  assert.equal(r.user, 'rails');
});

test('Django settings.py reading environment variables', () => {
  const settings = `import os\nDATABASES = {\n    'default': {\n        'ENGINE': 'django.db.backends.postgresql',\n        'NAME': os.environ.get('POSTGRES_DB', 'shop'),\n        'USER': os.getenv('POSTGRES_USER'),\n        'PASSWORD': os.environ['POSTGRES_PASSWORD'],\n        'HOST': 'db',\n        'PORT': '5433',\n    }\n}\n`;
  const r = detect(app('django', { 'manage.py': '', 'shop/settings.py': settings, '.env': 'POSTGRES_USER=django\nPOSTGRES_PASSWORD=x\n' }));
  assert.equal(r.dsn, 'pgsql:host=db;port=5433;dbname=shop');
  assert.equal(r.user, 'django');
  assert.equal(r.framework, 'Django');
});

test('Django with dj_database_url', () => {
  const r = detect(app('django2', { 'core/settings.py': "import dj_database_url\nDATABASES = {'default': dj_database_url.config()}\n", '.env': 'DATABASE_URL=postgres://u:p%40ss@pg.example:5432/app\n' }));
  assert.equal(r.dsn, 'pgsql:host=pg.example;port=5432;dbname=app');
  assert.equal(r.user, 'u');
});

test('Node + Prisma (env and SQLite file)', () => {
  let r = detect(app('prisma', { 'package.json': '{}', 'prisma/schema.prisma': 'datasource db {\n  provider = "mysql"\n  url      = env("DATABASE_URL")\n}\n', '.env': 'DATABASE_URL="mysql://shop:pw@127.0.0.1:3306/shop"\n' }));
  assert.equal(r.dsn, 'mysql:host=127.0.0.1;port=3306;dbname=shop');
  assert.equal(r.framework, 'Prisma');
  r = detect(app('prisma-sqlite', { 'prisma/schema.prisma': 'datasource db {\n  provider = "sqlite"\n  url = "file:./dev.db"\n}\n' }));
  assert.equal(r.dsn, `sqlite:${join(base, 'prisma-sqlite/prisma/dev.db')}`);
});

test('Spring Boot application.properties with ${VAR:default}', () => {
  const props = 'spring.datasource.url=jdbc:mysql://${DB_HOST:localhost}:3306/vtu?useSSL=false\nspring.datasource.username=${DB_USER:spring}\nspring.datasource.password=${DB_PASS}\n';
  const r = detect(app('spring', { 'pom.xml': '', 'src/main/resources/application.properties': props }), { DB_HOST: 'mysql.svc' });
  assert.equal(r.dsn, 'mysql:host=mysql.svc;port=3306;dbname=vtu');
  assert.equal(r.user, 'spring');
});

test('Spring Boot application.yml (PostgreSQL)', () => {
  const yml = 'spring:\n  datasource:\n    url: jdbc:postgresql://pg:5432/bank\n    username: bank\n    password: secret\n';
  const r = detect(app('spring-yml', { 'src/main/resources/application.yml': yml }));
  assert.equal(r.dsn, 'pgsql:host=pg;port=5432;dbname=bank');
});

test('ASP.NET appsettings.json (MySQL, PostgreSQL) and SQL Server refused clearly', () => {
  let r = detect(app('dotnet', { 'appsettings.json': JSON.stringify({ ConnectionStrings: { Default: 'Server=10.1.1.1;Port=3306;Database=fin;User Id=fin;Password=x;' } }) }));
  assert.equal(r.dsn, 'mysql:host=10.1.1.1;port=3306;dbname=fin');
  r = detect(app('dotnet-pg', { 'appsettings.json': JSON.stringify({ ConnectionStrings: { Default: 'Host=pg;Database=fin;Username=fin;Password=x' } }) }));
  assert.equal(r.dsn, 'pgsql:host=pg;port=5432;dbname=fin');
  r = detect(app('dotnet-mssql', { 'appsettings.json': JSON.stringify({ ConnectionStrings: { Default: 'Server=.;Initial Catalog=fin;Trusted_Connection=True;' } }) }));
  assert.match(r.error, /SQL Server is not supported yet/);
});

test('Go / Python / any app: DATABASE_URL or DB_* in .env', () => {
  let r = detect(app('go', { 'go.mod': '', '.env': 'export DATABASE_URL=postgresql://svc:pw@10.2.0.9/payments\n' }));
  assert.equal(r.dsn, 'pgsql:host=10.2.0.9;port=5432;dbname=payments');
  r = detect(app('flask', { '.env': 'DB_HOST=127.0.0.1 # local\nDB_NAME=flaskshop\nDB_USER=flask\nDB_PASSWORD=pw\n' }));
  assert.equal(r.dsn, 'mysql:host=127.0.0.1;port=3306;dbname=flaskshop');
  r = detect(app('pg-env', {}), { PGHOST: 'pg', PGDATABASE: 'loans', PGUSER: 'x' });
  assert.equal(r.dsn, 'pgsql:host=pg;port=5432;dbname=loans');
});

test('MongoDB apps get a clear "not supported yet"', () => {
  assert.match(detect(app('mongo', { '.env': 'MONGODB_URI=mongodb+srv://u:p@cluster0.example/shop\n' })).error, /MongoDB is not supported yet/);
  assert.match(detect(app('mongo2', { '.env': 'DATABASE_URL=mongodb://u:p@h/db\n' })).error, /MongoDB is not supported yet/);
});

test('nothing found: helpful message', () => {
  assert.match(detect(app('empty', { 'README.md': 'hi' })).error, /Set RK_DB_DSN/);
});
