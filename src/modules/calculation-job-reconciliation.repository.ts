import type { Pool, PoolClient } from 'pg';
import type { ExecutionIdentity } from '../executors/calculation-executor.js';
import type { ExecutionAttemptStatus } from './calculation-job-run.repository.js';
import type {
  CalculationJobStatus,
  DatasetVersionStatus,
} from './calculation-job.types.js';

type QueryConnection = Pool | PoolClient;

export interface ReconciliationAttemptContext {
  executionAttemptId: string;
  jobId: string;
  jobStatus: CalculationJobStatus;
  datasetVersionId: string;
  datasetStatus: DatasetVersionStatus;
  attemptNumber: number;
  attemptStatus: ExecutionAttemptStatus;
  airflowDagId: string;
  airflowDagRunId: string;
}

export interface ManualReconciliationSelection {
  jobStatus: CalculationJobStatus;
  activeAttemptId: string | null;
  latestTerminalAttemptId: string | null;
}

export interface LockedReconciliationJob {
  jobId: string;
  jobStatus: CalculationJobStatus;
  datasetVersionId: string;
  datasetStatus: DatasetVersionStatus;
}

export async function findManualReconciliationSelection(
  connection: QueryConnection,
  jobId: string,
): Promise<ManualReconciliationSelection | null> {
  const result = await connection.query<{
    job_status: CalculationJobStatus;
    active_attempt_id: string | null;
    latest_terminal_attempt_id: string | null;
  }>(
    `SELECT
       cj.status AS job_status,
       (
         SELECT ea.id
         FROM execution_attempts ea
         WHERE ea.calculation_job_id = cj.id
           AND ea.status IN ('DISPATCHING', 'ACCEPTED')
         ORDER BY ea.attempt_number DESC
         LIMIT 1
       ) AS active_attempt_id,
       (
         SELECT ea.id
         FROM execution_attempts ea
         WHERE ea.calculation_job_id = cj.id
           AND ea.status IN ('SUCCEEDED', 'FAILED')
         ORDER BY ea.attempt_number DESC
         LIMIT 1
       ) AS latest_terminal_attempt_id
     FROM calculation_jobs cj
     WHERE cj.id = $1`,
    [jobId],
  );
  const row = result.rows[0];
  return row
    ? {
        jobStatus: row.job_status,
        activeAttemptId: row.active_attempt_id,
        latestTerminalAttemptId: row.latest_terminal_attempt_id,
      }
    : null;
}

export async function findExecutionAttemptIdByIdentity(
  connection: QueryConnection,
  identity: ExecutionIdentity,
): Promise<string | null> {
  const result = await connection.query<{ id: string }>(
    `SELECT id
     FROM execution_attempts
     WHERE airflow_dag_id = $1
       AND airflow_dag_run_id = $2`,
    [identity.airflowDagId, identity.airflowDagRunId],
  );
  return result.rows[0]?.id ?? null;
}

export async function loadReconciliationAttemptContext(
  connection: QueryConnection,
  executionAttemptId: string,
): Promise<ReconciliationAttemptContext | null> {
  const result = await connection.query<{
    execution_attempt_id: string;
    job_id: string;
    job_status: CalculationJobStatus;
    dataset_version_id: string;
    dataset_status: DatasetVersionStatus;
    attempt_number: number;
    attempt_status: ExecutionAttemptStatus;
    airflow_dag_id: string;
    airflow_dag_run_id: string;
  }>(
    `SELECT
       ea.id AS execution_attempt_id,
       cj.id AS job_id,
       cj.status AS job_status,
       dv.id AS dataset_version_id,
       dv.status AS dataset_status,
       ea.attempt_number,
       ea.status AS attempt_status,
       ea.airflow_dag_id,
       ea.airflow_dag_run_id
     FROM execution_attempts ea
     JOIN calculation_jobs cj
       ON cj.id = ea.calculation_job_id
     JOIN dataset_versions dv
       ON dv.id = cj.output_dataset_version_id
     WHERE ea.id = $1`,
    [executionAttemptId],
  );
  const row = result.rows[0];
  return row
    ? {
        executionAttemptId: row.execution_attempt_id,
        jobId: row.job_id,
        jobStatus: row.job_status,
        datasetVersionId: row.dataset_version_id,
        datasetStatus: row.dataset_status,
        attemptNumber: row.attempt_number,
        attemptStatus: row.attempt_status,
        airflowDagId: row.airflow_dag_id,
        airflowDagRunId: row.airflow_dag_run_id,
      }
    : null;
}

export async function lockReconciliationJob(
  client: PoolClient,
  jobId: string,
): Promise<LockedReconciliationJob | null> {
  const result = await client.query<{
    job_id: string;
    job_status: CalculationJobStatus;
    dataset_version_id: string;
    dataset_status: DatasetVersionStatus;
  }>(
    `SELECT
       cj.id AS job_id,
       cj.status AS job_status,
       dv.id AS dataset_version_id,
       dv.status AS dataset_status
     FROM calculation_jobs cj
     JOIN dataset_versions dv
       ON dv.id = cj.output_dataset_version_id
     WHERE cj.id = $1
     FOR UPDATE OF cj`,
    [jobId],
  );
  const row = result.rows[0];
  return row
    ? {
        jobId: row.job_id,
        jobStatus: row.job_status,
        datasetVersionId: row.dataset_version_id,
        datasetStatus: row.dataset_status,
      }
    : null;
}

export async function hasNewerExecutionAttempt(
  client: PoolClient,
  jobId: string,
  attemptNumber: number,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM execution_attempts
       WHERE calculation_job_id = $1
         AND attempt_number > $2
     ) AS exists`,
    [jobId, attemptNumber],
  );
  return result.rows[0]!.exists;
}

export async function transitionDispatchingAttemptToAccepted(
  client: PoolClient,
  executionAttemptId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE execution_attempts
     SET status = 'ACCEPTED',
         accepted_at = COALESCE(accepted_at, NOW()),
         last_dispatch_error = NULL
     WHERE id = $1
       AND status = 'DISPATCHING'
     RETURNING id`,
    [executionAttemptId],
  );
  return result.rows.length === 1;
}

export async function transitionAttemptToTerminal(
  client: PoolClient,
  params: {
    executionAttemptId: string;
    expectedStatus: 'DISPATCHING' | 'ACCEPTED';
    targetStatus: 'SUCCEEDED' | 'FAILED';
  },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE execution_attempts
     SET status = $2,
         accepted_at = COALESCE(accepted_at, NOW()),
         finished_at = NOW(),
         last_dispatch_error = NULL
     WHERE id = $1
       AND status = $3
     RETURNING id`,
    [params.executionAttemptId, params.targetStatus, params.expectedStatus],
  );
  return result.rows.length === 1;
}

export async function transitionJobToRunning(
  client: PoolClient,
  jobId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE calculation_jobs
     SET status = 'RUNNING',
         started_at = COALESCE(started_at, NOW())
     WHERE id = $1
       AND status IN ('PENDING', 'FAILED')
     RETURNING id`,
    [jobId],
  );
  return result.rows.length === 1;
}

export async function transitionJobToTerminal(
  client: PoolClient,
  params: {
    jobId: string;
    expectedStatuses: CalculationJobStatus[];
    targetStatus: 'SUCCEEDED' | 'FAILED';
  },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE calculation_jobs
     SET status = $2,
         finished_at = NOW()
     WHERE id = $1
       AND status = ANY($3::varchar[])
     RETURNING id`,
    [params.jobId, params.targetStatus, params.expectedStatuses],
  );
  return result.rows.length === 1;
}
