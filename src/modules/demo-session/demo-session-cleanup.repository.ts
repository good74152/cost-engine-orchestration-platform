import type { PoolClient } from 'pg';

export class DemoCleanupIntegrityError extends Error {}

/** The company comes from a locked demo_sessions row, never an HTTP selector. */
export async function deleteOwnedDemoData(client: PoolClient, company: string, sessionId: string): Promise<void> {
  // Same locked session and same transaction as its domain cleanup/revocation.
  await client.query(`DELETE FROM demo_scenario_step_executions WHERE scenario_id IN
    (SELECT id FROM demo_scenario_instances WHERE session_id=$1)`, [sessionId]);
  await client.query('DELETE FROM demo_scenario_instances WHERE session_id=$1', [sessionId]);
  const foreign = await client.query(`SELECT 1
    FROM dataset_build_snapshot_dependencies d
    JOIN dataset_series upstream ON upstream.id=d.upstream_dataset_series_id
    JOIN dataset_build_snapshots b ON b.id=d.snapshot_id
    JOIN dataset_versions v ON v.id=b.dataset_version_id
    JOIN dataset_series owner ON owner.id=v.dataset_series_id
    WHERE upstream.company_code=$1 AND owner.company_code<>$1 LIMIT 1`, [company]);
  if (foreign.rowCount) throw new DemoCleanupIntegrityError('Foreign snapshot references demo ownership graph');

  const series = (await client.query<{ id: string }>(
    'SELECT id FROM dataset_series WHERE company_code=$1', [company])).rows.map((r) => r.id);
  const versions = (await client.query<{ id: string }>(
    'SELECT id FROM dataset_versions WHERE dataset_series_id=ANY($1::uuid[])', [series])).rows.map((r) => r.id);
  const jobs = (await client.query<{ id: string }>(
    'SELECT id FROM calculation_jobs WHERE output_dataset_version_id=ANY($1::uuid[])', [versions])).rows.map((r) => r.id);
  // Delete the whole owned edge set before either end of same-session upstream links.
  await client.query(`DELETE FROM dataset_build_snapshot_dependencies WHERE snapshot_id IN
    (SELECT id FROM dataset_build_snapshots WHERE dataset_version_id=ANY($1::uuid[]))`, [versions]);
  await client.query('DELETE FROM dpr_calculation_inputs WHERE input_snapshot_id=ANY($1::uuid[])', [jobs]);
  await client.query('DELETE FROM dpr_calculation_input_snapshots WHERE calculation_job_id=ANY($1::uuid[])', [jobs]);
  await client.query('DELETE FROM dpr_results WHERE dataset_version_id=ANY($1::uuid[])', [versions]);
  await client.query('DELETE FROM execution_attempts WHERE calculation_job_id=ANY($1::uuid[])', [jobs]);
  await client.query('DELETE FROM dataset_build_snapshots WHERE dataset_version_id=ANY($1::uuid[])', [versions]);
  await client.query('DELETE FROM calculation_jobs WHERE id=ANY($1::uuid[])', [jobs]);
  await client.query('DELETE FROM dataset_versions WHERE id=ANY($1::uuid[])', [versions]);
  await client.query('DELETE FROM dataset_series WHERE id=ANY($1::uuid[])', [series]);
}
