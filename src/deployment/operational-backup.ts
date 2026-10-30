import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { firstDeploymentBusinessTables, schemaEvidence } from './cutover-preflight.js';
import { verifyMigrationInventory } from './verify-database.js';
import { lockDemoAdmission } from '../modules/demo-admission/demo-admission.repository.js';
import { lockCutoverConfiguration, verifyCutoverConfiguration } from '../modules/demo-cutover/demo-cutover.configuration.js';

const configurationTables = ['calculation_types', 'execution_dependency_definition_versions', 'execution_dependency_definition_dependencies'] as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export const backupUnavailable = () => new Error('Operational backup validation failed; no backup or recovery is confirmed');

export interface OperationalBackupEvidence {
  result: 'PASS'; deploymentVersion: string; postgresVersion: '18';
  admissionState: 'WORKFLOW_OPEN'; admissionUpdatedAt: string; configuration: 'WORKFLOW';
  migrations: string[]; counts: Record<string, number>; schemaSha256: string;
  configurationSha256: string; dataSha256: string;
}

/** Check actual rows against the existing database's FK/CHECK definitions. This
 * does not dispatch, repair, invalidate Sessions or implement lifecycle changes. */
async function verifyRows(client: PoolClient): Promise<void> {
  const keys = (await client.query<{ table_name: string; target: string; columns: string[]; targets: string[]; match: string; definition: string }>(`
    SELECT c.relname AS table_name,r.relname AS target,k.confmatchtype AS match,pg_get_constraintdef(k.oid) AS definition,
      ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,position)
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num ORDER BY x.position) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,position)
        JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=x.num ORDER BY x.position) AS targets
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_class r ON r.oid=k.confrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND k.contype='f' ORDER BY c.relname,k.conname`)).rows;
  // The shared first-deployment verifier already requires Dataset/Job/Attempt
  // and upstream composite FKs. Nonempty snapshot membership needs this FK too.
  if (!keys.some(k => k.table_name === 'dataset_build_snapshot_dependencies'
    && k.definition === 'FOREIGN KEY (snapshot_id) REFERENCES dataset_build_snapshots(id) ON DELETE RESTRICT')) throw backupUnavailable();
  for (const key of keys) {
    if (key.match !== 's') throw backupUnavailable(); // Current migrations use MATCH SIMPLE only.
    const present = key.columns.map(c => `s.${identifier(c)} IS NOT NULL`).join(' AND ');
    const equal = key.columns.map((c, i) => `s.${identifier(c)}=t.${identifier(key.targets[i]!)}`).join(' AND ');
    const row = await client.query<{ bad: boolean }>(`SELECT EXISTS(SELECT 1 FROM public.${identifier(key.table_name)} s
      WHERE ${present} AND NOT EXISTS(SELECT 1 FROM public.${identifier(key.target)} t WHERE ${equal})) AS bad`);
    if (row.rows[0]?.bad !== false) throw backupUnavailable();
  }
  const checks = (await client.query<{ table_name: string; expression: string }>(`SELECT c.relname AS table_name,
    pg_get_expr(k.conbin,k.conrelid) AS expression FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND k.contype='c' ORDER BY c.relname,k.conname`)).rows;
  for (const check of checks) {
    if ((await client.query<{ bad: boolean }>(`SELECT EXISTS(SELECT 1 FROM public.${identifier(check.table_name)}
      WHERE (${check.expression}) IS FALSE) AS bad`)).rows[0]?.bad !== false) throw backupUnavailable();
  }
  // Cross-table stored bindings required by the existing First Run contract.
  // In-flight attempts/statuses are permitted; executor truth is never inferred.
  if ((await client.query<{ bad: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM calculation_jobs j JOIN dataset_versions v ON v.id=j.output_dataset_version_id
      JOIN dataset_series s ON s.id=v.dataset_series_id JOIN calculation_types t ON t.id=j.calculation_type_id WHERE s.domain<>t.domain)
    OR EXISTS(SELECT 1 FROM execution_attempts a JOIN calculation_jobs j ON j.id=a.calculation_job_id
      WHERE j.resolved_dependency_definition_version_id IS NULL OR NOT EXISTS
        (SELECT 1 FROM dataset_build_snapshots b WHERE b.dataset_version_id=j.output_dataset_version_id))
    OR EXISTS(SELECT 1 FROM dataset_build_snapshots b JOIN calculation_jobs j ON j.output_dataset_version_id=b.dataset_version_id
      WHERE j.resolved_dependency_definition_version_id IS NULL)
    OR EXISTS(SELECT 1 FROM dataset_build_snapshot_dependencies d JOIN dataset_build_snapshots b ON b.id=d.snapshot_id
      JOIN dataset_versions v ON v.id=b.dataset_version_id JOIN dataset_series s ON s.id=v.dataset_series_id
      JOIN dataset_versions u ON u.id=d.upstream_dataset_version_id JOIN dataset_series us ON us.id=u.dataset_series_id
      WHERE u.status<>'PUBLISHED' OR s.company_code<>us.company_code OR s.fiscal_year<>us.fiscal_year OR s.period<>us.period) AS bad`)).rows[0]?.bad !== false) throw backupUnavailable();
  // Compare frozen domains with the union of the already-resolved definitions,
  // never with a freshly resolved/latest upstream version or a global pipeline.
  if ((await client.query<{ bad: boolean }>(`WITH required AS (
      SELECT DISTINCT b.id AS snapshot_id,d.required_domain AS domain FROM dataset_build_snapshots b
      JOIN calculation_jobs j ON j.output_dataset_version_id=b.dataset_version_id
      JOIN execution_dependency_definition_dependencies d ON d.definition_version_id=j.resolved_dependency_definition_version_id
    ), frozen AS (
      SELECT d.snapshot_id,s.domain FROM dataset_build_snapshot_dependencies d JOIN dataset_series s ON s.id=d.upstream_dataset_series_id
    ) SELECT EXISTS((SELECT * FROM required EXCEPT SELECT * FROM frozen) UNION ALL
      (SELECT * FROM frozen EXCEPT SELECT * FROM required)) AS bad`)).rows[0]?.bad !== false) throw backupUnavailable();
}

/** Caller retains this connection/transaction until pg_dump finishes importing
 * and using the exported snapshot. Ordinary business DML remains compatible. */
export async function beginOperationalBackup(client: PoolClient, deploymentVersion: string, migrationsDirectory = 'migrations'): Promise<OperationalBackupEvidence> {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(deploymentVersion)) throw backupUnavailable();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await client.query("SET LOCAL lock_timeout='3s'");
  await client.query("SET LOCAL statement_timeout='60s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='60min'");
  await client.query('SET LOCAL search_path=pg_catalog,public');
  await client.query("SET LOCAL TimeZone='UTC'");
  await client.query("SET LOCAL DateStyle='ISO, MDY'");
  await client.query("SET LOCAL bytea_output='hex'");
  const gate = await lockDemoAdmission(client);
  if (gate.state !== 'WORKFLOW_OPEN') throw backupUnavailable();
  await lockCutoverConfiguration(client, false);
  await client.query('LOCK TABLE public.pgmigrations IN SHARE MODE');
  // ACCESS SHARE deliberately permits the Session capacity SHARE ROW EXCLUSIVE
  // lock as well as normal graph RowExclusive/RowShare locks. Never use quiescence.
  await client.query(`LOCK TABLE ${firstDeploymentBusinessTables.map(t => 'public.' + identifier(t)).join(',')} IN ACCESS SHARE MODE`);
  const migrations = await verifyMigrationInventory(client, migrationsDirectory);
  await verifyCutoverConfiguration(client, 'WORKFLOW'); // Six domains / ten Types / exact definition history.
  const version = Number((await client.query('SHOW server_version_num')).rows[0]?.server_version_num);
  if (!Number.isInteger(version) || version < 180000 || version >= 190000) throw backupUnavailable();
  const schemaSha256 = await schemaEvidence(client);
  if ((await client.query('SELECT count(*) AS n FROM demo_admission_control')).rows[0]?.n !== '1') throw backupUnavailable();
  await verifyRows(client);
  const configuration: unknown[] = [];
  for (const table of configurationTables) configuration.push((await client.query(`SELECT to_jsonb(r) AS row FROM public.${table} r ORDER BY to_jsonb(r)::text`)).rows);
  const counts: Record<string, number> = {};
  const data = createHash('sha256');
  for (const table of [...firstDeploymentBusinessTables].sort()) {
    data.update(JSON.stringify(table) + '\n'); let count = 0;
    // Bounded client memory. Sorting covers complete row values, including hashes,
    // dates, snapshots and execution identities, without printing any row content.
    await client.query(`DECLARE backup_rows NO SCROLL CURSOR FOR SELECT to_jsonb(r)::text AS row FROM public.${identifier(table)} r ORDER BY to_jsonb(r)::text COLLATE "C"`);
    for (;;) {
      const rows = (await client.query<{ row: string }>('FETCH FORWARD 1000 FROM backup_rows')).rows;
      if (!rows.length) break;
      for (const row of rows) { data.update(row.row + '\n'); count++; }
    }
    await client.query('CLOSE backup_rows');
    if (!Number.isSafeInteger(count)) throw backupUnavailable();
    counts[table] = count;
  }
  return { result: 'PASS', deploymentVersion, postgresVersion: '18', admissionState: 'WORKFLOW_OPEN', admissionUpdatedAt: gate.updatedAt,
    configuration: 'WORKFLOW', migrations, counts, schemaSha256, configurationSha256: hash(configuration), dataSha256: data.digest('hex') };
}

/** Isolated restore validation uses the identical bounded verifier and fingerprints. */
export async function verifyOperationalDatabase(db: Pool, version: string): Promise<OperationalBackupEvidence> {
  let client: PoolClient | undefined;
  try {
    client = await db.connect();
    const evidence = await beginOperationalBackup(client, version);
    await client.query('ROLLBACK'); return evidence;
  } catch { await client?.query('ROLLBACK').catch(() => {}); throw backupUnavailable(); }
  finally { client?.release(true); }
}
