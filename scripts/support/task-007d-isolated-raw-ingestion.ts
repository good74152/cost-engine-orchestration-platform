import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';

// This launcher is for the legacy raw-ingestion test, which has no own DB fixture.
// It NEVER passes a developer's source DATABASE_URL to that test subprocess.
const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required for isolated raw-ingestion tests');

const name = `raw_milestone_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
assert.match(name, /^raw_milestone_test_[a-z0-9_]+$/);
assert.ok(name.length <= 63);
function urlFor(database: string): string {
  const url = new URL(source!);
  url.pathname = '/' + database;
  return url.toString();
}
const admin = new Client({ connectionString: urlFor('postgres') });
let created = false;
let childExit = 1;
let cleanupFailed = false;
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  created = true;
  await runner({ databaseUrl: urlFor(name),
    dir: fileURLToPath(new URL('../../migrations/', import.meta.url)),
    migrationsTable: 'pgmigrations', direction: 'up', singleTransaction: true,
    checkOrder: true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const server = await admin.query<{ server_version: string }>('SHOW server_version');
  console.log(`RAW_ISOLATED_DB ${JSON.stringify({ name, version: server.rows[0]!.server_version,
    setup: 'owned temporary database; all migrations applied' })}`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmCli = process.env.npm_execpath;
  childExit = await new Promise<number>((resolve) => {
    const child = spawn(npmCli ? process.execPath : npm,
      [...(npmCli ? [npmCli] : []), 'run', 'test:raw-ingestion'], {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: urlFor(name),
        TEST_DATABASE_URL: urlFor(name), NODE_ENV: 'test' },
    });
    let spawnFailed = false;
    child.once('error', (error) => { console.error('RAW_TEST_SPAWN_ERROR', error.message); spawnFailed = true; });
    child.once('close', (code, signal) => {
      if (signal) console.error('RAW_TEST_SIGNAL', signal);
      resolve(spawnFailed || signal ? 1 : code ?? 1);
    });
  });
} finally {
  try {
    if (created) {
      assert.match(name, /^raw_milestone_test_[a-z0-9_]+$/);
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      console.log('RAW_ISOLATED_TEARDOWN', JSON.stringify({ name, result: 'dropped' }));
    }
  } catch (error) {
    cleanupFailed = true;
    console.error('RAW_ISOLATED_TEARDOWN_FAILURE', error);
  } finally {
    await admin.end();
  }
}
if (cleanupFailed || childExit !== 0) process.exitCode = childExit || 1;
