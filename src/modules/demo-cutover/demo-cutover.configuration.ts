import type { Client, PoolClient } from 'pg';
import { DemoSessionError } from '../demo-session/demo-session.errors.js';

type Connection = Client | PoolClient;
export type ConfigurationMode = 'LEGACY' | 'WORKFLOW';
export const configurationConflict = () => new DemoSessionError('DEMO_CUTOVER_CONFIGURATION_CONFLICT', 503, 'Demo configuration does not match the required cutover contract');
const legacy = [
  ['CAPEX', 'DEMO_GUIDED_SUMMARY', 'demo_capex_guided', []],
  ['DPR', 'DEMO_DPR_TABLE_X', 'demo_dpr_table_x', ['CAPEX']],
  ['DPR', 'DEMO_DPR_TABLE_Y', 'demo_dpr_table_y', ['CAPEX']],
  ['E2E_COST', 'DEMO_E2E_COST_TABLE_X', 'demo_e2e_cost_table_x', ['ONE_STD_COST']],
  ['E2E_COST', 'DEMO_E2E_COST_TABLE_Y', 'demo_e2e_cost_table_y', ['ONE_STD_COST']],
  ['FAB_COST', 'DEMO_FAB_COST_SUMMARY', 'demo_fab_cost_summary', []],
  ['INSURANCE', 'DEMO_INSURANCE_SUMMARY', 'demo_insurance_summary', ['FAB_COST']],
  ['ONE_STD_COST', 'DEMO_ONE_STD_COST_TABLE_X', 'demo_one_std_cost_table_x', ['FAB_COST']],
  ['ONE_STD_COST', 'DEMO_ONE_STD_COST_TABLE_Y', 'demo_one_std_cost_table_y', ['FAB_COST']],
] as const;
interface TypeRow { id: string; domain: string; code: string; airflow_dag_id: string; is_active: boolean; last_allocated_dependency_definition_version: number }

/** Exact, read-only dedicated-Demo catalog contract, including all definition history. */
export async function verifyCutoverConfiguration(client: Connection, mode: ConfigurationMode): Promise<void> {
  const expected: Array<{ domain: string; code: string; dag: string; definitions: readonly (readonly string[])[] }> = legacy.map(([domain, code, dag, deps]) => ({
    domain, code, dag, definitions: mode === 'WORKFLOW' && domain === 'CAPEX' ? [deps, ['FAB_COST']] : [deps],
  }));
  if (mode === 'WORKFLOW') expected.push({ domain: 'CAPEX', code: 'DEMO_CAPEX_TABLE_Y', dag: 'demo_capex_table_y', definitions: [['FAB_COST']] });
  const types = (await client.query<TypeRow>(`SELECT id,domain,code,airflow_dag_id,is_active,last_allocated_dependency_definition_version
    FROM calculation_types ORDER BY domain,code`)).rows;
  if (types.length !== expected.length) throw configurationConflict();
  for (const entry of expected) {
    const type = types.find(row => row.domain === entry.domain && row.code === entry.code);
    if (!type || !type.is_active || type.airflow_dag_id !== entry.dag
      || type.last_allocated_dependency_definition_version !== entry.definitions.length) throw configurationConflict();
    const definitions = (await client.query<{ version: number; status: string; published_at: Date | null; required: string[] }>(
      `SELECT d.version,d.status,d.published_at,ARRAY(SELECT required_domain FROM execution_dependency_definition_dependencies e
        WHERE e.definition_version_id=d.id ORDER BY required_domain) AS required
       FROM execution_dependency_definition_versions d WHERE d.calculation_type_id=$1 ORDER BY d.version`, [type.id])).rows;
    if (definitions.length !== entry.definitions.length) throw configurationConflict();
    for (const [index, required] of entry.definitions.entries()) {
      const definition = definitions[index];
      if (!definition || definition.version !== index + 1 || definition.status !== 'PUBLISHED' || !definition.published_at
        || JSON.stringify(definition.required) !== JSON.stringify(required)) throw configurationConflict();
    }
  }
}

export async function lockCutoverConfiguration(client: Connection, write: boolean): Promise<void> {
  await client.query(`LOCK TABLE calculation_types,execution_dependency_definition_versions,execution_dependency_definition_dependencies
    IN ${write ? 'SHARE ROW EXCLUSIVE' : 'SHARE'} MODE`);
  if (write) {
    await client.query('SELECT id FROM calculation_types ORDER BY domain,code FOR UPDATE');
    await client.query(`SELECT d.id FROM execution_dependency_definition_versions d JOIN calculation_types t ON t.id=d.calculation_type_id
      ORDER BY t.domain,t.code,d.version FOR UPDATE OF d`);
  }
}

export async function requireCutoverQuiescence(client: Connection): Promise<void> {
  await client.query(`LOCK TABLE demo_sessions,demo_scenario_instances,demo_scenario_step_executions,
    dataset_series,dataset_versions,calculation_jobs,execution_attempts,dataset_build_snapshots,dataset_build_snapshot_dependencies IN SHARE MODE`);
  const row = (await client.query<{ blocked: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM demo_sessions WHERE revoked_at IS NULL AND expires_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM demo_scenario_instances)
    OR EXISTS(SELECT 1 FROM demo_scenario_step_executions)
    OR EXISTS(SELECT 1 FROM dataset_series d JOIN demo_sessions s ON s.company_code=d.company_code) AS blocked`)).rows[0];
  if (!row || row.blocked) throw new DemoSessionError('DEMO_CUTOVER_PRECONDITION_FAILED', 503, 'Demo sessions or retained work prevent cutover; operator cleanup and offline checks required');
}

export async function applyCapexCutover(client: Connection): Promise<void> {
  const summary = (await client.query<{ id: string }>("SELECT id FROM calculation_types WHERE domain='CAPEX' AND code='DEMO_GUIDED_SUMMARY'")).rows[0]!;
  const before = (await client.query('SELECT to_jsonb(d) AS row FROM execution_dependency_definition_versions d WHERE calculation_type_id=$1 AND version=1', [summary.id])).rows;
  const next = (await client.query<{ id: string }>(`INSERT INTO execution_dependency_definition_versions(calculation_type_id,version,status,published_at)
    VALUES($1,2,'PUBLISHED',clock_timestamp()) RETURNING id`, [summary.id])).rows[0]!;
  await client.query("INSERT INTO execution_dependency_definition_dependencies VALUES($1,'FAB_COST')", [next.id]);
  await client.query('UPDATE calculation_types SET last_allocated_dependency_definition_version=2 WHERE id=$1', [summary.id]);
  const added = (await client.query<{ id: string }>(`INSERT INTO calculation_types(domain,code,airflow_dag_id,is_active,last_allocated_dependency_definition_version)
    VALUES('CAPEX','DEMO_CAPEX_TABLE_Y','demo_capex_table_y',true,1) RETURNING id`)).rows[0]!;
  const definition = (await client.query<{ id: string }>(`INSERT INTO execution_dependency_definition_versions(calculation_type_id,version,status,published_at)
    VALUES($1,1,'PUBLISHED',clock_timestamp()) RETURNING id`, [added.id])).rows[0]!;
  await client.query("INSERT INTO execution_dependency_definition_dependencies VALUES($1,'FAB_COST')", [definition.id]);
  const after = (await client.query('SELECT to_jsonb(d) AS row FROM execution_dependency_definition_versions d WHERE calculation_type_id=$1 AND version=1', [summary.id])).rows;
  if (JSON.stringify(before) !== JSON.stringify(after)) throw configurationConflict();
}
