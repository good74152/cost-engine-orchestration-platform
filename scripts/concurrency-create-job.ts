import 'dotenv/config';
import { Pool } from 'pg';

const API_URL =
  process.env.API_URL ??
  'http://localhost:3000';

const CONCURRENCY = 20;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  // 每次測試用新的 business key
  // 不需要手動清 DB
  const businessKey =
    `FAB12:2026:Q3:RACE:${Date.now()}`;

  const payload = {
    domain: 'FAB_COST',
    businessKey,
    dependencies: [],
  };

  console.log(
    `Sending ${CONCURRENCY} concurrent requests...`,
  );

  console.log(`businessKey = ${businessKey}`);

  const requests = Array.from(
    { length: CONCURRENCY },
    async (_, index) => {
      const startedAt = performance.now();

      const response = await fetch(
        `${API_URL}/calculation-jobs`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      );

      const body = await response.json();

      return {
        request: index + 1,
        status: response.status,
        durationMs:
          Math.round(
            performance.now() - startedAt,
          ),
        body,
      };
    },
  );

  const results = await Promise.all(requests);

  console.table(
    results.map((result) => ({
      request: result.request,
      status: result.status,
      durationMs: result.durationMs,
    })),
  );

  const created =
    results.filter(
      (result) => result.status === 201,
    );

  const conflicts =
    results.filter(
      (result) => result.status === 409,
    );

  console.log({
    created: created.length,
    conflicts: conflicts.length,
  });

  //
  // DB invariant verification
  //

  const dbResult = await pool.query<{
    id: string;
    last_version: number;
    version_count: number;
    job_count: number;
    active_job_count: number;
  }>(
    `
      SELECT
        ds.id,
        ds.last_version,

        (
          SELECT COUNT(*)::int
          FROM dataset_versions dv
          WHERE dv.dataset_series_id = ds.id
        ) AS version_count,

        (
          SELECT COUNT(*)::int
          FROM calculation_jobs cj
          WHERE cj.dataset_series_id = ds.id
        ) AS job_count,

        (
          SELECT COUNT(*)::int
          FROM calculation_jobs cj
          WHERE cj.dataset_series_id = ds.id
            AND cj.status IN (
              'PENDING',
              'RUNNING',
              'VALIDATING'
            )
        ) AS active_job_count

      FROM dataset_series ds

      WHERE ds.domain = $1
        AND ds.business_key = $2
    `,
    [
      'FAB_COST',
      businessKey,
    ],
  );

  const state = dbResult.rows[0];

  console.log('Final database state:');
  console.table([state]);

  //
  // Assertions
  //

  if (created.length !== 1) {
    throw new Error(
      `Expected 1 created request, got ${created.length}`,
    );
  }

  if (conflicts.length !== 19) {
    throw new Error(
      `Expected 19 conflicts, got ${conflicts.length}`,
    );
  }

  if (!state) {
    throw new Error(
      'DatasetSeries was not created',
    );
  }

  if (state.last_version !== 1) {
    throw new Error(
      `Expected last_version=1, got ${state.last_version}`,
    );
  }

  if (state.version_count !== 1) {
    throw new Error(
      `Expected 1 DatasetVersion, got ${state.version_count}`,
    );
  }

  if (state.job_count !== 1) {
    throw new Error(
      `Expected 1 CalculationJob, got ${state.job_count}`,
    );
  }

  if (state.active_job_count !== 1) {
    throw new Error(
      `Expected 1 active job, got ${state.active_job_count}`,
    );
  }

  console.log(
    '✅ Concurrency invariant passed',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });