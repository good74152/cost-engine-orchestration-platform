import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  classifyResult, parseTapCounts, runSequentially,
  type MilestoneSuite, type ProcessResult,
} from './support/task-007d-milestone-results.js';

const suite: MilestoneSuite = { label: 'arbitrary integration command', command: 'integration', kind: 'test' };
function output(overrides: Partial<Record<'tests' | 'pass' | 'fail' | 'skipped' | 'cancelled' | 'todo', number>> = {}) {
  const counters = { tests: 10, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...overrides };
  return 'TAP version 13\n' + Object.entries(counters).map(([key, value]) => `# ${key} ${value}\n`).join('');
}
function processResult(stdout = output(), exitCode: number | null = 0): ProcessResult {
  return { stdout, exitCode, signal: null, spawnError: null };
}

const cases = [
  { name: 'A: successful test suite', stdout: output(), exit: 0, status: 'PASS' },
  { name: 'B: failing test suite', stdout: output({ pass: 9, fail: 1 }), exit: 1, status: 'FAIL' },
  { name: 'C: all skipped', stdout: output({ pass: 0, skipped: 10 }), exit: 0, status: 'FAIL' },
  { name: 'D: partial skips', stdout: output({ pass: 9, skipped: 1 }), exit: 0, status: 'FAIL' },
  { name: 'E: missing TAP summary', stdout: 'ordinary output\n', exit: 0, status: 'FAIL' },
  { name: 'F: zero tests', stdout: output({ tests: 0, pass: 0 }), exit: 0, status: 'FAIL' },
  { name: 'G: incomplete counters', stdout: output().replace('# skipped 0\n', ''), exit: 0, status: 'FAIL' },
  { name: 'H: cancelled tests', stdout: output({ pass: 9, cancelled: 1 }), exit: 0, status: 'FAIL' },
  { name: 'I: unexpected TODO', stdout: output({ pass: 9, todo: 1 }), exit: 0, status: 'FAIL' },
  { name: 'N: inconsistent total', stdout: output({ tests: 11 }), exit: 0, status: 'FAIL' },
  { name: 'nonzero process exit despite passing counters', stdout: output(), exit: 2, status: 'FAIL' },
  { name: 'failing counters despite exit zero', stdout: output({ pass: 9, fail: 1 }), exit: 0, status: 'FAIL' },
] as const;
for (const scenario of cases) {
  test(scenario.name, () => {
    const result = classifyResult(suite, processResult(scenario.stdout, scenario.exit));
    assert.equal(result.status, scenario.status);
    assert.equal(result.exitCode, scenario.exit, 'Never fabricate a corrected child exit code');
    if (scenario.name.startsWith('E:')) {
      for (const key of ['tests', 'pass', 'fail', 'skip', 'cancelled', 'todo'] as const) assert.equal(result[key], null);
    }
    if (scenario.name.startsWith('G:')) assert.equal(result.skip, null);
  });
}

for (const exitCode of [0, 1]) {
  test(`${exitCode === 0 ? 'J' : 'K'}: build has explicit exit-code-only policy`, () => {
    const build = { ...suite, kind: 'build' as const };
    const result = classifyResult(build, processResult('', exitCode));
    assert.equal(result.status, exitCode === 0 ? 'PASS' : 'FAIL');
    assert.equal(result.tests, null);
    // A label mentioning build must not grant the exception to a test.
    assert.equal(classifyResult({ ...suite, label: 'build integration test' }, processResult('')).status, 'FAIL');
  });
}

test('L: failure stops execution, reports subsequent suites NOT RUN and returns nonzero', async () => {
  for (const failure of [processResult(output({ pass: 9, skipped: 1 })), processResult(output(), 7)]) {
    const plan = ['build', 'first', 'second', 'third'].map((command, index) => ({
      command, label: command, kind: index === 0 ? 'build' as const : 'test' as const,
    }));
    const executed: string[] = [];
    const reported: string[] = [];
    const result = await runSequentially(plan, async (entry) => {
      executed.push(entry.command);
      return entry.kind === 'build' ? processResult('') : failure;
    }, (entry) => reported.push(entry.status));
    assert.deepEqual(executed, ['build', 'first']);
    assert.deepEqual(reported, ['PASS', 'FAIL', 'NOT RUN', 'NOT RUN']);
    assert.equal(result.overall, 'FAIL');
    assert.equal(result.exitCode, failure.exitCode || 1);
    for (const entry of result.suites.slice(2)) {
      assert.equal(entry.exitCode, null);
      assert.equal(entry.pass, null);
    }
  }
});

