import type { PoolClient } from 'pg';
import type {
  CalculationJobStatus,
  DatasetVersionStatus,
} from './calculation-job.types.js';

export interface OutputDatasetIdentity {
  domain: string;
  companyCode: string;
  fiscalYear: number;
  period: string;
}

export interface DatasetCalculationJobContext {
  id: string;
  status: CalculationJobStatus;
  calculationTypeId: string;
  calculationTypeDomain: string;
  calculationTypeCode: string;
}

export interface CalculationRunContext {
  selectedJobId: string;
  datasetVersionId: string;
  datasetStatus: DatasetVersionStatus;
  outputIdentity: OutputDatasetIdentity;
  jobs: DatasetCalculationJobContext[];
}

export interface LockedCalculationType {
  id: string;
  domain: string;
  code: string;
}

export interface PublishedDependencyDefinition {
  id: string;
  calculationTypeId: string;
  version: number;
}

export interface UpstreamSeriesRequirement extends OutputDatasetIdentity {}

export interface LockedUpstreamSeries extends UpstreamSeriesRequirement {
  id: string;
}

export interface PublishedUpstreamVersion {
  datasetSeriesId: string;
  datasetVersionId: string;
  version: number;
}

export interface LockedDatasetVersion {
  id: string;
  status: DatasetVersionStatus;
}

export interface DatasetFreezeState {
  snapshotIds: string[];
  jobCount: number;
  resolvedJobCount: number;
}

export interface LockedSelectedJob {
  id: string;
  outputDatasetVersionId: string;
  status: CalculationJobStatus;
  calculationTypeId: string;
  airflowDagId: string;
}

export type ActiveAttemptStatus = 'PREPARED' | 'DISPATCHING' | 'ACCEPTED';

export interface ActiveExecutionAttempt {
  id: string;
  attemptNumber: number;
  status: ActiveAttemptStatus;
  airflowDagId: string;
  airflowDagRunId: string;
}

export async function loadCalculationRunContext(
  client: PoolClient,
  jobId: string,
): Promise<CalculationRunContext | null> {
  const selected = await client.query<{
    selected_job_id: string;
    dataset_version_id: string;
    dataset_status: DatasetVersionStatus;
    domain: string;
    company_code: string;
    fiscal_year: number;
    period: string;
  }>(
    `SELECT
       cj.id AS selected_job_id,
       dv.id AS dataset_version_id,
       dv.status AS dataset_status,
       ds.domain,
       ds.company_code,
       ds.fiscal_year,
       ds.period
     FROM calculation_jobs cj
     JOIN dataset_versions dv
       ON dv.id = cj.output_dataset_version_id
     JOIN dataset_series ds
       ON ds.id = dv.dataset_series_id
     WHERE cj.id = $1`,
    [jobId],
  );

  const selectedRow = selected.rows[0];
  if (!selectedRow) {
    return null;
  }

  const jobs = await client.query<{
    id: string;
    status: CalculationJobStatus;
    calculation_type_id: string;
    calculation_type_domain: string;
    calculation_type_code: string;
  }>(
    `SELECT
       cj.id,
       cj.status,
       cj.calculation_type_id,
       ct.domain AS calculation_type_domain,
       ct.code AS calculation_type_code
     FROM calculation_jobs cj
     JOIN calculation_types ct
       ON ct.id = cj.calculation_type_id
     WHERE cj.output_dataset_version_id = $1
     ORDER BY ct.domain, ct.code, ct.id`,
    [selectedRow.dataset_version_id],
  );

  return {
    selectedJobId: selectedRow.selected_job_id,
    datasetVersionId: selectedRow.dataset_version_id,
    datasetStatus: selectedRow.dataset_status,
    outputIdentity: {
      domain: selectedRow.domain,
      companyCode: selectedRow.company_code,
      fiscalYear: selectedRow.fiscal_year,
      period: selectedRow.period,
    },
    jobs: jobs.rows.map((row) => ({
      id: row.id,
      status: row.status,
      calculationTypeId: row.calculation_type_id,
      calculationTypeDomain: row.calculation_type_domain,
      calculationTypeCode: row.calculation_type_code,
    })),
  };
}

