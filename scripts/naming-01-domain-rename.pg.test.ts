import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import { FakeExecutor } from '../src/executors/fake-executor.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Naming-01 requires a disposable PostgreSQL test service');
const migrationName = '1793200000000_rename-cowos-s-to-e2e-cost';
function connection(name: string) {
  const url = new URL(source!); url.pathname = '/' + name; return url.toString();
}
function migrate(databaseUrl: string, direction: 'up' | 'down' = 'up', count?: number, timestamp = false) {
  return runner({ databaseUrl, dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
    migrationsTable: 'pgmigrations', direction, count, timestamp, singleTransaction: true,
    checkOrder: true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
}
async function fixture(run: (db: Client, url: string) => Promise<void>, legacy = true) {
  const name = `naming_01_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(name, /^naming_01_test_[a-f0-9]{32}$/);
  const admin = new Client({ connectionString: connection('postgres') });
  const db = new Client({ connectionString: connection(name) });
  let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    await migrate(connection(name), 'up', legacy ? 1793100000000 : undefined, legacy);
    await db.connect();
    await run(db, connection(name));
  } finally {
    await db.end();
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}
async function dump(db: Client) {
  const tables = (await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const { tablename } of tables) {
    const table = '"' + tablename.replaceAll('"', '""') + '"';
    result[tablename] = (await db.query(`SELECT to_jsonb(r) AS row FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows.map(r => r.row);
  }
  return result;
}
function sorted(rows: Record<string, unknown>[]) {
  return rows.map(row => JSON.stringify(row)).sort();
}
async function seed(db: Client) {
  const types: Record<string, string> = {}, series: Record<string, string> = {}, versions: Record<string, string> = {};
  const definitions: Record<string, string> = {};
  for (const domain of ['CAPEX', 'COWOS_S', 'DPR']) {
    types[domain] = (await db.query(`INSERT INTO calculation_types(domain,code,airflow_dag_id,
      last_allocated_dependency_definition_version) VALUES($1,'SUMMARY',$2,3) RETURNING id`,
      [domain, `existing_${domain}_dag`])).rows[0].id;
    for (const [index, status] of ['PUBLISHED', 'ABANDONED', 'DRAFT'].entries()) {
      const id = (await db.query(`INSERT INTO execution_dependency_definition_versions
        (calculation_type_id,version,status,published_at) VALUES($1,$2,$3::text,CASE WHEN $3='PUBLISHED' THEN now() END) RETURNING id`,
        [types[domain], index + 1, status])).rows[0].id;
      if (index === 0) definitions[domain] = id;
      if (domain !== 'CAPEX') await db.query(`INSERT INTO execution_dependency_definition_dependencies VALUES($1,$2)`,
        [id, domain === 'DPR' ? 'COWOS_S' : 'CAPEX']);
    }
    series[domain] = (await db.query(`INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period,
      last_allocated_version,legacy_business_key) VALUES(gen_random_uuid(),$1,'TW01',2026,'Q4',$2,'TW01:2026:Q4') RETURNING id`,
      [domain, domain === 'COWOS_S' ? 4 : 1])).rows[0].id;
    const statuses = domain === 'COWOS_S' ? ['PUBLISHED', 'REJECTED', 'ABANDONED', 'PUBLISHED'] : ['PUBLISHED'];
    for (const [index, status] of statuses.entries()) {
      const version = (await db.query(`INSERT INTO dataset_versions(id,dataset_series_id,version,status,
        published_at,rejected_at,abandoned_at) VALUES(gen_random_uuid(),$1,$2,$3::text,
        CASE WHEN $3='PUBLISHED' THEN now() END,CASE WHEN $3='REJECTED' THEN now() END,
        CASE WHEN $3='ABANDONED' THEN now() END) RETURNING id`, [series[domain], index + 1, status])).rows[0].id;
      versions[domain] = version;
      const job = (await db.query(`INSERT INTO calculation_jobs(id,output_dataset_version_id,calculation_type_id,
        resolved_dependency_definition_version_id,status,finished_at) VALUES(gen_random_uuid(),$1,$2,$3,'SUCCEEDED',now()) RETURNING id`,
        [version, types[domain], definitions[domain]])).rows[0].id;
      const snapshot = (await db.query('INSERT INTO dataset_build_snapshots(dataset_version_id) VALUES($1) RETURNING id', [version])).rows[0].id;
      if (domain !== 'CAPEX') {
        const upstream = domain === 'DPR' ? 'COWOS_S' : 'CAPEX';
        await db.query('INSERT INTO dataset_build_snapshot_dependencies VALUES($1,$2,$3)',
          [snapshot, series[upstream], versions[upstream]]);
      }
      // Preserve a failed execution followed by a success, including old spelling
      // inside external IDs and historical error text (not Domain columns).
      for (const [i, state] of ['FAILED', 'SUCCEEDED'].entries()) await db.query(`INSERT INTO execution_attempts
        (calculation_job_id,attempt_number,status,airflow_dag_id,airflow_dag_run_id,finished_at,last_dispatch_error)
        VALUES($1,$2,$3,$4,$5,now(),'Historical COWOS_S executor observation')`,
        [job, i + 1, state, `existing_${domain}_dag`, `COWOS_S_${randomUUID()}`]);
    }
  }
  const inactive = (await db.query(`INSERT INTO calculation_types(domain,code,airflow_dag_id,is_active)
    VALUES('COWOS_S','LEGACY_DEFAULT','legacy_cowos_s',false) RETURNING id`)).rows[0].id;
  await db.query('INSERT INTO orchestration_v2_legacy_calculation_type_bridges VALUES($1)', [inactive]);
  return { types, series, versions, definitions };
}

test('Naming-01 real PostgreSQL migration and API contracts', { timeout: 240_000 }, async t => {
  await t.test('fresh install, no-data down and reapply', () => fixture(async (db, url) => {
    assert.equal((await db.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n, 12);
    await migrate(url, 'down', 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n, 11);
    await migrate(url);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n, 12);
  }, false));

  await t.test('populated upgrade changes only the three Domain columns and is repeatable', () => fixture(async (db, url) => {
    await seed(db);
    // Compatible target data in a different scope/code is retained, never merged.
    await db.query(`INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period)
      VALUES(gen_random_uuid(),'E2E_COST','TW02',2026,'Q4')`);
    await db.query(`INSERT INTO calculation_types(domain,code,airflow_dag_id)
      VALUES('E2E_COST','OTHER','already_configured_dag')`);
    const before = await dump(db);
    await migrate(url);
    const after = await dump(db);
    for (const [table, rows] of Object.entries(before)) {
      if (table === 'pgmigrations') continue;
      const field = table === 'dataset_series' || table === 'calculation_types' ? 'domain'
        : table === 'execution_dependency_definition_dependencies' ? 'required_domain' : undefined;
      const expected = rows.map(row => field && row[field] === 'COWOS_S' ? { ...row, [field]: 'E2E_COST' } : row);
      assert.deepEqual(sorted(after[table]!), sorted(expected), table);
    }
    assert.equal(after.pgmigrations!.length, before.pgmigrations!.length + 1);
    await migrate(url); assert.deepEqual(await dump(db), after);
    await assert.rejects(migrate(url, 'down', 1), /cannot reverse retained E2E_COST/);
    assert.deepEqual(await dump(db), after);
  }));

  const conflicts = [
    { name: 'canonical identity', sql: `INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period)
      VALUES(gen_random_uuid(),'E2E_COST','TW01',2026,'Q4')` },
    { name: 'legacy business key', sql: `INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period,legacy_business_key)
      VALUES(gen_random_uuid(),'E2E_COST','TW02',2026,'Q4','TW01:2026:Q4')` },
    { name: 'calculation_types domain/code', sql: `INSERT INTO calculation_types(domain,code,airflow_dag_id,is_active)
      VALUES('E2E_COST','SUMMARY','different_mapping',false)` },
    { name: 'dependency definition required domain', sql: `INSERT INTO execution_dependency_definition_dependencies
      SELECT id,'E2E_COST' FROM execution_dependency_definition_versions WHERE status='ABANDONED'
      AND calculation_type_id IN (SELECT id FROM calculation_types WHERE domain='DPR')` },
  ];
  for (const conflict of conflicts) await t.test(`conflict in ${conflict.name} preserves every row and migration marker`, () => fixture(async (db, url) => {
    await seed(db); await db.query(conflict.sql); const before = await dump(db);
    await assert.rejects(migrate(url), error => (error as Error).message.includes(`Naming-01 conflict: ${conflict.name === 'canonical identity' || conflict.name === 'legacy business key' ? 'dataset_series ' : ''}${conflict.name}`));
    assert.deepEqual(await dump(db), before);
  }));

  await t.test('failure after the first two updates rolls back all writes and the migration marker', () => fixture(async (db, url) => {
    await seed(db);
    await db.query(`CREATE FUNCTION naming_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected late update failure'; END $$;
      CREATE TRIGGER naming_test_failure BEFORE UPDATE ON execution_dependency_definition_dependencies
      FOR EACH ROW EXECUTE FUNCTION naming_test_failure()`);
    const before = await dump(db);
    await assert.rejects(migrate(url), /injected late update failure/);
    assert.deepEqual(await dump(db), before);
    await db.query('DROP TRIGGER naming_test_failure ON execution_dependency_definition_dependencies');
    await migrate(url);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM pgmigrations WHERE name=$1', [migrationName])).rows[0].n, 1);
  }));

  await t.test('table locks wait for an in-flight writer and preflight sees its committed conflict', () => fixture(async (db, url) => {
    await seed(db);
    await db.query('BEGIN');
    await db.query(conflicts[0]!.sql);
    const before = await dump(db);
    const migrationUrl = new URL(url);
    migrationUrl.searchParams.set('application_name', 'naming_01_lock_test');
    const pending = migrate(migrationUrl.toString()).then(() => null, (error: Error) => error);
    try {
      const deadline = Date.now() + 10_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const locks = await db.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND application_name='naming_01_lock_test' AND wait_event_type='Lock'`);
        if (locks.rowCount) { waiting = true; break; }
        // Clear the transaction's statistics snapshot before the next observation.
        await db.query('SELECT pg_stat_clear_snapshot()');
        await setTimeout(20);
      }
      assert.ok(waiting, 'migration must wait for the concurrent writer before preflight');
      await db.query('COMMIT');
      const error = await pending;
      assert.ok(error); assert.match(error.message, /Naming-01 conflict: dataset_series canonical identity/);
      assert.deepEqual(await dump(db), before);
    } finally {
      await db.query('ROLLBACK');
      await pending;
    }
  }));

  for (const table of ['dataset_series', 'calculation_types', 'execution_dependency_definition_dependencies']) {
    await t.test(`down refuses target data present only in ${table}`, () => fixture(async (db, url) => {
      await migrate(url);
      if (table === 'dataset_series') await db.query(`INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period)
        VALUES(gen_random_uuid(),'E2E_COST','TW01',2026,'Q4')`);
      else if (table === 'calculation_types') await db.query(`INSERT INTO calculation_types(domain,code,airflow_dag_id) VALUES('E2E_COST','X','x')`);
      else await db.query(`WITH ct AS (INSERT INTO calculation_types(domain,code,airflow_dag_id) VALUES('DPR','X','x') RETURNING id),
        d AS (INSERT INTO execution_dependency_definition_versions(calculation_type_id,version,status) SELECT id,1,'PUBLISHED' FROM ct RETURNING id)
        INSERT INTO execution_dependency_definition_dependencies SELECT id,'E2E_COST' FROM d`);
      const before = await dump(db);
      await assert.rejects(migrate(url, 'down', 1), /cannot reverse retained E2E_COST/);
      assert.deepEqual(await dump(db), before);
    }));
  }

  await t.test('Core and authenticated Demo accept only E2E_COST; migrated configuration and dependencies remain usable', () => fixture(async (db, url) => {
    const old = await seed(db); await migrate(url);
    const previous = { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: process.env.NODE_ENV };
    process.env.DATABASE_URL = url; process.env.NODE_ENV = 'test';
    const [{ pool }, { buildApp }, { DemoRuntime }] = await Promise.all([
      import('../src/db/pool.js'), import('../src/app.js'), import('../src/modules/demo-session/demo-runtime.js'),
    ]);
    const ends: Promise<void>[] = [];
    pool.on('connect', c => ends.push(new Promise<void>(resolve => c.once('end', resolve))));
    const fake = new FakeExecutor();
    const core = await buildApp({ appMode: 'core', logger: false, nodeEnvironment: 'test', calculationExecutor: fake });
    const runtime = new DemoRuntime(pool, 'test');
    const demo = await buildApp({ appMode: 'demo', logger: false, nodeEnvironment: 'test', demoRuntime: runtime,
      demoSession: { origin: 'https://demo.test' } });
    try {
      const post = (domain: string) => core.inject({ method: 'POST', url: '/dataset-versions',
        payload: { domain, companyCode: 'TW01', fiscalYear: 2026, period: 'Q4' } });
      const beforeInvalid = await dump(db);
      for (const domain of ['COWOS_S', 'COWOS-S', 'e2e_cost', 'E2E-COST']) {
        const response = await post(domain);
        assert.equal(response.statusCode, 400); assert.equal(response.json().code, 'INVALID_DOMAIN');
      }
      assert.deepEqual(await dump(db), beforeInvalid);
      const created = await post('E2E_COST'); assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.json().datasetSeriesId, old.series.COWOS_S);
      assert.equal(created.json().version, 5);
      const run = await core.inject({ method: 'POST', url: `/calculation-jobs/${created.json().calculationJobs[0].jobId}/run`, payload: {} });
      assert.equal(run.statusCode, 200, run.body);
      const downstream = await post('DPR'); assert.equal(downstream.statusCode, 201);
      const downstreamRun = await core.inject({ method: 'POST', url: `/calculation-jobs/${downstream.json().calculationJobs[0].jobId}/run`, payload: {} });
      assert.equal(downstreamRun.statusCode, 200, downstreamRun.body);
      const dependency = await db.query(`SELECT d.upstream_dataset_series_id,d.upstream_dataset_version_id
        FROM dataset_build_snapshot_dependencies d JOIN dataset_build_snapshots s ON s.id=d.snapshot_id WHERE s.dataset_version_id=$1`,
        [downstream.json().datasetVersionId]);
      assert.deepEqual(dependency.rows, [{ upstream_dataset_series_id: old.series.COWOS_S, upstream_dataset_version_id: old.versions.COWOS_S }]);
      const headers = { 'x-demo-session': '1', origin: 'https://demo.test' };
      const session = await demo.inject({ method: 'POST', url: '/demo/sessions', headers, payload: {} });
      assert.equal(session.statusCode, 201);
      const cookie = String(session.headers['set-cookie']).split(';')[0]!;
      for (const [domain, status] of [['COWOS_S', 400], ['E2E_COST', 201]] as const) {
        const before = await dump(db);
        const result = await demo.inject({ method: 'POST', url: '/demo/dataset-versions', headers: { ...headers, cookie },
          payload: { domain, fiscalYear: 2026, period: 'Q4' } });
        assert.equal(result.statusCode, status, result.body);
        if (status === 400) {
          assert.equal(result.json().code, 'INVALID_DOMAIN');
          assert.deepEqual(await dump(db), before);
        } else {
          const read = await demo.inject({ method: 'GET', url: `/demo/dataset-versions/${result.json().datasetVersionId}`, headers: { cookie } });
          assert.equal(read.statusCode, 200); assert.equal(read.json().domain, 'E2E_COST');
        }
      }
    } finally {
      await core.close(); await demo.close(); await pool.end(); await Promise.all(ends);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }));
});
