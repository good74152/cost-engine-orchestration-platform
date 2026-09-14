import type { PoolClient } from "pg";

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
