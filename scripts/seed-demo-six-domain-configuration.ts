import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { assertDemoEnvironment } from '../src/modules/demo-session/demo-runtime.js';

// Demo data only. Core services discover configuration from PostgreSQL.
// Keep (domain,code) order identical for concurrent explicit seed invocations.
const configuration = [
  { domain: 'CAPEX', code: 'DEMO_GUIDED_SUMMARY', dag: 'demo_capex_guided', required: [] },
  { domain: 'DPR', code: 'DEMO_DPR_TABLE_X', dag: 'demo_dpr_table_x', required: ['CAPEX'] },
  { domain: 'DPR', code: 'DEMO_DPR_TABLE_Y', dag: 'demo_dpr_table_y', required: ['CAPEX'] },
  { domain: 'E2E_COST', code: 'DEMO_E2E_COST_TABLE_X', dag: 'demo_e2e_cost_table_x', required: ['ONE_STD_COST'] },
  { domain: 'E2E_COST', code: 'DEMO_E2E_COST_TABLE_Y', dag: 'demo_e2e_cost_table_y', required: ['ONE_STD_COST'] },
  { domain: 'FAB_COST', code: 'DEMO_FAB_COST_SUMMARY', dag: 'demo_fab_cost_summary', required: [] },
  { domain: 'INSURANCE', code: 'DEMO_INSURANCE_SUMMARY', dag: 'demo_insurance_summary', required: ['FAB_COST'] },
  { domain: 'ONE_STD_COST', code: 'DEMO_ONE_STD_COST_TABLE_X', dag: 'demo_one_std_cost_table_x', required: ['FAB_COST'] },
  { domain: 'ONE_STD_COST', code: 'DEMO_ONE_STD_COST_TABLE_Y', dag: 'demo_one_std_cost_table_y', required: ['FAB_COST'] },
] as const;

export class DemoSixDomainConfigurationConflict extends Error {
  constructor() {
    super('DEMO_CONFIGURATION_CONFLICT: existing configuration does not match the six-domain Demo seed');
  }
}

function assertSeedEnvironment(): void {
  if (process.env.APP_MODE !== 'demo') throw new Error('Demo seed requires APP_MODE=demo');
  assertDemoEnvironment();
}

/** Explicit operator/developer command; never called from application startup. */
export async function seedDemoSixDomainConfiguration(db: Pool): Promise<void> {
  assertSeedEnvironment();
  let client: PoolClient | undefined;
  let commitSent = false;
  let discard = false;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    for (const entry of configuration) {
      const inserted = await client.query<{ id: string }>(`INSERT INTO calculation_types
        (domain,code,airflow_dag_id,is_active,last_allocated_dependency_definition_version)
        VALUES ($1,$2,$3,true,1) ON CONFLICT (domain,code) DO NOTHING RETURNING id`,
      [entry.domain, entry.code, entry.dag]);
      const type = (await client.query<{ id: string; airflow_dag_id: string; is_active: boolean;
        last_allocated_dependency_definition_version: number }>(`SELECT id,airflow_dag_id,is_active,
        last_allocated_dependency_definition_version FROM calculation_types
        WHERE domain=$1 AND code=$2 FOR UPDATE`, [entry.domain, entry.code])).rows[0];
      if (!type || !type.is_active || type.airflow_dag_id !== entry.dag
        || type.last_allocated_dependency_definition_version !== 1) throw new DemoSixDomainConfigurationConflict();

      // Only brand-new types receive a new definition. Existing rows, including
      // publication timestamps and UUIDs, are verified without UPDATE/repair.
      if (inserted.rowCount) {
        const definition = (await client.query<{ id: string }>(`INSERT INTO execution_dependency_definition_versions
          (calculation_type_id,version,status,published_at) VALUES ($1,1,'PUBLISHED',now()) RETURNING id`, [type.id])).rows[0]!;
        for (const domain of entry.required) await client.query(`INSERT INTO execution_dependency_definition_dependencies
          (definition_version_id,required_domain) VALUES ($1,$2)`, [definition.id, domain]);
      }
      const definitions = await client.query<{ version: number; status: string; published_at: Date | null; required: string[] }>(
        `SELECT d.version,d.status,d.published_at, ARRAY(SELECT required_domain
          FROM execution_dependency_definition_dependencies e WHERE e.definition_version_id=d.id ORDER BY required_domain) AS required
         FROM execution_dependency_definition_versions d WHERE d.calculation_type_id=$1`, [type.id]);
      const definition = definitions.rows[0];
      if (definitions.rowCount !== 1 || !definition || definition.version !== 1
        || definition.status !== 'PUBLISHED' || !definition.published_at
        || JSON.stringify(definition.required) !== JSON.stringify(entry.required)) {
        throw new DemoSixDomainConfigurationConflict();
      }
    }
    // Dataset creation snapshots ALL active types. Refuse extras instead of
    // silently creating more jobs than this Demo contract specifies.
    for (const domain of [...new Set(configuration.map(entry => entry.domain))]) {
      const codes = configuration.filter(entry => entry.domain === domain).map(entry => entry.code);
      const extra = await client.query(`SELECT 1 FROM calculation_types
        WHERE domain=$1 AND is_active AND code<>ALL($2::text[]) LIMIT 1`, [domain, codes]);
      if (extra.rowCount) throw new DemoSixDomainConfigurationConflict();
    }
    commitSent = true;
    await client.query('COMMIT');
  } catch (error) {
    if (commitSent) discard = true; // Unknown COMMIT: rerun verifies durable rows.
    else if (client) await client.query('ROLLBACK').catch(() => { discard = true; });
    if (error instanceof DemoSixDomainConfigurationConflict) throw error;
    throw new Error('Demo six-domain seed persistence failed; rerun to verify durable configuration');
  } finally { client?.release(discard); }
}

export async function runDemoSixDomainSeed(): Promise<void> {
  assertSeedEnvironment();
  if (!process.env.DEMO_SEED_DATABASE_URL) throw new Error('Demo seed requires explicit DEMO_SEED_DATABASE_URL');
  const db = new Pool({ connectionString: process.env.DEMO_SEED_DATABASE_URL });
  try {
    await seedDemoSixDomainConfiguration(db);
    console.info('Demo six-domain configuration ready');
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDemoSixDomainSeed().catch((error: unknown) => {
    console.error(error instanceof DemoSixDomainConfigurationConflict ? error.message
      : 'Demo six-domain seed failed; check explicit Demo environment, target and configuration');
    process.exitCode = 1;
  });
}