export async function lockCalculationType(
  client: PoolClient,
  calculationTypeId: string,
): Promise<LockedCalculationType | null> {
  const result = await client.query<{
    id: string;
    domain: string;
    code: string;
  }>(
    `SELECT id, domain, code
     FROM calculation_types
     WHERE id = $1
     FOR UPDATE`,
    [calculationTypeId],
  );
  return result.rows[0] ?? null;
}

export async function findLatestPublishedDependencyDefinitions(
  client: PoolClient,
  calculationTypeIds: string[],
): Promise<PublishedDependencyDefinition[]> {
  if (calculationTypeIds.length === 0) {
    return [];
  }

  const result = await client.query<{
    id: string;
    calculation_type_id: string;
    version: number;
  }>(
    `SELECT DISTINCT ON (calculation_type_id)
       id,
       calculation_type_id,
       version
     FROM execution_dependency_definition_versions
     WHERE calculation_type_id = ANY($1::uuid[])
       AND status = 'PUBLISHED'
     ORDER BY calculation_type_id, version DESC`,
    [calculationTypeIds],
  );

  return result.rows.map((row) => ({
    id: row.id,
    calculationTypeId: row.calculation_type_id,
    version: row.version,
  }));
}

export async function findRequiredDomains(
  client: PoolClient,
  definitionVersionIds: string[],
): Promise<string[]> {
  if (definitionVersionIds.length === 0) {
    return [];
  }

  const result = await client.query<{ required_domain: string }>(
    `SELECT DISTINCT required_domain
     FROM execution_dependency_definition_dependencies
     WHERE definition_version_id = ANY($1::uuid[])
     ORDER BY required_domain`,
    [definitionVersionIds],
  );
  return result.rows.map((row) => row.required_domain);
}

export async function lockUpstreamDatasetSeries(
  client: PoolClient,
  requirement: UpstreamSeriesRequirement,
): Promise<LockedUpstreamSeries | null> {
  const result = await client.query<{
    id: string;
    domain: string;
    company_code: string;
    fiscal_year: number;
    period: string;
  }>(
    `SELECT id, domain, company_code, fiscal_year, period
     FROM dataset_series
     WHERE domain = $1
       AND company_code = $2
       AND fiscal_year = $3
       AND period = $4
     FOR UPDATE`,
    [
      requirement.domain,
      requirement.companyCode,
      requirement.fiscalYear,
      requirement.period,
    ],
  );

  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        domain: row.domain,
        companyCode: row.company_code,
        fiscalYear: row.fiscal_year,
        period: row.period,
      }
    : null;
}

export async function findLatestPublishedUpstreamVersion(
  client: PoolClient,
  datasetSeriesId: string,
): Promise<PublishedUpstreamVersion | null> {
  const result = await client.query<{
    id: string;
    dataset_series_id: string;
    version: number;
  }>(
    `SELECT id, dataset_series_id, version
     FROM dataset_versions
     WHERE dataset_series_id = $1
       AND status = 'PUBLISHED'
     ORDER BY version DESC
     LIMIT 1`,
    [datasetSeriesId],
  );
  const row = result.rows[0];
  return row
    ? {
        datasetSeriesId: row.dataset_series_id,
        datasetVersionId: row.id,
        version: row.version,
      }
    : null;
}

export async function lockOutputDatasetVersion(
  client: PoolClient,
  datasetVersionId: string,
): Promise<LockedDatasetVersion | null> {
  const result = await client.query<{
    id: string;
    status: DatasetVersionStatus;
  }>(
    `SELECT id, status
     FROM dataset_versions
     WHERE id = $1
     FOR UPDATE`,
    [datasetVersionId],
  );
  return result.rows[0] ?? null;
}

export async function readDatasetFreezeState(
  client: PoolClient,
  datasetVersionId: string,
): Promise<DatasetFreezeState> {
  const result = await client.query<{
    snapshot_ids: string[];
    job_count: number;
    resolved_job_count: number;
  }>(
    `SELECT
       ARRAY(
         SELECT dbs.id
         FROM dataset_build_snapshots dbs
         WHERE dbs.dataset_version_id = $1
         ORDER BY dbs.id
       ) AS snapshot_ids,
       COUNT(cj.id)::int AS job_count,
       COUNT(cj.resolved_dependency_definition_version_id)::int
         AS resolved_job_count
     FROM calculation_jobs cj
     WHERE cj.output_dataset_version_id = $1`,
    [datasetVersionId],
  );
  const row = result.rows[0]!;
  return {
    snapshotIds: row.snapshot_ids,
    jobCount: row.job_count,
    resolvedJobCount: row.resolved_job_count,
  };
}

