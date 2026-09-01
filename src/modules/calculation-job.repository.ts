import type { PoolClient } from "pg";

export interface AllocatedSeries {
    datasetSeriesId: string;
    version: number;
}

export async function allocateDatasetVersion(
    client: PoolClient,
    params: {
        newSeriesId: string,
        domain: string,
        businessKey: string
    }
): Promise<AllocatedSeries> {
    console.log(`Allocating dataset version for domain: ${params.domain}, businessKey: ${params.businessKey}, newSeriesId: ${params.newSeriesId}`);
    const sql = `
    INSERT INTO dataset_series (id, domain, business_key, last_version)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT (domain, business_key)
    DO UPDATE
    SET last_version = dataset_series.last_version + 1
    RETURNING id, last_version;
    `;
    const result = await client.query(sql, [params.newSeriesId, params.domain, params.businessKey]);
    console.log(`Allocated dataset series with ID: ${result.rows[0].id}, last version: ${result.rows[0].last_version}`);
    const allocatedSeries: AllocatedSeries = {
        datasetSeriesId: result.rows[0].id,
        version: result.rows[0].last_version
    };
    return allocatedSeries;
}

export async function createDatasetVersion(
    client: PoolClient,
    params: {
        id: string;
        datasetSeriesId: string;
        version: number;
    }
): Promise<void> {
    console.log(`Creating dataset version with ID: ${params.id}, datasetSeriesId: ${params.datasetSeriesId}, version: ${params.version}`);
    const sql = `
    INSERT INTO dataset_versions (id, dataset_series_id, version, status)
    VALUES ($1, $2, $3, 'DRAFT')
    RETURNING id, created_at;
    `;
    const result =await client.query(sql, [params.id, params.datasetSeriesId, params.version]);
    console.log(`Created dataset version with ID: ${result.rows[0].id}, created at: ${result.rows[0].created_at}`);
}

export async function createCalculationJob(
    client: PoolClient,
    params: {
        id: string;
        datasetSeriesId: string;
        outputDatasetVersionId: string;
    }
): Promise<void> {
    console.log(`Creating calculation job with ID: ${params.id}, datasetSeriesId: ${params.datasetSeriesId}, outputDatasetVersionId: ${params.outputDatasetVersionId}`);
    const sql = `
    INSERT INTO calculation_jobs (id, dataset_series_id, output_dataset_version_id, status)
    VALUES ($1, $2, $3, 'PENDING')
    RETURNING id, created_at;
    `;
    const result = await client.query(sql, [params.id, params.datasetSeriesId, params.outputDatasetVersionId]);
    console.log(`Created calculation job with ID: ${result.rows[0].id}, created at: ${result.rows[0].created_at}`);
}

export async function createCalculationDependencies(
    client: PoolClient,
    params: {
        calculationJobId: string;
        dependencies: Array<{
            datasetVersionId: string;
            dependencyType: string;
            policy: string;
        }>
    }
): Promise<void> {
    console.log(`Creating calculation dependencies for calculationJobId: ${params.calculationJobId}`);
    const sql = `
    INSERT INTO calculation_dependencies (calculation_job_id, dataset_version_id, dependency_type, policy)
    VALUES ($1, $2, $3, $4)
    RETURNING id;
    `;
    for (const dependency of params.dependencies) {
        const result = await client.query(sql, [params.calculationJobId, dependency.datasetVersionId, dependency.dependencyType, dependency.policy]);
        console.log(`Created calculation dependency with ID: ${result.rows[0].id}`);
    }
}

export interface DatasetVersionDependencyInfo {
  id: string;
  status: string;
  domain: string;
  businessKey: string;
}

export async function findDatasetVersionDependencyInfo(
  client: PoolClient,
  datasetVersionId: string,
): Promise<DatasetVersionDependencyInfo | null> {
    console.log(`Finding dataset version dependency info for datasetVersionId: ${datasetVersionId}`);
    const result = await client.query<{
        id: string;
        status: string;
        domain: string;
        business_key: string;
    }>(
        `
        SELECT
            dv.id,
            dv.status,
            ds.domain,
            ds.business_key
        FROM dataset_versions dv
        JOIN dataset_series ds
            ON ds.id = dv.dataset_series_id
        WHERE dv.id = $1
        `,
        [datasetVersionId],
    );

    const row = result.rows[0];

    if (!row) {
        return null;
    }

    return {
        id: row.id,
        status: row.status,
        domain: row.domain,
        businessKey: row.business_key,
    };
}

export interface StartedJob {
    jobId: string;
    outputDatasetVersionId: string;
}

export async function startJobIfPending(
    client: PoolClient,
    jobId: string
): Promise<StartedJob | null> {
    console.log(`Attempting to start job with ID: ${jobId}`);
    const sql = `
    UPDATE calculation_jobs
    SET status = 'RUNNING',
        started_at = NOW()
    WHERE id = $1
    AND status = 'PENDING'
    RETURNING id, output_dataset_version_id;
    `;
    const result = await client.query(sql, [jobId]);
    const row = result.rows[0];
    if (!row) {
        console.log(`Job with ID: ${jobId} is not in PENDING status or does not exist.`);
        return null;
    }
    return {
        jobId: row.id,
        outputDatasetVersionId: row.output_dataset_version_id
    };
}

