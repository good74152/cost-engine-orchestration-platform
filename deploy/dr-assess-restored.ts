import { Pool } from 'pg';
import { assessRecovery } from '../src/deployment/recovery-assessment.js';

// Only the existing harness's internally generated disposable identity is used.
// This process is network-none (shared owned restore namespace), read-only and
// given no deployed secrets, supplied Database URL, runtime or FakeExecutor.
async function main() {
  const nonce = process.argv[2];
  if (process.argv.length !== 3 || !nonce || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Invalid drill identity');
  const db = new Pool({ host: '127.0.0.1', port: 5432, user: 'restore_owner', database: 'restore_' + nonce,
    connectionTimeoutMillis: 3000, query_timeout: 65000, max: 1 }); db.on('error', () => {});
  try { console.info(JSON.stringify(await assessRecovery(db))); } finally { await db.end(); }
}
main().catch(() => { console.error('Read-only drill assessment failed'); process.exitCode = 1; });
