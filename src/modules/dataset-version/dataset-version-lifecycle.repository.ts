import type { Pool, PoolClient } from 'pg';
import type { CalculationJobStatus, DatasetVersionStatus } from '../calculation-job.types.js';
import type { ExecutionAttemptStatus } from '../calculation-job-run.repository.js';
import type { DatasetLifecycleResult } from './dataset-version.types.js';

export type LockedLifecycleDataset = DatasetLifecycleResult;

export interface LockedLifecycleJob {
  id: string;
  status: CalculationJobStatus;
}

export interface LockedLifecycleAttempt {
  id: string;
  calculation_job_id: string;
  status: ExecutionAttemptStatus;
}

export async function readDatasetSeriesId(
  connection: Pool | PoolClient,
  datasetVersionId: string,
): Promise<string | null> {
  const result = await connection.query<{ dataset_series_id: string }>(
    'SELECT dataset_series_id FROM dataset_versions WHERE id = $1',
    [datasetVersionId],
  );
  return result.rows[0]?.dataset_series_id ?? null;
}

export async function lockLifecycleSeries(client: PoolClient, seriesId: string): Promise<boolean> {
  const result = await client.query(
    'SELECT id FROM dataset_series WHERE id = $1 FOR UPDATE',
    [seriesId],
  );
  return result.rows.length === 1;
}

export async function lockLifecycleDataset(
  client: PoolClient,
  datasetVersionId: string,
): Promise<LockedLifecycleDataset | null> {
  const result = await client.query<{
    id: string;
    dataset_series_id: string;
    version: number;
    status: DatasetVersionStatus;
  }>(
    `SELECT id, dataset_series_id, version, status
     FROM dataset_versions WHERE id = $1 FOR UPDATE`,
    [datasetVersionId],
  );
  const row = result.rows[0];
  return row ? {
    datasetSeriesId: row.dataset_series_id,
    datasetVersionId: row.id,
    version: row.version,
    datasetStatus: row.status,
  } : null;
}

export async function lockLifecycleJobs(
  client: PoolClient,
  datasetVersionId: string,
): Promise<LockedLifecycleJob[]> {
  const result = await client.query<LockedLifecycleJob>(
    `SELECT id, status FROM calculation_jobs
     WHERE output_dataset_version_id = $1
     ORDER BY id FOR UPDATE`,
    [datasetVersionId],
  );
  return result.rows;
}

export async function lockLifecycleAttempts(
  client: PoolClient,
  datasetVersionId: string,
): Promise<LockedLifecycleAttempt[]> {
  const result = await client.query<LockedLifecycleAttempt>(
    `SELECT ea.id, ea.calculation_job_id, ea.status
     FROM execution_attempts ea
     JOIN calculation_jobs cj ON cj.id = ea.calculation_job_id
     WHERE cj.output_dataset_version_id = $1
     ORDER BY ea.calculation_job_id, ea.attempt_number
     FOR UPDATE OF ea`,
    [datasetVersionId],
  );
  return result.rows;
}

// Column names and legal source states are exclusively application-owned.
const transitions = {
  VALIDATING: { timestamp: 'validating_at', sources: ['BUILDING'] },
  PUBLISHED: { timestamp: 'published_at', sources: ['VALIDATING'] },
  REJECTED: { timestamp: 'rejected_at', sources: ['VALIDATING'] },
  ABANDONED: { timestamp: 'abandoned_at', sources: ['DRAFT', 'BUILDING'] },
} as const;

export type LifecycleTarget = keyof typeof transitions;

export async function transitionLifecycleDataset(
  client: PoolClient,
  datasetVersionId: string,
  target: LifecycleTarget,
): Promise<boolean> {
  const transition = transitions[target];
  const result = await client.query(
    `UPDATE dataset_versions
     SET status = $2, ${transition.timestamp} = NOW()
     WHERE id = $1 AND status = ANY($3::varchar[])
     RETURNING id`,
    [datasetVersionId, target, transition.sources],
  );
  return result.rows.length === 1;
}
