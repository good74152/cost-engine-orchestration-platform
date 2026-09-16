import type { Pool, PoolClient } from 'pg';
import type {
  ActiveAttemptStatus,
  ActiveExecutionAttempt,
} from './calculation-job-preparation.repository.js';
import type {
  CalculationJobStatus,
  DatasetVersionStatus,
} from './calculation-job.types.js';

type QueryConnection = Pool | PoolClient;

export interface CalculationJobRunRoutingState {
  jobId: string;
  jobStatus: CalculationJobStatus;
  datasetVersionId: string;
  datasetStatus: DatasetVersionStatus;
  resolvedDependencyDefinitionVersionId: string | null;
  snapshotIds: string[];
  activeAttempt: ActiveExecutionAttempt | null;
}

export interface LockedCalculationJobDispatchContext {
  jobId: string;
  jobStatus: CalculationJobStatus;
  datasetVersionId: string;
  datasetStatus: DatasetVersionStatus;
  calculationTypeId: string;
  calculationTypeCode: string;
  resolvedDependencyDefinitionVersionId: string | null;
}

export interface FrozenSnapshotDependency {
  domain: string;
  companyCode: string;
  fiscalYear: number;
  period: string;
  datasetSeriesId: string;
  datasetVersionId: string;
  version: number;
}

export type ExecutionAttemptStatus =
  | ActiveAttemptStatus
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DISPATCH_FAILED';

export interface LockedExecutionAttempt {
  id: string;
  calculationJobId: string;
  attemptNumber: number;
  status: ExecutionAttemptStatus;
  airflowDagId: string;
  airflowDagRunId: string;
}

