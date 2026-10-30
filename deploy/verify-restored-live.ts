import { Pool } from 'pg';
import { verifyOperationalDatabase } from '../src/deployment/operational-backup.js';

// Same no-target, no-deployed-secret boundary as the first-deployment verifier.
async function main() {
  const nonce = process.argv[2];
  if (process.argv.length !== 3 || !nonce || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Invalid restore identity');
  const db = new Pool({ host: '127.0.0.1', port: 5432, user: 'restore_owner', database: 'restore_' + nonce,
    connectionTimeoutMillis: 3000, query_timeout: 65000, max: 1 }); db.on('error', () => {});
  try { console.info(JSON.stringify(await verifyOperationalDatabase(db, process.env.DEPLOYMENT_VERSION ?? ''))); }
  finally { await db.end(); }
}
main().catch(() => { console.error('Operational restored database validation failed; no production recovery performed'); process.exitCode = 1; });
