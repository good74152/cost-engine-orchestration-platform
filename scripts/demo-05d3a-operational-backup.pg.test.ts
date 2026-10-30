import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { runner } from 'node-pg-migrate';
import { Client, Pool } from 'pg';
import { beginOperationalBackup, verifyOperationalDatabase } from '../src/deployment/operational-backup.js';
import { firstDeploymentBusinessTables } from '../src/deployment/cutover-preflight.js';
import { DemoCutoverOperator } from '../src/modules/demo-cutover/demo-cutover.operator.js';
import { DemoSessionService } from '../src/modules/demo-session/demo-session.service.js';
import { seedDemoSixDomainConfiguration } from './seed-demo-six-domain-configuration.js';
import { operationalDataFixture } from './support/demo-05d3a-data-fixture.js';

const source = process.env.TEST_DATABASE_URL;
if (!source) throw new Error('Operational tests require explicit disposable TEST_DATABASE_URL');
const connection = (name: string) => { const u = new URL(source!); u.pathname = '/' + name; return u.toString(); };

test('Demo-05D-3A PostgreSQL: online snapshot, stored integrity and compatible business locks', { timeout: 600000 }, async t => {
  const admin = new Client({ connectionString: connection('postgres') }); await admin.connect();
  const names: string[] = [], pools: Pool[] = []; const prior = { ...process.env };
  process.env.APP_MODE = 'demo'; process.env.NODE_ENV = 'test'; process.env.EXECUTOR_TYPE = 'fake';
  const fixture = async (mode = 'WORKFLOW_OPEN') => {
    const name = 'demo05d3a_' + randomUUID().replaceAll('-', ''); names.push(name);
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    await runner({ databaseUrl: connection(name), dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', singleTransaction: true,
      logger: { debug() {}, info() {}, warn() {}, error() {} } });
    const db = new Pool({ connectionString: connection(name), max: 8 }); pools.push(db);
    await seedDemoSixDomainConfiguration(db);
    if (mode !== 'LEGACY_OPEN') await db.query("UPDATE demo_admission_control SET state='DRAINING'");
    if (mode === 'WORKFLOW_OPEN') await new DemoCutoverOperator(db).cutover();
    return { db, name, run: () => verifyOperationalDatabase(db, 'demo05d3a-test') };
  };
  const reject = (f: Awaited<ReturnType<typeof fixture>>) => assert.rejects(f.run(), e => {
    assert.ok(e instanceof Error); assert.equal(e.message, 'Operational backup validation failed; no backup or recovery is confirmed'); return true;
  });
  const barrier = async (db: Pool, pid: number, sql: string) => {
    const deadline = Date.now() + 8000;
    for (;;) {
      const row = (await db.query('SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1 AND query LIKE $2', [pid, sql])).rows[0];
      if (row?.wait_event_type === 'Lock' && row.blockers.length) return;
      assert.ok(Date.now() < deadline, 'Expected explicit PostgreSQL lock barrier'); await setImmediate();
    }
  };
  try {
    await t.test('exact WORKFLOW_OPEN configuration, six domains and ten Types pass without requiring empty tables', async () => {
      const f = await fixture(); const seeded = await operationalDataFixture(f.db); const before = await f.run();
      assert.equal(before.admissionState, 'WORKFLOW_OPEN'); assert.equal(before.configuration, 'WORKFLOW'); assert.equal(before.migrations.length, 14);
      assert.equal(before.counts.demo_sessions, 1); assert.equal(before.counts.dataset_versions, 6); assert.equal(before.counts.calculation_jobs, 10);
      assert.equal(before.counts.execution_attempts, 10); assert.equal(before.counts.dataset_build_snapshots, 6); assert.equal(before.counts.dataset_build_snapshot_dependencies, 5);
      assert.deepEqual(await f.run(), before); assert.equal(seeded.versions.CAPEX!.jobs.length, 2);
    });
    for (const mode of ['LEGACY_OPEN', 'DRAINING']) await t.test(mode + ' refuses operational backup', async () => { await reject(await fixture(mode)); });
    await t.test('WORKFLOW_OPEN with complete-configuration conflict fails closed without repair', async () => {
      const f = await fixture(); await f.db.query("UPDATE calculation_types SET airflow_dag_id='corrupt' WHERE code='DEMO_CAPEX_TABLE_Y'"); await reject(f);
      assert.equal((await f.db.query("SELECT airflow_dag_id FROM calculation_types WHERE code='DEMO_CAPEX_TABLE_Y'")).rows[0].airflow_dag_id, 'corrupt');
    });
    await t.test('actual FK orphans fail even if an administrator previously bypassed FK triggers', async () => {
      const f = await fixture(); const c = await f.db.connect();
      try { await c.query("SET session_replication_role='replica'"); await c.query(`INSERT INTO dataset_versions(id,dataset_series_id,version,status) VALUES(gen_random_uuid(),gen_random_uuid(),1,'DRAFT')`); }
      finally { await c.query("SET session_replication_role='origin'"); c.release(); } await reject(f);
    });
    await t.test('attempts without immutable build snapshot are rejected without executor recovery', async () => {
      const f = await fixture(); const data = await operationalDataFixture(f.db);
      await f.db.query('DELETE FROM dataset_build_snapshot_dependencies'); await f.db.query('DELETE FROM dataset_build_snapshots WHERE dataset_version_id=$1', [data.versions.FAB_COST!.version]); await reject(f);
    });
    await t.test('missing frozen dependency or its required membership FK fails closed', async () => {
      const f = await fixture(); const data = await operationalDataFixture(f.db);
      await f.db.query('DELETE FROM dataset_build_snapshot_dependencies WHERE snapshot_id IN (SELECT id FROM dataset_build_snapshots WHERE dataset_version_id=$1)', [data.versions.CAPEX!.version]);
      await reject(f);
      const g = await fixture(); const key = (await g.db.query("SELECT conname FROM pg_constraint WHERE conrelid='dataset_build_snapshot_dependencies'::regclass AND contype='f' AND confrelid='dataset_build_snapshots'::regclass")).rows[0].conname as string;
      assert.match(key, /^[a-z_]+$/); await g.db.query(`ALTER TABLE dataset_build_snapshot_dependencies DROP CONSTRAINT "${key}"`); await reject(g);
    });
    await t.test('same row counts cannot substitute for complete data integrity evidence', async () => {
      const f = await fixture(); await operationalDataFixture(f.db); const before = await f.run();
      await f.db.query("UPDATE execution_attempts SET last_dispatch_error='changed persisted history'"); const after = await f.run();
      assert.deepEqual(after.counts, before.counts); assert.equal(after.schemaSha256, before.schemaSha256); assert.notEqual(after.dataSha256, before.dataSha256);
    });
    await t.test('database DML-denying triggers prove validation never modifies business, Session, Gate or Configuration', async () => {
      const f = await fixture(); await operationalDataFixture(f.db); const before = await f.run();
      await f.db.query("CREATE FUNCTION forbid_operational_writes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Unexpected write'; END $$");
      for (const table of [...firstDeploymentBusinessTables.filter(n => !n.startsWith('raw_dpr_')), 'calculation_types', 'execution_dependency_definition_versions', 'execution_dependency_definition_dependencies', 'demo_admission_control', 'pgmigrations']) {
        await f.db.query(`CREATE TRIGGER forbid_operational_writes BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION forbid_operational_writes()`);
      }
      const after = await f.run(); assert.equal(after.dataSha256, before.dataSha256); assert.deepEqual(after.counts, before.counts);
      assert.equal(after.configurationSha256, before.configurationSha256); assert.equal(after.admissionUpdatedAt, before.admissionUpdatedAt);
    });
    await t.test('same-name weakened index and CHECK definitions remain protected by shared Schema verifier', async () => {
      for (const sql of ["DROP INDEX uq_execution_attempt_active_job; CREATE UNIQUE INDEX uq_execution_attempt_active_job ON execution_attempts(calculation_job_id) WHERE status='PREPARED'",
        'ALTER TABLE demo_sessions DROP CONSTRAINT ck_demo_sessions_hash; ALTER TABLE demo_sessions ADD CONSTRAINT ck_demo_sessions_hash CHECK (true)']) {
        const f = await fixture(); await f.db.query(sql); await reject(f);
      }
    });
    await t.test('missing migration inventory fails closed', async () => { const f = await fixture(); await f.db.query('DELETE FROM pgmigrations WHERE id=(SELECT max(id) FROM pgmigrations)'); await reject(f); });
    await t.test('one exported snapshot excludes commits after export while all ordinary business locks remain available', async () => {
      const f = await fixture(); const data = await operationalDataFixture(f.db); const holder = await f.db.connect(), importer = await f.db.connect();
      try {
        const before = await beginOperationalBackup(holder, 'demo05d3a-test');
        const snapshot = (await holder.query('SELECT pg_export_snapshot() AS id')).rows[0].id as string;
        // Includes the production Session capacity table lock, not just a direct INSERT.
        await new DemoSessionService(f.db, { capacity: { active: 100, retained: 1000 } }).create();
        await f.db.query('UPDATE execution_attempts SET last_dispatch_error=$1 WHERE calculation_job_id=$2', ['concurrent metadata', data.versions.FAB_COST!.jobs[0]]);
        await importer.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await importer.query(`SET TRANSACTION SNAPSHOT '${snapshot}'`);
        assert.equal((await importer.query('SELECT count(*) AS n FROM demo_sessions')).rows[0].n, String(before.counts.demo_sessions));
        assert.equal((await importer.query('SELECT last_dispatch_error FROM execution_attempts WHERE calculation_job_id=$1', [data.versions.FAB_COST!.jobs[0]])).rows[0].last_dispatch_error, null);
        assert.equal((await f.db.query('SELECT count(*) AS n FROM demo_sessions')).rows[0].n, '2');
      } finally { await importer.query('ROLLBACK'); importer.release(true); await holder.query('ROLLBACK'); holder.release(true); }
    });
    for (const [label, query] of [
      ['Configuration mutation', "UPDATE calculation_types SET is_active=false WHERE code='DEMO_CAPEX_TABLE_Y'"],
      ['Migration inventory mutation', 'DELETE FROM pgmigrations'],
      ['incompatible DDL', 'ALTER TABLE dataset_versions ADD COLUMN test_incompatible integer'],
      ['Cutover Gate lock', 'SELECT id FROM demo_admission_control FOR UPDATE'],
    ]) await t.test(label + ' waits behind the snapshot transaction; rollback releases every lock', async () => {
      const f = await fixture(), holder = await f.db.connect(), other = await f.db.connect(); let waiting: Promise<unknown> | undefined;
      try {
        await beginOperationalBackup(holder, 'demo05d3a-test'); await other.query('BEGIN'); const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        waiting = other.query(query!); waiting.catch(() => {}); await barrier(f.db, pid, query! + '%');
        await holder.query('ROLLBACK'); await waiting; await other.query('ROLLBACK'); assert.equal((await f.run()).result, 'PASS');
      } finally { await holder.query('ROLLBACK').catch(() => {}); await other.query('ROLLBACK').catch(() => {}); await waiting?.catch(() => {}); holder.release(true); other.release(true); }
    });
    await t.test('bounded lock timeout, rollback and sanitized failure preserve retry eligibility', async () => {
      const f = await fixture(), blocker = await f.db.connect(); await blocker.query('BEGIN'); await blocker.query('SELECT id FROM demo_admission_control FOR UPDATE');
      try { const start = Date.now(); await reject(f); assert.ok(Date.now() - start >= 2800); assert.ok(Date.now() - start < 8000); }
      finally { await blocker.query('ROLLBACK'); blocker.release(true); } assert.equal((await f.run()).result, 'PASS');
    });
    await t.test('database unavailable never returns PASS', async () => {
      const db = new Pool({ host: '127.0.0.1', port: 1, database: 'unavailable', connectionTimeoutMillis: 100 });
      try { await assert.rejects(verifyOperationalDatabase(db, 'test')); } finally { await db.end(); }
    });
  } finally {
    for (const db of pools) await db.end();
    for (const name of names) { assert.match(name, /^demo05d3a_[a-f0-9]{32}$/); await admin.query(`DROP DATABASE "${name}"`); }
    await admin.end(); for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key]; Object.assign(process.env, prior);
    console.info('DEMO05D3A_PG_TEARDOWN', JSON.stringify({ databases: names.length, dropped: true, production: false }));
  }
});