export async function loadCalculationJobRunRoutingState(
  connection: QueryConnection,
  jobId: string,
): Promise<CalculationJobRunRoutingState | null> {
  const result = await connection.query<{
    job_id: string;
    job_status: CalculationJobStatus;
    dataset_version_id: string;
    dataset_status: DatasetVersionStatus;
    resolved_dependency_definition_version_id: string | null;
    snapshot_ids: string[];
    attempt_id: string | null;
    attempt_number: number | null;
    attempt_status: ActiveAttemptStatus | null;
    airflow_dag_id: string | null;
    airflow_dag_run_id: string | null;
  }>(
    `SELECT
       cj.id AS job_id,
       cj.status AS job_status,
       cj.output_dataset_version_id AS dataset_version_id,
       dv.status AS dataset_status,
       cj.resolved_dependency_definition_version_id,
       ARRAY(
         SELECT dbs.id
         FROM dataset_build_snapshots dbs
         WHERE dbs.dataset_version_id = dv.id
         ORDER BY dbs.id
       ) AS snapshot_ids,
       ea.id AS attempt_id,
       ea.attempt_number,
       ea.status AS attempt_status,
       ea.airflow_dag_id,
       ea.airflow_dag_run_id
     FROM calculation_jobs cj
     JOIN dataset_versions dv
       ON dv.id = cj.output_dataset_version_id
     LEFT JOIN execution_attempts ea
       ON ea.calculation_job_id = cj.id
      AND ea.status IN ('PREPARED', 'DISPATCHING', 'ACCEPTED')
     WHERE cj.id = $1`,
    [jobId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const activeAttempt = row.attempt_id === null
    ? null
    : {
        id: row.attempt_id,
        attemptNumber: row.attempt_number!,
        status: row.attempt_status!,
        airflowDagId: row.airflow_dag_id!,
        airflowDagRunId: row.airflow_dag_run_id!,
      };
  return {
    jobId: row.job_id,
    jobStatus: row.job_status,
    datasetVersionId: row.dataset_version_id,
    datasetStatus: row.dataset_status,
    resolvedDependencyDefinitionVersionId:
      row.resolved_dependency_definition_version_id,
    snapshotIds: row.snapshot_ids,
    activeAttempt,
  };
}

export async function lockCalculationJobDispatchContext(
  client: PoolClient,
  jobId: string,
): Promise<LockedCalculationJobDispatchContext | null> {
  const result = await client.query<{
    job_id: string;
    job_status: CalculationJobStatus;
    dataset_version_id: string;
    dataset_status: DatasetVersionStatus;
    calculation_type_id: string;
    calculation_type_code: string;
    resolved_dependency_definition_version_id: string | null;
  }>(
    `SELECT
       cj.id AS job_id,
       cj.status AS job_status,
       cj.output_dataset_version_id AS dataset_version_id,
       dv.status AS dataset_status,
       cj.calculation_type_id,
       ct.code AS calculation_type_code,
       cj.resolved_dependency_definition_version_id
     FROM calculation_jobs cj
     JOIN dataset_versions dv
       ON dv.id = cj.output_dataset_version_id
     JOIN calculation_types ct
       ON ct.id = cj.calculation_type_id
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
        calculationTypeId: row.calculation_type_id,
        calculationTypeCode: row.calculation_type_code,
        resolvedDependencyDefinitionVersionId:
          row.resolved_dependency_definition_version_id,
      }
    : null;
}

export async function lockActiveExecutionAttempt(
  client: PoolClient,
  jobId: string,
): Promise<ActiveExecutionAttempt | null> {
  const result = await client.query<{
    id: string;
    attempt_number: number;
    status: ActiveAttemptStatus;
    airflow_dag_id: string;
    airflow_dag_run_id: string;
  }>(
    `SELECT
       id,
       attempt_number,
       status,
       airflow_dag_id,
       airflow_dag_run_id
     FROM execution_attempts
     WHERE calculation_job_id = $1
       AND status IN ('PREPARED', 'DISPATCHING', 'ACCEPTED')
     FOR UPDATE`,
    [jobId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        attemptNumber: row.attempt_number,
        status: row.status,
        airflowDagId: row.airflow_dag_id,
        airflowDagRunId: row.airflow_dag_run_id,
      }
    : null;
}

export async function lockExecutionAttempt(
  client: PoolClient,
  executionAttemptId: string,
): Promise<LockedExecutionAttempt | null> {
  const result = await client.query<{
    id: string;
    calculation_job_id: string;
    attempt_number: number;
    status: ExecutionAttemptStatus;
    airflow_dag_id: string;
    airflow_dag_run_id: string;
  }>(
    `SELECT
       id,
       calculation_job_id,
       attempt_number,
       status,
       airflow_dag_id,
       airflow_dag_run_id
     FROM execution_attempts
     WHERE id = $1
     FOR UPDATE`,
    [executionAttemptId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        calculationJobId: row.calculation_job_id,
        attemptNumber: row.attempt_number,
        status: row.status,
        airflowDagId: row.airflow_dag_id,
        airflowDagRunId: row.airflow_dag_run_id,
      }
    : null;
}

export async function readDatasetBuildSnapshotIds(
  client: PoolClient,
  datasetVersionId: string,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id
     FROM dataset_build_snapshots
     WHERE dataset_version_id = $1
     ORDER BY id`,
    [datasetVersionId],
  );
  return result.rows.map((row) => row.id);
}

export async function findRequiredDomainsForDefinition(
  client: PoolClient,
  definitionVersionId: string,
): Promise<string[]> {
  const result = await client.query<{ required_domain: string }>(
    `SELECT required_domain
     FROM execution_dependency_definition_dependencies
     WHERE definition_version_id = $1
     ORDER BY required_domain`,
    [definitionVersionId],
  );
  return result.rows.map((row) => row.required_domain);
}

export async function findFrozenSnapshotDependencies(
  client: PoolClient,
  snapshotId: string,
): Promise<FrozenSnapshotDependency[]> {
  const result = await client.query<{
    domain: string;
    company_code: string;
    fiscal_year: number;
    period: string;
    dataset_series_id: string;
    dataset_version_id: string;
    version: number;
  }>(
    `SELECT
       ds.domain,
       ds.company_code,
       ds.fiscal_year,
       ds.period,
       dependency.upstream_dataset_series_id AS dataset_series_id,
       dependency.upstream_dataset_version_id AS dataset_version_id,
       dv.version
     FROM dataset_build_snapshot_dependencies dependency
     JOIN dataset_series ds
       ON ds.id = dependency.upstream_dataset_series_id
     JOIN dataset_versions dv
       ON dv.dataset_series_id = dependency.upstream_dataset_series_id
      AND dv.id = dependency.upstream_dataset_version_id
     WHERE dependency.snapshot_id = $1
     ORDER BY ds.domain, ds.company_code, ds.fiscal_year, ds.period`,
    [snapshotId],
  );
  return result.rows.map((row) => ({
    domain: row.domain,
    companyCode: row.company_code,
    fiscalYear: row.fiscal_year,
    period: row.period,
    datasetSeriesId: row.dataset_series_id,
    datasetVersionId: row.dataset_version_id,
    version: row.version,
  }));
}

export async function markExecutionAttemptDispatching(
  client: PoolClient,
  executionAttemptId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE execution_attempts
     SET status = 'DISPATCHING',
         dispatch_started_at = NOW(),
         last_dispatch_error = NULL
     WHERE id = $1
       AND status = 'PREPARED'
     RETURNING id`,
    [executionAttemptId],
  );
  return result.rows.length === 1;
}

export async function markExecutionAttemptAccepted(
  client: PoolClient,
  executionAttemptId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE execution_attempts
     SET status = 'ACCEPTED',
         accepted_at = NOW(),
         last_dispatch_error = NULL
     WHERE id = $1
       AND status = 'DISPATCHING'
     RETURNING id`,
    [executionAttemptId],
  );
  return result.rows.length === 1;
}

export async function markCalculationJobRunning(
  client: PoolClient,
  jobId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE calculation_jobs
     SET status = 'RUNNING', started_at = COALESCE(started_at, NOW())
     WHERE id = $1
       AND status IN ('PENDING', 'FAILED')
     RETURNING id`,
    [jobId],
  );
  return result.rows.length === 1;
}

export async function markExecutionAttemptDispatchFailed(
  client: PoolClient,
  executionAttemptId: string,
  message: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE execution_attempts
     SET status = 'DISPATCH_FAILED',
         finished_at = NOW(),
         last_dispatch_error = $2
     WHERE id = $1
       AND status = 'DISPATCHING'
     RETURNING id`,
    [executionAttemptId, message],
  );
  return result.rows.length === 1;
}

export async function recordUnknownDispatchDiagnostic(
  client: PoolClient,
  executionAttemptId: string,
  message: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE execution_attempts
     SET last_dispatch_error = $2
     WHERE id = $1
       AND status = 'DISPATCHING'
     RETURNING id`,
    [executionAttemptId, message],
  );
  return result.rows.length === 1;
}
