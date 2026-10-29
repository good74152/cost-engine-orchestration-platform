import { readdir } from 'node:fs/promises';
import type { Client, Pool, PoolClient } from 'pg';
import { requireGuidedConfiguration } from '../modules/demo-scenario/demo-scenario.repository.js';
import { lockDemoAdmission } from '../modules/demo-admission/demo-admission.repository.js';
import { lockCutoverConfiguration, verifyCutoverConfiguration } from '../modules/demo-cutover/demo-cutover.configuration.js';

/** Shared inventory check; the caller may retain its own transaction/locks. */
export async function verifyMigrationInventory(db: Pool | PoolClient | Client, migrationsDirectory = 'migrations'): Promise<string[]> {
  const expected = (await readdir(migrationsDirectory)).filter(n => /^\d+_.+\.ts$/.test(n))
    .map(n => n.slice(0, -3)).sort();
  const actual = (await db.query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY name')).rows.map(r => r.name);
  if (!expected.length || JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Demo migration inventory mismatch');
  return expected;
}

/** Read-only gate; never migrates, seeds or repairs during HTTP startup. */
export async function verifyDemoDatabase(db: Pool, migrationsDirectory = 'migrations'): Promise<void> {
  await db.query('SELECT 1');
  await verifyMigrationInventory(db, migrationsDirectory);
  const client = await db.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='5s'");
    const gate = await lockDemoAdmission(client);
    if (gate.state === 'WORKFLOW_OPEN') { await lockCutoverConfiguration(client, false); await verifyCutoverConfiguration(client, 'WORKFLOW'); }
    else await requireGuidedConfiguration(client);
    await client.query('COMMIT');
  } catch (error) { discard = true; await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(discard); }
}
