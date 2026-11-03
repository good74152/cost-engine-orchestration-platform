import { readdir } from 'node:fs/promises';
import type { Client, Pool, PoolClient } from 'pg';
import { verifyDemoConfiguration } from './demo-configuration.js';

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
  await verifyDemoConfiguration(db);
}
