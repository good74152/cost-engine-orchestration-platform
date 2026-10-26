import type { Client, Pool, PoolClient } from 'pg';
import { DemoSessionError, DemoSessionUnavailableError } from '../demo-session/demo-session.errors.js';
import type { AuthenticatedDemoSession } from '../demo-session/demo-session.service.js';

export interface DemoScenarioDto {
  scenarioId: string;
  scenarioType: 'HAPPY_PATH' | 'FAILURE_RETRY' | 'LOST_RESPONSE_RECOVERY';
  status: 'READY' | 'IN_PROGRESS' | 'COMPLETED';
  completedStep: number;
  createdAt: string;
  updatedAt: string;
}
const projection = `jsonb_build_object('scenarioId',id,'scenarioType',scenario_type,
  'status',status,'completedStep',completed_step,'createdAt',created_at,'updatedAt',updated_at) AS item`;

export async function lockScenarioSession(client: PoolClient | Client, session: AuthenticatedDemoSession): Promise<void> {
  await client.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [session.sessionId]);
  // Fresh statement AFTER lock acquisition, just like Reset outcome recovery.
  const valid = await client.query(`SELECT id FROM demo_sessions WHERE id=$1 AND company_code=$2
    AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [session.sessionId, session.companyCode]);
  if (valid.rowCount !== 1) throw new DemoSessionUnavailableError();
}

export async function readScenario(db: Pool | PoolClient | Client, sessionId: string, id?: string): Promise<DemoScenarioDto | null> {
  const result = await db.query<{ item: DemoScenarioDto }>(`SELECT ${projection}
    FROM demo_scenario_instances WHERE session_id=$1 AND ($2::uuid IS NULL OR id=$2)`, [sessionId, id ?? null]);
  return result.rows[0]?.item ?? null;
}

/** Read-only compatibility check of Demo-02A's exact seed contract. No seed import or config writes. */
export async function requireGuidedConfiguration(client: PoolClient): Promise<void> {
  const result = await client.query<{ ready: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM calculation_types ct WHERE domain='CAPEX' AND code='DEMO_GUIDED_SUMMARY'
      AND is_active AND airflow_dag_id='demo_capex_guided' AND last_allocated_dependency_definition_version=1
      AND NOT EXISTS (SELECT 1 FROM calculation_types other WHERE other.domain='CAPEX' AND other.is_active AND other.id<>ct.id)
      AND (SELECT count(*) FROM execution_dependency_definition_versions d WHERE d.calculation_type_id=ct.id)=1
      AND EXISTS (SELECT 1 FROM execution_dependency_definition_versions d WHERE d.calculation_type_id=ct.id
        AND d.version=1 AND d.status='PUBLISHED' AND d.published_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM execution_dependency_definition_dependencies e WHERE e.definition_version_id=d.id))
    ) AS ready`);
  if (!result.rows[0]!.ready) throw new DemoSessionError('DEMO_SCENARIO_CONFIGURATION_UNAVAILABLE', 409, 'Demo scenario configuration unavailable');
}

export async function requireEmptyScenarioSession(client: PoolClient, company: string): Promise<void> {
  // All dataset/job/attempt graphs reach their canonical series through FKs.
  const existing = await client.query('SELECT id FROM dataset_series WHERE company_code=$1 LIMIT 1', [company]);
  if (existing.rowCount) throw new DemoSessionError('DEMO_SCENARIO_SESSION_NOT_EMPTY', 409, 'Demo scenario session is not empty');
}

export async function insertScenario(client: PoolClient, sessionId: string): Promise<DemoScenarioDto | null> {
  const result = await client.query<{ item: DemoScenarioDto }>(`INSERT INTO demo_scenario_instances
    (session_id,scenario_type,status,completed_step) VALUES ($1,'HAPPY_PATH','READY',0)
    ON CONFLICT (session_id) DO NOTHING RETURNING ${projection}`, [sessionId]);
  return result.rows[0]?.item ?? null;
}
