import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { assertDemoEnvironment } from '../src/modules/demo-session/demo-runtime.js';
import { DEMO_CONFIGURATION, DemoConfigurationConflict, verifyDemoConfiguration } from '../src/deployment/demo-configuration.js';

function assertSeedEnvironment(): void {
  if (process.env.APP_MODE !== 'demo') throw new Error('Demo seed requires APP_MODE=demo');
  assertDemoEnvironment();
}

export { DemoConfigurationConflict };

/** Explicit operator/developer command; never called from application startup. */
export async function seedDemoSixDomainConfiguration(db: Pool): Promise<void> {
  assertSeedEnvironment();
  let client: PoolClient | undefined;
  let commitSent = false;
  let discard = false;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    for (const entry of DEMO_CONFIGURATION) {
      // Only brand-new types receive a definition. Existing rows are verified below, never repaired.
      const inserted = await client.query<{ id: string }>(`INSERT INTO calculation_types
        (domain,code,airflow_dag_id,is_active,last_allocated_dependency_definition_version)
        VALUES ($1,$2,$3,true,1) ON CONFLICT (domain,code) DO NOTHING RETURNING id`,
      [entry.domain, entry.code, entry.dag]);
      const type = inserted.rows[0];
      if (!type) continue;
      const definition = (await client.query<{ id: string }>(`INSERT INTO execution_dependency_definition_versions
        (calculation_type_id,version,status,published_at) VALUES ($1,1,'PUBLISHED',now()) RETURNING id`, [type.id])).rows[0]!;
      for (const domain of entry.required) await client.query(`INSERT INTO execution_dependency_definition_dependencies
        (definition_version_id,required_domain) VALUES ($1,$2)`, [definition.id, domain]);
    }
    // Dataset creation snapshots ALL active types, so extras would silently add jobs.
    await verifyDemoConfiguration(client);
    commitSent = true;
    await client.query('COMMIT');
  } catch (error) {
    if (commitSent) discard = true; // Unknown COMMIT: rerun verifies durable rows.
    else if (client) await client.query('ROLLBACK').catch(() => { discard = true; });
    if (error instanceof DemoConfigurationConflict) throw error;
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
    console.error(error instanceof DemoConfigurationConflict ? error.message
      : 'Demo six-domain seed failed; check explicit Demo environment, target and configuration');
    process.exitCode = 1;
  });
}