test('M: chunk-split summary is parsed only after complete stdout is assembled', () => {
  const chunks = ['TAP version 13\n# tes', 'ts 10\r', '\n# pa', 'ss 10\r\n# fail 0\r\n# cancelled 0\r\n# skip', 'ped 0\r\n# to', 'do 0\r\n'];
  assert.equal(classifyResult(suite, processResult(chunks.join(''))).status, 'PASS');
  assert.equal(parseTapCounts(chunks[0]!).tests, null, 'Partial output alone is not a completed summary');
});

test('missing, malformed, duplicate and unsafe counters remain null and fail closed', () => {
  for (const stdout of [
    output().replace('# pass 10', '# pass -1'),
    output().replace('# pass 10', '# pass NaN'),
    output().replace('# pass 10', '# pass 1.5'),
    output().replace('# pass 10', '# pass 9007199254740992'),
    output() + '# pass 10\n',
  ]) {
    const result = classifyResult(suite, processResult(stdout));
    assert.equal(result.status, 'FAIL');
    assert.equal(result.pass, null);
    assert.ok(result.issues.some((issue) => issue.includes('pass')));
  }
});

test('spawn failures, thrown spawn errors and signals fail even with otherwise valid output', async () => {
  for (const state of [
    { ...processResult(), exitCode: null, spawnError: 'ENOENT' },
    { ...processResult(), signal: 'SIGTERM' },
    { ...processResult(), exitCode: null },
  ]) assert.equal(classifyResult(suite, state).status, 'FAIL');
  const result = await runSequentially([suite, suite], async () => { throw new Error('synchronous spawn failure'); });
  assert.equal(result.overall, 'FAIL');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.suites.map((entry) => entry.status), ['FAIL', 'NOT RUN']);
  assert.equal(result.suites[0]!.spawnError, 'synchronous spawn failure');
});

test('sequential progression awaits completion and overall PASS requires every command', async () => {
  let release!: () => void;
  let reached!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const executed: string[] = [];
  const result = runSequentially([suite, { ...suite, command: 'second' }], async (entry) => {
    executed.push(entry.command);
    if (entry.command === suite.command) { reached(); await barrier; }
    return processResult();
  });
  await entered;
  assert.deepEqual(executed, [suite.command]);
  release();
  const summary = await result;
  assert.deepEqual(executed, [suite.command, 'second']);
  assert.equal(summary.overall, 'PASS');
  assert.equal(summary.exitCode, 0);
  assert.equal((await runSequentially([], async () => processResult())).overall, 'FAIL');
});

test('actual Node TAP with nested tests, CRLF/whitespace, and arbitrary totals is accepted', () => {
  const childEnvironment = { ...process.env };
  // A subprocess inside node:test must not inherit its parent's internal
  // child-v8 reporter context; this fixture deliberately requests plain TAP.
  delete childEnvironment.NODE_TEST_CONTEXT;
  // This fixture selects its own reporter on the CLI. Do not select it twice
  // when the enclosing milestone already requested TAP through NODE_OPTIONS.
  delete childEnvironment.NODE_OPTIONS;
  const stdout = execFileSync(process.execPath, ['--test-reporter=tap', '--input-type=module', '-e',
    'import test from "node:test"; test("parent", async t => { await t.test("child", () => {}); });'],
  { encoding: 'utf8', env: childEnvironment });
  const counts = parseTapCounts(stdout);
  assert.equal(counts.tests, 2);
  assert.equal(counts.pass, 2);
  assert.match(stdout, /^1\.\.1$/m, 'Top-level plan is smaller than the nested test total');
  assert.equal(classifyResult(suite, processResult(stdout)).status, 'PASS');
  assert.equal(classifyResult(suite, processResult(stdout.replaceAll('\n', '\r\n'))).status, 'PASS');
  assert.equal(classifyResult(suite, processResult(stdout.replace(/^(# \w+ \d+)$/gm, '$1  '))).status, 'PASS');
});
