import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { assertDemoEnvironment } from '../src/modules/demo-session/demo-runtime.js';

export class DemoConfigurationConflict extends Error {
  constructor() { super('DEMO_CONFIGURATION_CONFLICT: expected only active CAPEX/DEMO_GUIDED_SUMMARY, demo_capex_guided, published definition 1 with no dependencies and allocation counter 1'); }
}

/** Explicit developer operation only. Never imported by application startup. */
export async function seedDemoGuidedConfiguration(db: Pool): Promise<{ calculationTypeId: string; definitionVersionId: string }> {
  if (process.env.APP_MODE !== 'demo') throw new Error('Demo seed requires APP_MODE=demo');
  assertDemoEnvironment();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(`INSERT INTO calculation_types
      (domain,code,airflow_dag_id,is_active,last_allocated_dependency_definition_version)
      VALUES ('CAPEX','DEMO_GUIDED_SUMMARY','demo_capex_guided',true,1)
      ON CONFLICT (domain,code) DO NOTHING RETURNING id`);
    // Same-seed invocations serialize on the existing type, as configuration
    // readers/writers do. No session or orchestration lock protocol is changed.
    const type = (await client.query<{ id: string; airflow_dag_id: string; is_active: boolean;
      last_allocated_dependency_definition_version: number }>(`SELECT id,airflow_dag_id,is_active,
      last_allocated_dependency_definition_version FROM calculation_types
      WHERE domain='CAPEX' AND code='DEMO_GUIDED_SUMMARY' FOR UPDATE`)).rows[0]!;
    const others = await client.query(`SELECT id FROM calculation_types
      WHERE domain='CAPEX' AND is_active AND id<>$1 LIMIT 1`, [type.id]);
    if (others.rowCount || !type.is_active || type.airflow_dag_id !== 'demo_capex_guided'
      || type.last_allocated_dependency_definition_version !== 1) throw new DemoConfigurationConflict();
    if (inserted.rowCount) await client.query(`INSERT INTO execution_dependency_definition_versions
      (calculation_type_id,version,status,published_at) VALUES ($1,1,'PUBLISHED',now())`, [type.id]);
    const definitions = await client.query<{ id: string; version: number; status: string; published_at: Date | null; dependencies: number }>(
      `SELECT d.id,d.version,d.status,d.published_at,
        (SELECT count(*)::int FROM execution_dependency_definition_dependencies e WHERE e.definition_version_id=d.id) AS dependencies
       FROM execution_dependency_definition_versions d WHERE d.calculation_type_id=$1`, [type.id]);
    const definition = definitions.rows[0];
    if (definitions.rows.length !== 1 || !definition || definition.version !== 1
      || definition.status !== 'PUBLISHED' || !definition.published_at || definition.dependencies !== 0) {
      throw new DemoConfigurationConflict();
    }
    await client.query('COMMIT');
    return { calculationTypeId: type.id, definitionVersionId: definition.id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof DemoConfigurationConflict) throw error;
    throw new Error('Demo configuration seed persistence failed');
  } finally { client.release(); }
}

export async function runDemoSeed(): Promise<void> {
  // Validate before opening a connection, with no DATABASE_URL fallback.
  if (process.env.APP_MODE !== 'demo') throw new Error('Demo seed requires APP_MODE=demo');
  assertDemoEnvironment();
  if (!process.env.DEMO_SEED_DATABASE_URL) throw new Error('Demo seed requires explicit DEMO_SEED_DATABASE_URL');
  const db = new Pool({ connectionString: process.env.DEMO_SEED_DATABASE_URL });
  try {
    await seedDemoGuidedConfiguration(db);
    console.info('Demo guided configuration ready');
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDemoSeed().catch((error: unknown) => {
    console.error(error instanceof DemoConfigurationConflict ? error.message : 'Demo configuration seed failed; check explicit Demo environment, target and configuration');
    process.exitCode = 1;
  });
}