export async function findCalculationJobStatus(
    client: PoolClient,
    jobId: string
): Promise<string | null> {
    console.log(`Finding status for calculation job with ID: ${jobId}`);
    const sql = `
    SELECT status 
    FROM calculation_jobs
    WHERE id = $1
    `;
    const result = await client.query(sql, [jobId]);
    const row = result.rows[0];
    return row ? row.status : null;
}

export async function markDatasetBuildingIfDraft(
    client: PoolClient,
    datasetVersionId: string
): Promise<boolean> {
    console.log(`Attempting to mark dataset version with ID: ${datasetVersionId} as BUILDING if it is currently DRAFT`);
    const sql = `
    UPDATE dataset_versions
    SET status = 'BUILDING'
    WHERE id = $1
    AND status = 'DRAFT'
    RETURNING id;
    `;
    const result = await client.query(sql, [datasetVersionId]);
    return result.rows.length === 1;
}

export interface ValidatingJob {
    jobId: string;
    outputDatasetVersionId: string;
}

export async function markJobValidatingIfRunning(
    client: PoolClient,
    jobId: string
): Promise<ValidatingJob|null> {
    const sql = `
        UPDATE calculation_jobs
        SET status = 'VALIDATING'
        WHERE 
        id = $1
        AND status = 'RUNNING'
        RETURNING id, output_dataset_version_id
    `;
    const result = await client.query(sql, [jobId]);
    const row = result.rows[0];
    if(!row) {
        return null
    }
    return {
        jobId: row.id,
        outputDatasetVersionId: row.output_dataset_version_id
    }
}

export async function markDatasetValidatingIfBuilding(
    client: PoolClient,
    datasetVersionId: string
): Promise<boolean> {
    const sql = `
        UPDATE dataset_versions
        SET status = 'VALIDATING'
        WHERE 
        id = $1
        AND status = 'BUILDING'
        RETURNING id
    `;
    const result = await client.query(sql, [datasetVersionId]);
    return result.rows.length === 1;
}

export async function publishDatasetIfValidating(
  client: PoolClient,
  datasetVersionId: string,
): Promise<boolean> {
  const result = await client.query(
    `
      UPDATE dataset_versions
      SET
        status = 'PUBLISHED',
        published_at = NOW()
      WHERE id = $1
        AND status = 'VALIDATING'
      RETURNING id
    `,
    [datasetVersionId],
  );

  return result.rows.length === 1;
}

export async function succeedJobIfValidating(
  client: PoolClient,
  jobId: string,
): Promise<string | null> {
  const result = await client.query<{
    output_dataset_version_id: string;
  }>(
    `
      UPDATE calculation_jobs
      SET
        status = 'SUCCEEDED',
        finished_at = NOW()
      WHERE id = $1
        AND status = 'VALIDATING'
      RETURNING output_dataset_version_id
    `,
    [jobId],
  );

  return (
    result.rows[0]
      ?.output_dataset_version_id
    ?? null
  );
}

export async function rejectJobIfValidating(
  client: PoolClient,
  jobId: string,
): Promise<string | null> {
  const result = await client.query<{
    output_dataset_version_id: string;
  }>(
    `
      UPDATE calculation_jobs
      SET
        status = 'REJECTED',
        finished_at = NOW()
      WHERE id = $1
        AND status = 'VALIDATING'
      RETURNING output_dataset_version_id
    `,
    [jobId],
  );

  return (
    result.rows[0]
      ?.output_dataset_version_id
    ?? null
  );
}

export async function rejectDatasetIfValidating(
  client: PoolClient,
  datasetVersionId: string,
): Promise<boolean> {
  const result = await client.query(
    `
      UPDATE dataset_versions
      SET status = 'REJECTED'
      WHERE id = $1
        AND status = 'VALIDATING'
      RETURNING id
    `,
    [datasetVersionId],
  );

  return result.rows.length === 1;
}

export async function failJobIfRunning(
  client: PoolClient,
  jobId: string,
): Promise<string | null> {
  const result = await client.query<{
    output_dataset_version_id: string;
  }>(
    `
      UPDATE calculation_jobs
      SET
        status = 'FAILED',
        finished_at = NOW()
      WHERE id = $1
        AND status = 'RUNNING'
      RETURNING output_dataset_version_id
    `,
    [jobId],
  );

  return (
    result.rows[0]
      ?.output_dataset_version_id
    ?? null
  );
}

export async function failDatasetIfBuilding(
  client: PoolClient,
  datasetVersionId: string
): Promise<boolean> {
  const result = await client.query(
    `
      UPDATE dataset_versions
      SET status = 'FAILED'
      WHERE id = $1
        AND status = 'BUILDING'
      RETURNING id
    `,
    [datasetVersionId],
  );

  return result.rows.length === 1;
}