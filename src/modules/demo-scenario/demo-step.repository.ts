import type { Client, Pool, PoolClient } from 'pg';
import type { AuthenticatedDemoSession } from '../demo-session/demo-session.service.js';
import type { RunnableScenarioType } from './demo-step.plan.js';

export interface StepResult {
  datasetVersionId: string;
  jobId: string;
  datasetStatus: string;
  jobStatus: string;
  executionAttemptId?: string;
  attemptNumber?: number;
  attemptStatus?: string;
  datasetBuildSnapshotId?: string;
  resolvedDependencyDefinitionVersionId?: string;
  externalStatus?: 'SUCCEEDED' | 'FAILED';
}
export interface StepResponse {
  scenarioId: string; stepNumber: number; requestId: string;
  stepStatus: 'COMPLETED' | 'PENDING'; completedStep: number;
  scenarioStatus: 'READY' | 'IN_PROGRESS' | 'COMPLETED'; stepResult: StepResult;
}
export interface StepIntent {
  domain?: string; companyCode?: string; fiscalYear?: number; period?: string;
  expectedVersion?: number; calculationTypeCode?: string;
  datasetVersionId?: string; jobId?: string; executionAttemptId?: string;
  datasetBuildSnapshotId?: string; resolvedDependencyDefinitionVersionId?: string;
  airflowDagId?: string; airflowDagRunId?: string;
  previousExecutionAttemptId?: string; previousAttemptStatus?: 'FAILED';
  previousAttemptHistory?: Record<string, unknown>; expectedAttemptNumber?: 2;
}
export interface StepLedger {
  id: string; scenario_id: string; step_number: number; request_id: string;
  scenario_type: RunnableScenarioType;
  status: 'PENDING' | 'COMPLETED'; intent: StepIntent; result: StepResponse | null;
}
export async function readLedgers(db: Pool | PoolClient | Client, scenarioId: string): Promise<StepLedger[]> {
  return (await db.query<StepLedger>(`SELECT l.id,scenario_id,step_number,request_id,l.status,intent,result,sc.scenario_type
    FROM demo_scenario_step_executions l JOIN demo_scenario_instances sc ON sc.id=l.scenario_id
    WHERE scenario_id=$1 ORDER BY step_number`, [scenarioId])).rows;
}

export interface GuidedState {
  id: string; counter: number;
  versions: { id: string; version: number; status: string }[];
  jobs: { id: string; dataset: string; status: string; type: string; domain: string; definition: string | null }[];
  snapshots: { id: string; dataset: string; dependencies: number }[];
  attempts: { id: string; job: string; number: number; status: string; dag: string; run: string; history: Record<string, unknown> }[];
  definitions: { id: string; version: number; status: string; dependencies: number }[];
}
/** One SQL snapshot, exact canonical series, NEVER latest-version resolution. */
export async function readGuidedState(db: Pool | PoolClient, session: AuthenticatedDemoSession): Promise<GuidedState | null> {
  return (await db.query<{ item: GuidedState }>(`SELECT jsonb_build_object('id',ds.id,'counter',ds.last_allocated_version,
    'versions',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'version',v.version,'status',v.status)),'[]')
      FROM dataset_versions v WHERE v.dataset_series_id=ds.id),
    'jobs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',j.id,'dataset',v.id,'status',j.status,
      'type',ct.code,'domain',ct.domain,'definition',j.resolved_dependency_definition_version_id)),'[]')
      FROM dataset_versions v JOIN calculation_jobs j ON j.output_dataset_version_id=v.id
      JOIN calculation_types ct ON ct.id=j.calculation_type_id WHERE v.dataset_series_id=ds.id),
    'snapshots',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'dataset',v.id,'dependencies',
      (SELECT count(*) FROM dataset_build_snapshot_dependencies d WHERE d.snapshot_id=b.id))),'[]')
      FROM dataset_versions v JOIN dataset_build_snapshots b ON b.dataset_version_id=v.id WHERE v.dataset_series_id=ds.id),
    'attempts',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'job',j.id,'number',a.attempt_number,
      'status',a.status,'dag',a.airflow_dag_id,'run',a.airflow_dag_run_id,'history',to_jsonb(a))),'[]')
      FROM dataset_versions v JOIN calculation_jobs j ON j.output_dataset_version_id=v.id
      JOIN execution_attempts a ON a.calculation_job_id=j.id WHERE v.dataset_series_id=ds.id),
    'definitions',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'version',d.version,'status',d.status,
      'dependencies',(SELECT count(*) FROM execution_dependency_definition_dependencies e WHERE e.definition_version_id=d.id))),'[]')
      FROM execution_dependency_definition_versions d JOIN calculation_jobs j ON j.resolved_dependency_definition_version_id=d.id
      JOIN dataset_versions v ON v.id=j.output_dataset_version_id WHERE v.dataset_series_id=ds.id)) AS item
    FROM dataset_series ds JOIN demo_sessions s ON s.company_code=ds.company_code
    WHERE s.id=$1 AND ds.domain='CAPEX' AND ds.company_code=$2 AND ds.fiscal_year=2026 AND ds.period='Q4'`,
  [session.sessionId, session.companyCode])).rows[0]?.item ?? null;
}

/** Wait out any earlier unknown Domain COMMIT before inspecting recovery truth.
 * No service/executor call is made here; these locks are released immediately.
 * Existing lock order remains version -> job -> attempt, never inverted. */
export async function readSettledGuidedState(db: Pool, session: AuthenticatedDemoSession, intent: StepIntent): Promise<GuidedState | null> {
  const client = await db.connect(); let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='2s'");
    if (intent.datasetVersionId) {
      await client.query('SELECT id FROM dataset_versions WHERE id=$1 FOR UPDATE', [intent.datasetVersionId]);
      await client.query('SELECT id FROM calculation_jobs WHERE id=$1 FOR UPDATE', [intent.jobId]);
      await client.query('SELECT id FROM execution_attempts WHERE calculation_job_id=$1 ORDER BY attempt_number FOR UPDATE', [intent.jobId]);
    } else {
      await client.query(`SELECT id FROM dataset_series WHERE domain='CAPEX' AND company_code=$1
        AND fiscal_year=2026 AND period='Q4' FOR UPDATE`, [session.companyCode]);
    }
    const state = await readGuidedState(client, session);
    await client.query('COMMIT');
    return state;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { discard = true; }); throw error;
  } finally { client.release(discard); }
}
