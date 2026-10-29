import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { DemoAdmissionOperator } from '../src/modules/demo-admission/demo-admission.operator.js';
import { DemoSessionError } from '../src/modules/demo-session/demo-session.errors.js';

/** Only an explicit Demo target is accepted. DATABASE_URL is never a fallback. */
export async function runDemoAdmissionCommand(operation: string | undefined, extraArguments: readonly string[] = []): Promise<void> {
  if (!['status', 'drain'].includes(operation ?? '') || extraArguments.length) throw new Error('Choose status or drain');
  const direct = process.env.DEMO_ADMISSION_DATABASE_URL;
  const file = process.env.DEMO_ADMISSION_DATABASE_URL_FILE;
  if ((!direct && !file) || (direct && file)) throw new Error('Choose one explicit Demo admission database target');
  const target = direct ?? readFileSync(file!, 'utf8').trim();
  const url = new URL(target);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error('Invalid explicit Demo target');
  const db = new Pool({ connectionString: target, connectionTimeoutMillis: 3000, max: 2 });
  db.on('error', () => {});
  try {
    const operator = new DemoAdmissionOperator(db);
    console.info(JSON.stringify(operation === 'status' ? await operator.status() : await operator.drain()));
  } finally { await db.end(); }
}

export function reportAdmissionCommandError(error: unknown): void {
  console.error(error instanceof DemoSessionError ? `${error.code}: ${error.message}` : 'Demo admission command failed; verify explicit Demo target and command privately');
  process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDemoAdmissionCommand(process.argv[2], process.argv.slice(3)).catch(reportAdmissionCommandError);
}
