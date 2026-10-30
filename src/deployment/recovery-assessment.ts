import type { Pool, PoolClient } from 'pg';

export const MAX_MANUAL_REVIEW_ITEMS = 10000;
export const jobStatuses = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export const attemptStatuses = ['PREPARED', 'DISPATCHING', 'ACCEPTED', 'SUCCEEDED', 'FAILED', 'DISPATCH_FAILED'] as const;
export type JobStatus = typeof jobStatuses[number];
export type AttemptStatus = typeof attemptStatuses[number];
export type ReviewReason = 'NO_ATTEMPT_NOT_STARTED' | 'PREPARED_NOT_DISPATCHED' | 'DISPATCH_OUTCOME_UNKNOWN'
  | 'ACCEPTED_EXECUTOR_STATE_UNAVAILABLE' | 'DISPATCH_REJECTED_NOT_STARTED' | 'NONTERMINAL_JOB_REQUIRES_REVIEW';
export interface ManualReviewItem {
  jobId: string; attemptId: string | null; jobStatus: JobStatus; attemptStatus: AttemptStatus | null;
  reasonCode: ReviewReason; category: 'NOT_STARTED' | 'POSSIBLE_UNKNOWN_OUTCOME' | 'EXECUTOR_CONFIRMATION_REQUIRED' | 'STORED_STATE_REVIEW';
}
export interface RecoveryAssessment {
  transactionReadOnly: true; jobStatusCounts: Record<JobStatus, number>; attemptStatusCounts: Record<AttemptStatus, number>;
  manualReviewCount: number; manualReview: ManualReviewItem[];
}
const rejected = () => new Error('Read-only recovery assessment failed; manual investigation required');
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);

/** Report classification only. It neither resolves executor truth nor decides
 * eligibility to run/retry a Job. Terminal history is counted without mutation. */
function classify(row: { job_id: string; job_status: string; attempt_id: string | null; attempt_status: string | null }): ManualReviewItem {
  if (!uuid(row.job_id) || (row.attempt_id !== null && !uuid(row.attempt_id)) || !jobStatuses.includes(row.job_status as JobStatus)
    || (row.attempt_id === null) !== (row.attempt_status === null)
    || (row.attempt_status !== null && !attemptStatuses.includes(row.attempt_status as AttemptStatus))) throw rejected();
  const base = { jobId: row.job_id, attemptId: row.attempt_id, jobStatus: row.job_status as JobStatus, attemptStatus: row.attempt_status as AttemptStatus | null };
  if (row.attempt_status === 'PREPARED') return { ...base, reasonCode: 'PREPARED_NOT_DISPATCHED', category: 'NOT_STARTED' };
  if (row.attempt_status === 'DISPATCHING') return { ...base, reasonCode: 'DISPATCH_OUTCOME_UNKNOWN', category: 'POSSIBLE_UNKNOWN_OUTCOME' };
  if (row.attempt_status === 'ACCEPTED') return { ...base, reasonCode: 'ACCEPTED_EXECUTOR_STATE_UNAVAILABLE', category: 'EXECUTOR_CONFIRMATION_REQUIRED' };
  if (row.job_status === 'PENDING' && row.attempt_status === null) return { ...base, reasonCode: 'NO_ATTEMPT_NOT_STARTED', category: 'NOT_STARTED' };
  if (row.job_status === 'PENDING' && row.attempt_status === 'DISPATCH_FAILED') return { ...base, reasonCode: 'DISPATCH_REJECTED_NOT_STARTED', category: 'NOT_STARTED' };
  return { ...base, reasonCode: 'NONTERMINAL_JOB_REQUIRES_REVIEW', category: 'STORED_STATE_REVIEW' };
}

/** Strict allowlist at the private report boundary; no arbitrary strings/columns
 * from restored rows or subprocess output can enter the final report. */
