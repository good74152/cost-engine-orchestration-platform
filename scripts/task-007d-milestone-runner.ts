import 'dotenv/config';
import { spawn } from 'node:child_process';
import { runSequentially, type MilestoneSuite, type ProcessResult } from './support/task-007d-milestone-results.js';

const suites = [
  { label: 'npm run build', command: 'build', kind: 'build' },
  { label: 'npm run test:milestone-runner', command: 'test:milestone-runner', kind: 'test' },
  { label: 'npm run test:orchestration-schema-v2', command: 'test:orchestration-schema-v2', kind: 'test' },
  { label: 'npm run test:naming-01', command: 'test:naming-01', kind: 'test' },
  { label: 'npm run test:dataset-version-creation-v2', command: 'test:dataset-version-creation-v2', kind: 'test' },
  { label: 'npm run test:first-run-immutable-build-snapshot', command: 'test:first-run-immutable-build-snapshot', kind: 'test' },
  { label: 'npm run test:execution-attempt-dispatch-fake-executor', command: 'test:execution-attempt-dispatch-fake-executor', kind: 'test' },
  { label: 'npm run test:executor-reconciliation', command: 'test:executor-reconciliation', kind: 'test' },
  { label: 'npm run test:dataset-version-terminal-lifecycle', command: 'test:dataset-version-terminal-lifecycle', kind: 'test' },
  { label: 'npm run test:cross-workflow-concurrency-investigation', command: 'test:cross-workflow-concurrency-investigation', kind: 'test' },
  { label: 'npm run test:task-007b1-late-dispatch-reconciliation', command: 'test:task-007b1-late-dispatch-reconciliation', kind: 'test' },
  { label: 'npm run test:task-007c-api-contract', command: 'test:task-007c-api-contract', kind: 'test' },
  { label: 'npm run test:raw-ingestion (owned disposable PostgreSQL database)', command: 'raw-isolated', kind: 'test' },
  { label: 'npm run test:task-007d-end-to-end', command: 'test:task-007d-end-to-end', kind: 'test' },
] as const satisfies readonly MilestoneSuite[];

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const nodeEnvironment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };

async function execute({ label, command, kind }: MilestoneSuite): Promise<ProcessResult> {
  // npm supplies its CLI path. Invoke it via Node rather than executing .cmd
  // directly on Windows (EINVAL), without a shell or shell-argument warnings.
  const npmCli = process.env.npm_execpath;
  const executable = command === 'raw-isolated' || npmCli ? process.execPath : npm;
  const args = command === 'raw-isolated'
    ? ['--import', 'tsx', 'scripts/support/task-007d-isolated-raw-ingestion.ts']
    : npmCli ? [npmCli, 'run', command] : ['run', command];
  console.log(`\nMILESTONE_START ${label}`);
  const output: string[] = [];
  return new Promise<ProcessResult>((resolve) => {
    // Reporter defaults vary by Node/runtime output detection. Explicit TAP is
    // inherited by npm/tsx and by the isolated raw launcher's child process.
    const env = kind === 'test' ? { ...nodeEnvironment,
      NODE_OPTIONS: `${nodeEnvironment.NODE_OPTIONS ?? ''} --test-reporter=tap`.trim() } : nodeEnvironment;
    const child = spawn(executable, args, { env, stdio: ['inherit', 'pipe', 'pipe'] });
    let spawnError: string | null = null;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (content: string) => { process.stdout.write(content); output.push(content); });
    child.stderr!.on('data', (content: string) => process.stderr.write(content));
    child.on('error', (error) => {
      spawnError = error.message;
      console.error(`MILESTONE_SPAWN_ERROR ${label}: ${error.message}`);
    });
    child.on('close', (code, signal) => {
      if (signal) console.error(`MILESTONE_SIGNAL ${label}: ${signal}`);
      resolve({ exitCode: code, signal, spawnError, stdout: output.join('') });
    });
  });
}

async function main(): Promise<void> {
  console.log(`MILESTONE_NODE ${process.version}`);
  const summary = await runSequentially(suites, execute,
    (result) => console.log(`MILESTONE_RESULT ${JSON.stringify(result)}`));
  console.log(`MILESTONE_SUMMARY ${JSON.stringify(summary)}`);
  process.exitCode = summary.exitCode;
}

await main();
