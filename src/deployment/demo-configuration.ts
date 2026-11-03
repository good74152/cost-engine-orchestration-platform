import type { Client, Pool, PoolClient } from 'pg';

// Demo data only. Core services discover configuration from PostgreSQL.
// Keep (domain,code) order for concurrent explicit seed invocations.
export const DEMO_CONFIGURATION = [
  { domain: 'CAPEX', code: 'DEMO_CAPEX_SUMMARY', dag: 'demo_capex_summary', required: ['FAB_COST'] },
  { domain: 'CAPEX', code: 'DEMO_CAPEX_TABLE_Y', dag: 'demo_capex_table_y', required: ['FAB_COST'] },
  { domain: 'DPR', code: 'DEMO_DPR_TABLE_X', dag: 'demo_dpr_table_x', required: ['CAPEX'] },
  { domain: 'DPR', code: 'DEMO_DPR_TABLE_Y', dag: 'demo_dpr_table_y', required: ['CAPEX'] },
  { domain: 'E2E_COST', code: 'DEMO_E2E_COST_TABLE_X', dag: 'demo_e2e_cost_table_x', required: ['ONE_STD_COST'] },
  { domain: 'E2E_COST', code: 'DEMO_E2E_COST_TABLE_Y', dag: 'demo_e2e_cost_table_y', required: ['ONE_STD_COST'] },
  { domain: 'FAB_COST', code: 'DEMO_FAB_COST_SUMMARY', dag: 'demo_fab_cost_summary', required: [] },
  { domain: 'INSURANCE', code: 'DEMO_INSURANCE_SUMMARY', dag: 'demo_insurance_summary', required: ['FAB_COST'] },
  { domain: 'ONE_STD_COST', code: 'DEMO_ONE_STD_COST_TABLE_X', dag: 'demo_one_std_cost_table_x', required: ['FAB_COST'] },
  { domain: 'ONE_STD_COST', code: 'DEMO_ONE_STD_COST_TABLE_Y', dag: 'demo_one_std_cost_table_y', required: ['FAB_COST'] },
] as const;

export class DemoConfigurationConflict extends Error {
  constructor() { super('DEMO_CONFIGURATION_CONFLICT: existing configuration does not match the Demo seed'); }
}

/**
 * Read-only check that the database holds exactly this configuration: no missing or extra
 * types, and one published definition each. One statement, so it reads one snapshot.
 */
export async function verifyDemoConfiguration(db: Pool | PoolClient | Client): Promise<void> {
  const { rows } = await db.query(`SELECT t.domain, t.code, t.airflow_dag_id AS dag, t.is_active,
      t.last_allocated_dependency_definition_version AS last_version,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('version', d.version, 'status', d.status, 'published', d.published_at IS NOT NULL,
        'required', (SELECT coalesce(jsonb_agg(e.required_domain ORDER BY e.required_domain), '[]')
          FROM execution_dependency_definition_dependencies e WHERE e.definition_version_id = d.id))), '[]')
        FROM execution_dependency_definition_versions d WHERE d.calculation_type_id = t.id) AS definitions
    FROM calculation_types t ORDER BY t.domain COLLATE "C", t.code COLLATE "C"`);
  const expected = DEMO_CONFIGURATION.map(({ domain, code, dag, required }) => ({ domain, code, dag, is_active: true, last_version: 1,
    definitions: [{ version: 1, status: 'PUBLISHED', published: true, required }] }));
  const canonical = (value: unknown) => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
  if (canonical(rows) !== canonical(expected)) throw new DemoConfigurationConflict();
}
