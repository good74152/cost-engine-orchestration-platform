import type { Pool } from 'pg';
import type { DatasetVersionStatus, CalculationJobStatus } from '../calculation-job.types.js';
import type { ExecutionAttemptStatus } from '../calculation-job-run.repository.js';
import type { AuthenticatedDemoSession } from './demo-session.service.js';
import { DemoResourceUnavailableError } from './demo-session.errors.js';
import { publicPage, type ReadPage } from './demo-read.pagination.js';

export interface DemoDatasetDto {
  datasetVersionId: string; datasetSeriesId: string; domain: string; fiscalYear: number;
  period: string; version: number; datasetStatus: DatasetVersionStatus; createdAt: string;
}
export interface DemoDatasetDetailDto extends DemoDatasetDto {
  buildingStartedAt: string | null; validatingAt: string | null; publishedAt: string | null;
  rejectedAt: string | null; abandonedAt: string | null;
}
export interface DemoJobDto {
  jobId: string; datasetVersionId: string; calculationTypeCode: string; jobStatus: CalculationJobStatus;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface DemoJobDetailDto extends DemoJobDto { datasetStatus: DatasetVersionStatus }
export interface DemoAttemptDto {
  executionAttemptId: string; attemptNumber: number; attemptStatus: ExecutionAttemptStatus;
  createdAt: string; dispatchStartedAt: string | null; acceptedAt: string | null; finishedAt: string | null;
}

// Application-owned explicit projections. JSON timestamps are PostgreSQL ISO-8601
// strings, not a projection of credential, error, DAG/run or fake-memory fields.
const dataset = `'datasetVersionId',v.id,'datasetSeriesId',ds.id,'domain',ds.domain,
  'fiscalYear',ds.fiscal_year,'period',ds.period,'version',v.version,
  'datasetStatus',v.status,'createdAt',v.created_at`;
const job = `'jobId',j.id,'datasetVersionId',j.output_dataset_version_id,
  'calculationTypeCode',ct.code,'jobStatus',j.status,'createdAt',j.created_at,
  'startedAt',j.started_at,'finishedAt',j.finished_at`;
const owner = `JOIN dataset_series ds ON ds.id=v.dataset_series_id
  JOIN demo_sessions s ON s.company_code=ds.company_code AND s.id=$1`;
export const readScope = (s: AuthenticatedDemoSession, id = '') => `${s.sessionId}:${id.toLowerCase()}`;

/** Each response, including parent existence and its bounded child page, uses
 * ONE SQL snapshot. Caller admits/revalidates via the existing coordinator. */
export class DemoReadRepository {
  constructor(private readonly db: Pool) {}

  async datasets(session: AuthenticatedDemoSession, page: ReadPage) {
    const result = await this.db.query<{ item: DemoDatasetDto }>(`SELECT jsonb_build_object(${dataset}) AS item
      FROM dataset_versions v ${owner}
      WHERE ($2::uuid IS NULL OR v.id>$2) ORDER BY v.id LIMIT $3`,
    [session.sessionId, page.after, page.limit + 1]);
    return publicPage(result.rows.map((r) => r.item), page, 'datasets', readScope(session), (r) => r.datasetVersionId);
  }

  async dataset(session: AuthenticatedDemoSession, id: string): Promise<DemoDatasetDetailDto> {
    const result = await this.db.query<{ item: DemoDatasetDetailDto }>(`SELECT jsonb_build_object(${dataset},
      'buildingStartedAt',v.building_started_at,'validatingAt',v.validating_at,'publishedAt',v.published_at,
      'rejectedAt',v.rejected_at,'abandonedAt',v.abandoned_at) AS item
      FROM dataset_versions v ${owner} WHERE v.id=$2`, [session.sessionId, id]);
    if (!result.rows[0]) throw new DemoResourceUnavailableError();
    return result.rows[0].item;
  }

  async jobs(session: AuthenticatedDemoSession, id: string, page: ReadPage) {
    const result = await this.db.query<{ item: DemoJobDto | null }>(`SELECT children.item
      FROM dataset_versions v ${owner}
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object(${job}) AS item,j.id AS sort_id
        FROM calculation_jobs j JOIN calculation_types ct ON ct.id=j.calculation_type_id
        WHERE j.output_dataset_version_id=v.id AND ($3::uuid IS NULL OR j.id>$3)
        ORDER BY j.id LIMIT $4
      ) children ON true WHERE v.id=$2 ORDER BY children.sort_id`,
    [session.sessionId, id, page.after, page.limit + 1]);
    if (!result.rows.length) throw new DemoResourceUnavailableError();
    return publicPage(result.rows.flatMap((r) => r.item ? [r.item] : []), page, 'jobs', readScope(session, id), (r) => r.jobId);
  }

  async job(session: AuthenticatedDemoSession, id: string): Promise<DemoJobDetailDto> {
    const result = await this.db.query<{ item: DemoJobDetailDto }>(`SELECT jsonb_build_object(${job},'datasetStatus',v.status) AS item
      FROM calculation_jobs j JOIN calculation_types ct ON ct.id=j.calculation_type_id
      JOIN dataset_versions v ON v.id=j.output_dataset_version_id ${owner} WHERE j.id=$2`, [session.sessionId, id]);
    if (!result.rows[0]) throw new DemoResourceUnavailableError();
    return result.rows[0].item;
  }

  async attempts(session: AuthenticatedDemoSession, id: string, page: ReadPage) {
    const result = await this.db.query<{ item: DemoAttemptDto | null }>(`SELECT children.item
      FROM calculation_jobs j JOIN dataset_versions v ON v.id=j.output_dataset_version_id ${owner}
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object('executionAttemptId',a.id,'attemptNumber',a.attempt_number,
          'attemptStatus',a.status,'createdAt',a.created_at,'dispatchStartedAt',a.dispatch_started_at,
          'acceptedAt',a.accepted_at,'finishedAt',a.finished_at) AS item,a.attempt_number
        FROM execution_attempts a WHERE a.calculation_job_id=j.id
          AND ($3::integer IS NULL OR a.attempt_number>$3)
        ORDER BY a.attempt_number LIMIT $4
      ) children ON true WHERE j.id=$2 ORDER BY children.attempt_number`,
    [session.sessionId, id, page.after, page.limit + 1]);
    if (!result.rows.length) throw new DemoResourceUnavailableError();
    return publicPage(result.rows.flatMap((r) => r.item ? [r.item] : []), page, 'attempts', readScope(session, id), (r) => r.attemptNumber);
  }
}
