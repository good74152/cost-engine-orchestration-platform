import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { DemoCutoverOperator } from '../src/modules/demo-cutover/demo-cutover.operator.js';
import { DemoSessionError } from '../src/modules/demo-session/demo-session.errors.js';

export async function runDemoCutoverCommand(operation: string | undefined, extra: readonly string[] = []): Promise<void> {
  if (!['status','cutover'].includes(operation ?? '') || extra.length) throw new Error('Choose status or cutover');
  const direct = process.env.DEMO_CUTOVER_DATABASE_URL; const file = process.env.DEMO_CUTOVER_DATABASE_URL_FILE;
  if ((!direct && !file) || (direct && file)) throw new Error('Exactly one explicit cutover target required');
  const target = direct ?? readFileSync(file!, 'utf8').trim(); const url = new URL(target);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error('Explicit Demo target required');
  const db = new Pool({ connectionString: target, connectionTimeoutMillis: 3000, query_timeout: 6000, max: 2 }); db.on('error', () => {});
  try { const operator = new DemoCutoverOperator(db); console.info(JSON.stringify(operation === 'status' ? await operator.status() : await operator.cutover())); }
  finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDemoCutoverCommand(process.argv[2], process.argv.slice(3)).catch(error => {
    console.error(error instanceof DemoSessionError ? `${error.code}: ${error.message}` : 'Demo cutover command failed; verify explicit target and command privately'); process.exitCode = 1;
  });
}
