import { readdir } from 'node:fs/promises';
import type { Pool } from 'pg';
import { requireGuidedConfiguration } from '../modules/demo-scenario/demo-scenario.repository.js';

/** Read-only gate; never migrates, seeds or repairs during HTTP startup. */
export async function verifyDemoDatabase(db: Pool, migrationsDirectory = 'migrations'): Promise<void> {
  await db.query('SELECT 1');
  const expected = (await readdir(migrationsDirectory)).filter(n => /^\d+_.+\.ts$/.test(n))
    .map(n => n.slice(0, -3)).sort();
  const actual = (await db.query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY name')).rows.map(r => r.name);
  if (!expected.length || JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Demo migration inventory mismatch');
  const client = await db.connect();
  try { await requireGuidedConfiguration(client); }
  finally { client.release(); }
}
