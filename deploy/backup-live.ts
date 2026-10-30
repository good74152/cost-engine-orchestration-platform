import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Pool, type PoolClient } from 'pg';
import { beginOperationalBackup, backupUnavailable } from '../src/deployment/operational-backup.js';

// A single foreground backup's snapshot holder, not a runtime/background worker.
// The POSIX caller keeps stdin open until pg_dump exits and waits for our exit.
export async function runLiveBackupSnapshot(): Promise<void> {
  const file = process.env.DEMO_LIVE_BACKUP_DATABASE_URL_FILE;
  if (file !== '/run/secrets/database_url' || process.env.DEMO_LIVE_BACKUP_DATABASE_URL) throw backupUnavailable();
  const target = readFileSync(file, 'utf8').trim(); const url = new URL(target);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'database' || url.username !== 'demo_owner'
    || url.pathname !== '/cost_engine_demo' || !['', '5432'].includes(url.port) || url.search || url.hash) throw backupUnavailable();
  const db = new Pool({ connectionString: target, connectionTimeoutMillis: 3000, query_timeout: 65000, max: 1,
    application_name: 'cost-engine-operational-backup' });
  db.on('error', () => {});
  const input = createInterface({ input: process.stdin, terminal: false });
  const release = new Promise<boolean>(resolve => { input.once('line', line => resolve(line === 'DUMP_COMPLETE')); input.once('close', () => resolve(false)); });
  const deadline = setTimeout(() => process.exit(1), 60 * 60 * 1000);
  let client: PoolClient | undefined;
  try {
    client = await db.connect();
    // A lost database connection must never be mistaken for an intact snapshot.
    client.on('error', () => process.exit(1));
    const evidence = await beginOperationalBackup(client, process.env.DEPLOYMENT_VERSION ?? '');
    const snapshot = (await client.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot')).rows[0]?.snapshot;
    if (!snapshot || !/^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/.test(snapshot)) throw backupUnavailable();
    console.info(JSON.stringify({ snapshot, evidence }));
    if (!await release) throw backupUnavailable();
    // pg_dump has completed successfully. Confirm that the holder is still alive,
    // then release only read locks; no business transaction is committed here.
    await client.query('SELECT 1'); await client.query('ROLLBACK');
  } catch { await client?.query('ROLLBACK').catch(() => {}); throw backupUnavailable(); }
  finally { clearTimeout(deadline); input.close(); client?.release(true); await db.end(); }
}
