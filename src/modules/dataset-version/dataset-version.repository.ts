import type { PoolClient } from 'pg';
import type {
  CreateDatasetVersionInput,
  CreatedCalculationJob,
} from './dataset-version.types.js';

export interface LockedDatasetSeries {
  id: string;
  lastAllocatedVersion: number;
}

export interface ActiveDatasetVersion {
  id: string;
  status: 'DRAFT' | 'BUILDING' | 'VALIDATING';
}

export interface ActiveCalculationType {
  id: string;
  code: string;
}

export interface CalculationJobInsert {
  id: string;
  calculationTypeId: string;
  calculationTypeCode: string;
}

export async function findOrCreateAndLockDatasetSeries(
  client: PoolClient,
  input: CreateDatasetVersionInput,
  newSeriesId: string,
): Promise<LockedDatasetSeries> {
  await client.query(
    `INSERT INTO dataset_series (
       id,
       domain,
       company_code,
       fiscal_year,
       period,
       last_allocated_version
     ) VALUES ($1, $2, $3, $4, $5, 0)
     ON CONFLICT (domain, company_code, fiscal_year, period) DO NOTHING`,
    [
      newSeriesId,
      input.domain,
      input.companyCode,
      input.fiscalYear,
      input.period,
    ],
  );

  const result = await client.query<{
    id: string;
    last_allocated_version: number;
  }>(
    `SELECT id, last_allocated_version
     FROM dataset_series
     WHERE domain = $1
       AND company_code = $2
       AND fiscal_year = $3
       AND period = $4
     FOR UPDATE`,
    [input.domain, input.companyCode, input.fiscalYear, input.period],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to acquire the canonical dataset series row');
  }

  return {
    id: row.id,
    lastAllocatedVersion: row.last_allocated_version,
  };
}

export async function findActiveDatasetVersion(
  client: PoolClient,
  datasetSeriesId: string,
): Promise<ActiveDatasetVersion | null> {
  const result = await client.query<{
    id: string;
    status: ActiveDatasetVersion['status'];
  }>(
    `SELECT id, status
     FROM dataset_versions
     WHERE dataset_series_id = $1
       AND status IN ('DRAFT', 'BUILDING', 'VALIDATING')
     LIMIT 1`,
    [datasetSeriesId],
  );

  return result.rows[0] ?? null;
}

export async function allocateNextDatasetVersion(
  client: PoolClient,
  datasetSeriesId: string,
): Promise<number> {
  const result = await client.query<{ last_allocated_version: number }>(
    `UPDATE dataset_series
     SET last_allocated_version = last_allocated_version + 1
     WHERE id = $1
     RETURNING last_allocated_version`,
    [datasetSeriesId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Locked dataset series disappeared during version allocation');
  }

  return row.last_allocated_version;
}

export async function insertDraftDatasetVersion(
  client: PoolClient,
  params: {
    id: string;
    datasetSeriesId: string;
    version: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dataset_versions (
       id,
       dataset_series_id,
       version,
       status
     ) VALUES ($1, $2, $3, 'DRAFT')`,
    [params.id, params.datasetSeriesId, params.version],
  );
}

export async function findActiveCalculationTypes(
  client: PoolClient,
  domain: string,
): Promise<ActiveCalculationType[]> {
  const result = await client.query<ActiveCalculationType>(
    `SELECT id, code
     FROM calculation_types
     WHERE domain = $1
       AND is_active = TRUE
     ORDER BY code, id`,
    [domain],
  );

  return result.rows;
}

export async function insertPendingCalculationJobs(
  client: PoolClient,
  datasetVersionId: string,
  jobs: CalculationJobInsert[],
): Promise<CreatedCalculationJob[]> {
  const createdJobs: CreatedCalculationJob[] = [];

  for (const job of jobs) {
    await client.query(
      `INSERT INTO calculation_jobs (
         id,
         output_dataset_version_id,
         calculation_type_id,
         status
       ) VALUES ($1, $2, $3, 'PENDING')`,
      [job.id, datasetVersionId, job.calculationTypeId],
    );

    createdJobs.push({
      jobId: job.id,
      calculationTypeId: job.calculationTypeId,
      calculationTypeCode: job.calculationTypeCode,
      jobStatus: 'PENDING',
    });
  }

  return createdJobs;
}
