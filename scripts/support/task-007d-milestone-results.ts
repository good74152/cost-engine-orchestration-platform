export type CommandKind = 'build' | 'test';
export interface MilestoneSuite { label: string; command: string; kind: CommandKind }
export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  spawnError: string | null;
  stdout: string;
}
export interface Counts {
  tests: number | null;
  pass: number | null;
  fail: number | null;
  skip: number | null;
  cancelled: number | null;
  todo: number | null;
}
export interface SuiteResult extends Counts {
  command: string;
  kind: CommandKind;
  exitCode: number | null;
  signal: string | null;
  spawnError: string | null;
  status: 'PASS' | 'FAIL' | 'NOT RUN';
  issues: string[];
}

function emptyCounts(): Counts {
  return { tests: null, pass: null, fail: null, skip: null, cancelled: null, todo: null };
}

export function parseTapCounts(stdout: string): Counts {
  const counts = emptyCounts();
  const seen = new Set<keyof Counts>();
  // Only root summary comments, not indented subtest output. Parse the complete
  // stdout after close, so stream chunk boundaries cannot split a counter.
  for (const match of stdout.matchAll(/^#[ \t]+(tests|pass|fail|skipped|cancelled|todo)[ \t]+([^\r\n]*)\r?$/gm)) {
    const key = (match[1] === 'skipped' ? 'skip' : match[1]) as keyof Counts;
    const value = match[2]!.trim();
    const number = /^\d+$/.test(value) ? Number(value) : NaN;
    // Missing, malformed, unsafe, or duplicate counters remain unknown. Never
    // mix multiple summaries or manufacture a missing counter as zero.
    counts[key] = !seen.has(key) && Number.isSafeInteger(number) ? number : null;
    seen.add(key);
  }
  return counts;
}

export function classifyResult(suite: MilestoneSuite, process: ProcessResult): SuiteResult {
  const counts = suite.kind === 'test' ? parseTapCounts(process.stdout) : emptyCounts();
  const issues: string[] = [];
  if (process.exitCode !== 0) issues.push('Process did not exit with code 0');
  if (process.signal !== null) issues.push(`Process terminated by signal ${process.signal}`);
  if (process.spawnError !== null) issues.push(`Process spawn failed: ${process.spawnError}`);
  if (suite.kind === 'test') {
    const missing = Object.entries(counts).filter(([, value]) => value === null).map(([key]) => key);
    if (missing.length) issues.push(`Missing or invalid TAP counters: ${missing.join(', ')}`);
    if (missing.length === 0) {
      const { tests, pass, fail, skip, cancelled, todo } = counts as Record<keyof Counts, number>;
      // Node includes nested test entries in these totals. Its top-level TAP
      // plan may be smaller, so do not compare that plan to # tests.
      if (tests !== pass + fail + skip + cancelled + todo) issues.push('Inconsistent TAP totals');
      if (pass <= 0) issues.push('No passing tests executed');
      if (fail !== 0) issues.push('Failing tests');
      if (skip !== 0) issues.push('Skipped tests');
      if (cancelled !== 0) issues.push('Cancelled tests');
      if (todo !== 0) issues.push('Unexpected TODO tests');
    }
  }
  return { command: suite.label, kind: suite.kind, exitCode: process.exitCode,
    signal: process.signal, spawnError: process.spawnError, ...counts,
    status: issues.length ? 'FAIL' : 'PASS', issues };
}

export async function runSequentially(
  suites: readonly MilestoneSuite[],
  execute: (suite: MilestoneSuite) => Promise<ProcessResult>,
  report: (result: SuiteResult) => void = () => {},
) {
  const results: SuiteResult[] = [];
  let failed = false;
  for (const suite of suites) {
    let result: SuiteResult;
    if (failed) {
      result = { command: suite.label, kind: suite.kind, exitCode: null, signal: null,
        spawnError: null, ...emptyCounts(), status: 'NOT RUN', issues: ['Stopped after an earlier failure'] };
    } else {
      let process: ProcessResult;
      try { process = await execute(suite); }
      catch (error) {
        process = { exitCode: null, signal: null, stdout: '',
          spawnError: error instanceof Error ? error.message : String(error) };
      }
      result = classifyResult(suite, process);
      failed = result.status === 'FAIL';
    }
    results.push(result);
    report(result);
  }
  const success = results.length > 0 && results.every((result) => result.status === 'PASS');
  return { overall: success ? 'PASS' as const : 'FAIL' as const,
    exitCode: success ? 0 : (results.find((result) => result.status === 'FAIL')?.exitCode || 1),
    suites: results };
}
