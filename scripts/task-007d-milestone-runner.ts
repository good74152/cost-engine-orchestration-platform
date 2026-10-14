import 'dotenv/config';
import { spawn } from 'node:child_process';

type Counts = { pass: number | null; fail: number | null; skip: number | null };
type SuiteResult = Counts & { command: string; exitCode: number | null; status: 'PASS' | 'FAIL' | 'NOT RUN' };

const suites = [
  { label: 'npm run build', command: 'build' },
  { label: 'npm run test:orchestration-schema-v2', command: 'test:orchestration-schema-v2' },
  { label: 'npm run test:dataset-version-creation-v2', command: 'test:dataset-version-creation-v2' },
  { label: 'npm run test:first-run-immutable-build-snapshot', command: 'test:first-run-immutable-build-snapshot' },
  { label: 'npm run test:execution-attempt-dispatch-fake-executor', command: 'test:execution-attempt-dispatch-fake-executor' },
  { label: 'npm run test:executor-reconciliation', command: 'test:executor-reconciliation' },
  { label: 'npm run test:dataset-version-terminal-lifecycle', command: 'test:dataset-version-terminal-lifecycle' },
  { label: 'npm run test:cross-workflow-concurrency-investigation', command: 'test:cross-workflow-concurrency-investigation' },
  { label: 'npm run test:task-007b1-late-dispatch-reconciliation', command: 'test:task-007b1-late-dispatch-reconciliation' },
  { label: 'npm run test:task-007c-api-contract', command: 'test:task-007c-api-contract' },
  { label: 'npm run test:raw-ingestion (owned disposable PostgreSQL database)', command: 'raw-isolated' },
  { label: 'npm run test:task-007d-end-to-end', command: 'test:task-007d-end-to-end' },
] as const;

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const nodeEnvironment = { ...process.env, NODE_ENV: 'test' };

async function execute(label: string, command: string): Promise<SuiteResult> {
  const executable = command === 'raw-isolated' ? process.execPath : npm;
  const args = command === 'raw-isolated'
    ? ['--import', 'tsx', 'scripts/support/task-007d-isolated-raw-ingestion.ts']
    : ['run', command];
  console.log(`\nMILESTONE_START ${label}`);
  const output: string[] = [];
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(executable, args, { env: nodeEnvironment, stdio: ['inherit', 'pipe', 'pipe'] });
    let closed = false;
    function finish(code: number) { if (!closed) { closed = true; resolve(code); } }
    function capture(chunk: Buffer, destination: NodeJS.WriteStream) {
      const content = chunk.toString('utf8');
      destination.write(content);
      output.push(content);
    }
    child.stdout!.on('data', (chunk: Buffer) => capture(chunk, process.stdout));
    child.stderr!.on('data', (chunk: Buffer) => capture(chunk, process.stderr));
    child.on('error', (error) => { console.error(`MILESTONE_SPAWN_ERROR ${label}: ${error.message}`); finish(1); });
    child.on('close', (code, signal) => {
      if (signal) console.error(`MILESTONE_SIGNAL ${label}: ${signal}`);
      finish(code ?? 1);
    });
  });

  // Node --test prints the final TAP counters after every nested subtest.
  // Counts remain null if no completed TAP summary was emitted.
  const transcript = output.join('');
  function counter(name: string): number | null {
    const matches = [...transcript.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gm'))];
    return matches.length ? Number(matches[matches.length - 1]![1]) : null;
  }
  const result: SuiteResult = {
    command: label, exitCode, status: exitCode === 0 ? 'PASS' : 'FAIL',
    pass: counter('pass'), fail: counter('fail'), skip: counter('skipped'),
  };
  console.log(`MILESTONE_RESULT ${JSON.stringify(result)}`);
  return result;
}

async function main(): Promise<void> {
  console.log(`MILESTONE_NODE ${process.version}`);
  const results: SuiteResult[] = [];
  for (const suite of suites) {
    if (results.some((result) => result.status === 'FAIL')) {
      results.push({ command: suite.label, exitCode: null,
        status: 'NOT RUN', pass: null, fail: null, skip: null });
      continue;
    }
    results.push(await execute(suite.label, suite.command));
  }
  const success = results.every((result) => result.status === 'PASS');
  console.log(`MILESTONE_SUMMARY ${JSON.stringify({ overall: success ? 'PASS' : 'FAIL',
    suites: results })}`);
  if (!success) process.exitCode = results.find((result) => result.status === 'FAIL')?.exitCode || 1;
}

await main();