export function parseRecoveryAssessment(input: unknown): RecoveryAssessment {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
  if (!record(input) || !exact(input, ['transactionReadOnly','jobStatusCounts','attemptStatusCounts','manualReviewCount','manualReview'])
    || input.transactionReadOnly !== true || !Array.isArray(input.manualReview) || input.manualReview.length > MAX_MANUAL_REVIEW_ITEMS
    || input.manualReviewCount !== input.manualReview.length) throw rejected();
  const counts = <S extends string>(v: unknown, statuses: readonly S[]): Record<S, number> => {
    if (!record(v) || !exact(v, statuses) || Object.values(v).some(n => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
      || !Number.isSafeInteger(Object.values(v).reduce<number>((total,n) => total + (n as number), 0))) throw rejected();
    return Object.fromEntries(statuses.map(s => [s, v[s]])) as Record<S, number>;
  };
  const jobs = new Set<string>();
  const manualReview = input.manualReview.map((item: unknown) => {
    if (!record(item) || !exact(item, ['jobId','attemptId','jobStatus','attemptStatus','reasonCode','category'])) throw rejected();
    const parsed = classify({ job_id: item.jobId as string, job_status: item.jobStatus as string, attempt_id: item.attemptId as string | null, attempt_status: item.attemptStatus as string | null });
    if (parsed.reasonCode !== item.reasonCode || parsed.category !== item.category || jobs.has(parsed.jobId)) throw rejected(); jobs.add(parsed.jobId); return parsed;
  });
  return { transactionReadOnly: true, jobStatusCounts: counts(input.jobStatusCounts, jobStatuses), attemptStatusCounts: counts(input.attemptStatusCounts, attemptStatuses),
    manualReviewCount: manualReview.length, manualReview };
}

/** Fresh, actual PostgreSQL READ ONLY transaction; no DML/DDL, locks for update,
 * runtime, executor, Session invalidation or recovery command is imported. */
export async function assessRecovery(db: Pool): Promise<RecoveryAssessment> {
  let client: PoolClient | undefined;
  try {
    client = await db.connect(); await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='60s'"); await client.query('SET LOCAL search_path=pg_catalog,public');
    if ((await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only !== 'on') throw rejected();
    const jobStatusCounts = Object.fromEntries(jobStatuses.map(s => [s, 0])) as Record<JobStatus, number>;
    const attemptStatusCounts = Object.fromEntries(attemptStatuses.map(s => [s, 0])) as Record<AttemptStatus, number>;
    for (const [table, counts] of [['calculation_jobs', jobStatusCounts], ['execution_attempts', attemptStatusCounts]] as const) {
      const rows = (await client.query<{ status: string; n: string }>(`SELECT status,count(*) AS n FROM public.${table} GROUP BY status ORDER BY status`)).rows;
      for (const row of rows) {
        const n = Number(row.n); if (!(row.status in counts) || !Number.isSafeInteger(n) || n < 0) throw rejected();
        (counts as Record<string, number>)[row.status] = n;
      }
    }
    const rows = (await client.query<{ job_id: string; job_status: string; attempt_id: string | null; attempt_status: string | null }>(`
      WITH latest AS (
        SELECT DISTINCT ON (calculation_job_id) calculation_job_id,id,status FROM execution_attempts
        ORDER BY calculation_job_id,attempt_number DESC,id
      ), active AS (
        SELECT calculation_job_id,id,status FROM execution_attempts WHERE status IN ('PREPARED','DISPATCHING','ACCEPTED')
      ) SELECT j.id AS job_id,j.status AS job_status,coalesce(a.id,l.id) AS attempt_id,coalesce(a.status,l.status) AS attempt_status
        FROM calculation_jobs j LEFT JOIN active a ON a.calculation_job_id=j.id LEFT JOIN latest l ON l.calculation_job_id=j.id
        WHERE j.status IN ('PENDING','RUNNING') OR a.id IS NOT NULL ORDER BY j.id,coalesce(a.id,l.id)
        LIMIT $1`, [MAX_MANUAL_REVIEW_ITEMS + 1])).rows;
    if (rows.length > MAX_MANUAL_REVIEW_ITEMS) throw rejected(); // Never truncate a successful report.
    const manualReview = rows.map(classify);
    await client.query('ROLLBACK');
    return { transactionReadOnly: true, jobStatusCounts, attemptStatusCounts, manualReviewCount: manualReview.length, manualReview };
  } catch { await client?.query('ROLLBACK').catch(() => {}); throw rejected(); }
  finally { client?.release(true); }
}