export async function persistResolvedDependencyDefinition(
  client: PoolClient,
  params: {
    datasetVersionId: string;
    jobId: string;
    calculationTypeId: string;
    definitionVersionId: string;
  },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE calculation_jobs
     SET resolved_dependency_definition_version_id = $1
     WHERE id = $2
       AND output_dataset_version_id = $3
       AND calculation_type_id = $4
       AND resolved_dependency_definition_version_id IS NULL
     RETURNING id`,
    [
      params.definitionVersionId,
      params.jobId,
      params.datasetVersionId,
      params.calculationTypeId,
    ],
  );
  return result.rows.length === 1;
}

export async function insertDatasetBuildSnapshot(
  client: PoolClient,
  snapshotId: string,
  datasetVersionId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO dataset_build_snapshots (id, dataset_version_id)
     VALUES ($1, $2)`,
    [snapshotId, datasetVersionId],
  );
}

export async function insertDatasetBuildSnapshotDependency(
  client: PoolClient,
  params: {
    snapshotId: string;
    upstreamDatasetSeriesId: string;
    upstreamDatasetVersionId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dataset_build_snapshot_dependencies (
       snapshot_id,
       upstream_dataset_series_id,
       upstream_dataset_version_id
     ) VALUES ($1, $2, $3)`,
    [
      params.snapshotId,
      params.upstreamDatasetSeriesId,
      params.upstreamDatasetVersionId,
    ],
  );
}

export async function transitionDatasetVersionToBuilding(
  client: PoolClient,
  datasetVersionId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE dataset_versions
     SET status = 'BUILDING', building_started_at = NOW()
     WHERE id = $1
       AND status = 'DRAFT'
     RETURNING id`,
    [datasetVersionId],
  );
  return result.rows.length === 1;
}

export async function lockSelectedCalculationJob(
  client: PoolClient,
  jobId: string,
): Promise<LockedSelectedJob | null> {
  const result = await client.query<{
    id: string;
    output_dataset_version_id: string;
    status: CalculationJobStatus;
    calculation_type_id: string;
    airflow_dag_id: string;
  }>(
    `SELECT
       cj.id,
       cj.output_dataset_version_id,
       cj.status,
       cj.calculation_type_id,
       ct.airflow_dag_id
     FROM calculation_jobs cj
     JOIN calculation_types ct
       ON ct.id = cj.calculation_type_id
     WHERE cj.id = $1
     FOR UPDATE OF cj`,
    [jobId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        outputDatasetVersionId: row.output_dataset_version_id,
        status: row.status,
        calculationTypeId: row.calculation_type_id,
        airflowDagId: row.airflow_dag_id,
      }
    : null;
}

export async function findActiveExecutionAttempt(
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
       AND status IN ('PREPARED', 'DISPATCHING', 'ACCEPTED')`,
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

export async function allocateNextAttemptNumber(
  client: PoolClient,
  jobId: string,
): Promise<number> {
  const result = await client.query<{ next_attempt_number: number }>(
    `SELECT COALESCE(MAX(attempt_number), 0)::int + 1 AS next_attempt_number
     FROM execution_attempts
     WHERE calculation_job_id = $1`,
    [jobId],
  );
  return result.rows[0]!.next_attempt_number;
}

export async function insertPreparedExecutionAttempt(
  client: PoolClient,
  params: {
    id: string;
    jobId: string;
    attemptNumber: number;
    airflowDagId: string;
    airflowDagRunId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO execution_attempts (
       id,
       calculation_job_id,
       attempt_number,
       status,
       airflow_dag_id,
       airflow_dag_run_id
     ) VALUES ($1, $2, $3, 'PREPARED', $4, $5)`,
    [
      params.id,
      params.jobId,
      params.attemptNumber,
      params.airflowDagId,
      params.airflowDagRunId,
    ],
  );
}
