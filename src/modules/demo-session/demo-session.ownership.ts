import type { Pool } from 'pg';
import type { AuthenticatedDemoSession, DemoSessionService } from './demo-session.service.js';
import { DemoResourceUnavailableError } from './demo-session.errors.js';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
// SQL fragments are exclusively application-owned, never client table names.
const ownership = {
  series: 'FROM dataset_series ds WHERE ds.id = $1',
  dataset: `FROM dataset_versions dv JOIN dataset_series ds ON ds.id = dv.dataset_series_id
    WHERE dv.id = $1`,
  job: `FROM calculation_jobs cj JOIN dataset_versions dv ON dv.id = cj.output_dataset_version_id
    JOIN dataset_series ds ON ds.id = dv.dataset_series_id WHERE cj.id = $1`,
  attempt: `FROM execution_attempts ea JOIN calculation_jobs cj ON cj.id = ea.calculation_job_id
    JOIN dataset_versions dv ON dv.id = cj.output_dataset_version_id
    JOIN dataset_series ds ON ds.id = dv.dataset_series_id WHERE ea.id = $1`,
};

/** Foundation only: existing Domain HTTP routes intentionally do not call this. */
export class DemoOwnershipValidator {
  constructor(private readonly db: Pool, private readonly sessions: DemoSessionService) {}

  async assertOwned(
    session: AuthenticatedDemoSession, kind: keyof typeof ownership, resourceId: string,
  ): Promise<void> {
    await this.sessions.revalidate(session);
    if (!UUID.test(resourceId)) throw new DemoResourceUnavailableError();
    const result = await this.db.query(
      `SELECT ds.id ${ownership[kind]}
       AND EXISTS (SELECT 1 FROM demo_sessions s WHERE s.id = $2 AND s.company_code = ds.company_code)`,
      [resourceId, session.sessionId],
    );
    if (result.rows.length !== 1) throw new DemoResourceUnavailableError();
  }
}
