#!/usr/bin/env node
// Documentation-only SVG/Sharp pipeline, matching the Task 002/003 generators.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseArgs } = require('node:util');
const { values } = parseArgs({ options: {
  'sharp-module': { type: 'string' }, 'frames-dir': { type: 'string' },
} });
let sharp;
try { sharp = require(values['sharp-module'] || 'sharp'); }
catch {
  console.error('Use the isolated Sharp install in docs/diagrams/flows/README.md and pass --sharp-module.');
  process.exit(1);
}

const WIDTH = 1280;
const HEIGHT = 1000;
const BASENAME = 'task-004-execution-dispatch';
const RUN_ID = 'cost-engine-<uuid>';
const C = {
  ink: '#172b4d', muted: '#42526b', line: '#bacbe0', blue: '#f0f5fc',
  teal: '#176270', tealFill: '#e2f2f3', tealLine: '#65a5af',
  amber: '#87500f', amberFill: '#fff8ed', amberLine: '#dec39a',
  red: '#9f3d36', redFill: '#fff1f0', redLine: '#dbaca7',
};
const STEPS = [
  { title: 'Job Ready', lines: ['Job: PENDING', 'Attempt: PREPARED'], delay: 2400,
    caption: 'The backend has saved the attempt and its execution ID.' },
  { title: 'Save Before Dispatch', lines: ['PREPARED → DISPATCHING', 'COMMIT before the executor call.'], delay: 4300,
    caption: 'Save the execution attempt before calling the executor.' },
  { title: 'Send to Executor', lines: ['Call FakeExecutor after COMMIT.', 'No open database transaction.'], delay: 3600,
    caption: 'No database transaction stays open during the executor call.' },
  { title: 'Executor Response', lines: ['Accepted, rejected or unknown.', 'Save the result in a new transaction.'], delay: 6200,
    caption: 'UNKNOWN means the result is not known. It does not mean failure.' },
  { title: 'Response Lost', lines: ['Run created → response lost.', 'Backend sees UNKNOWN.'], delay: 5000,
    caption: 'Run created → Response lost → Backend sees UNKNOWN' },
  { title: 'Safe Recovery', lines: ['Send the same attempt and run ID.', 'ALREADY_EXISTS confirms the run.'], delay: 5500,
    caption: 'This run already exists in the fake; other UNKNOWN results may stay open.' },
];
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);

function scene(step, overview = false) {
  const parts = [];
  const add = value => parts.push(value);
  const rect = (x, y, w, h, fill = '#fff', stroke = C.line) =>
    add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}"/>`);
  const text = (x, y, value, size = 20, weight = 400, fill = C.ink) =>
    add(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}">${escape(value)}</text>`);
  const arrow = (d, amber = false, lost = false) =>
    add(`<path class="flow-arrow" d="${d}" fill="none" stroke="${amber ? C.amber : C.teal}" stroke-width="3" ${lost ? 'stroke-dasharray="7 6"' : `marker-end="url(#${amber ? 'amber-arrow' : 'arrow'})"`}/>`);
  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="flow-title flow-desc">`);
  add(`<title id="flow-title">Task 004 — Execution Dispatch and Safe Retry${overview ? ' — Complete Flow' : ` — Step ${step}`}</title>`);
  add('<desc id="flow-desc">A response-loss example within one development/test FakeExecutor instance. Task 003 has saved a PENDING job, PREPARED attempt and backend-generated execution identity. Task 004 saves DISPATCHING and commits before dispatch. The executor call holds no orchestration database transaction or locks. A new transaction records the result: ACCEPTED or ALREADY_EXISTS confirms attempt ACCEPTED and job RUNNING; REJECTED means no run with this identity ever existed or can later be created, and records DISPATCH_FAILED; UNKNOWN leaves the attempt DISPATCHING and keeps the job unchanged. These are alternative results. In the shown response-loss path the fake creates a run, but the backend receives UNKNOWN. Redispatch reuses the same attempt and airflowDagRunId, with the same airflowDagId. The fake finds that identity and returns ALREADY_EXISTS without creating another run. The backend atomically saves ACCEPTED and RUNNING. Same execution ID, no duplicate execution in this example. Other UNKNOWN results can remain unresolved. Idempotency requires the executor to check the full stable identity. A permitted retry after a definite dispatch or execution failure can create a new attempt using the same frozen snapshot. Task 005 owns terminal success/failure reconciliation. Run ID text is a shortened template; FakeExecutor state is instance-local and in memory, not restart or cross-process durability. No real Airflow adapter is shown.</desc>');
  add(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" fill="${C.teal}"/></marker><marker id="amber-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" fill="${C.amber}"/></marker></defs>`);
  add('<style>text { font-family: Arial, Helvetica, sans-serif; }</style>');
  rect(0, 0, WIDTH, HEIGHT, '#fff', 'none');
  text(32, 49, 'Execution Dispatch & Safe Retry', 32, 700);
  text(32, 84, 'Task 004 · What if the executor gets the request, but its response is lost?', 22, 400, C.muted);
  text(32, 139, overview ? 'COMPLETE DISPATCH FLOW' : `DISPATCH FLOW · STEP ${step} / 6`, 17, 700, C.teal);
  add(`<path d="M 58 191 V 681" stroke="${C.line}" stroke-width="2"/>`);
  STEPS.forEach((s, i) => {
    const y = 164 + i * 98;
    if (overview || i + 1 === step) rect(32, y, 360, 92, C.blue);
    add(`<circle cx="58" cy="${y + 27}" r="15" fill="${i < step ? C.teal : '#fff'}" stroke="${C.teal}"/>`);
    text(53, y + 33, i + 1, 17, 700, i < step ? '#fff' : C.teal);
    text(84, y + 31, s.title, 21, 700);
    s.lines.forEach((line, j) => text(84, y + 57 + j * 22, line, 17, 400, C.muted));
  });

  text(430, 139, 'One attempt. One execution identity.', 25, 700);
  text(430, 168, 'Response-loss example · One FakeExecutor instance', 19, 400, C.muted);
  rect(430, 195, 335, 245, step === 5 ? C.amberFill : C.blue, step === 5 ? C.amberLine : C.line);
  text(450, 232, 'Backend + PostgreSQL', 24, 700);
  text(450, 273, `Job: ${step === 6 ? 'RUNNING' : 'PENDING'}`, 23, 700, step === 6 ? C.teal : C.ink);
  text(450, 311, `Attempt: ${step === 1 ? 'PREPARED' : (step === 6 ? 'ACCEPTED' : 'DISPATCHING')}`, 22, 700, step === 5 ? C.amber : C.teal);
  text(450, 353, 'airflowDagRunId', 18, 400, C.muted);
  text(450, 385, RUN_ID, 22, 700, C.teal);
  text(450, 419, 'Backend creates and saves this ID', 17, 400, C.muted);
  rect(950, 195, 298, 245, step >= 5 ? C.tealFill : '#fff', step >= 5 ? C.tealLine : C.line);
  text(970, 232, 'FakeExecutor', 26, 700);
  text(970, 273, step >= 5 ? '1 run exists' : (step === 4 ? 'Result may vary' : (step === 3 ? 'Dispatch received' : 'No run yet')), 23, 700, C.teal);
  text(970, 353, step >= 3 ? 'airflowDagRunId' : 'Awaiting dispatch', 18, 400, C.muted);
  if (step >= 3) text(970, 385, RUN_ID, 22, 700, C.teal);
  text(970, 419, 'Development / test only', 18, 400, C.muted);
  if (step >= 3) {
    arrow('M 765 273 H 950');
    text(787, 254, step === 6 ? 'same ID' : 'dispatch', 19, 700, C.teal);
  }
  if (step === 5) {
    arrow('M 950 372 H 835', true, true);
    add(`<path d="M 828 365 L 842 379 M 842 365 L 828 379" stroke="${C.amber}" stroke-width="3"/>`);
    text(785, 338, 'response lost', 18, 700, C.amber);
    text(788, 404, 'UNKNOWN', 20, 700, C.amber);
  } else if (step === 6) {
    arrow('M 950 372 H 765');
    text(772, 352, 'ALREADY_EXISTS', 18, 700, C.teal);
  }

  rect(430, 466, 818, 93, step === 5 ? C.amberFill : C.tealFill, step === 5 ? C.amberLine : C.tealLine);
  const details = [
    ['Saved by Task 003', 'The attempt and its run ID are already stored.'],
    ['PostgreSQL transaction → COMMIT', 'PREPARED → DISPATCHING · Save before dispatch.'],
    ['Executor call · Outside the transaction', 'No database transaction or row lock stays open.'],
    ['New PostgreSQL transaction · Save the result', 'Confirm both states together when the run exists.'],
    ['UNKNOWN · Not a failure', 'Keep the same attempt and run ID. Do not create a new attempt.'],
    ['Reuse DISPATCHING → COMMIT → send the same ID', 'ALREADY_EXISTS → Save ACCEPTED + RUNNING in a new transaction.'],
  ][step - 1];
  text(450, 501, details[0], 23, 700, step === 5 ? C.amber : C.teal);
  text(450, 538, details[1], 20, 400, C.muted);

  if (step >= 4) {
    text(430, 598, 'Three possible results', 23, 700);
    const rows = [
      ['ACCEPTED / ALREADY_EXISTS', 'Attempt ACCEPTED · Job RUNNING', C.tealFill, C.tealLine, C.teal],
      ['REJECTED', 'Attempt DISPATCH_FAILED', C.redFill, C.redLine, C.red],
      ['UNKNOWN', 'Attempt stays DISPATCHING', C.amberFill, C.amberLine, C.amber],
    ];
    rows.forEach(([result, effect, fill, stroke, color], i) => {
      const y = 615 + i * 51;
      rect(430, y, 818, 43, fill, stroke);
      text(450, y + 28, result, 21, 700, color);
      text(837, y + 28, effect, 20, 700, C.ink);
    });
    text(430, 797, 'REJECTED: no run exists or can ever be created for that identity.', 19, 400, C.red);
    text(430, 829, 'UNKNOWN may stay open. Recovery needs executor ID checks.', 19, 400, C.muted);
  } else {
    text(450, 633, 'Save first. Send second.', 28, 700, C.teal);
    text(450, 679, 'The attempt is a saved record of one execution try.', 22, 400, C.muted);
    text(450, 721, 'Use its stored ID when calling the executor.', 22, 400, C.muted);
    text(450, 779, 'A new database transaction saves the response.', 21, 400, C.muted);
  }
  rect(32, 780, 360, 81, C.blue);
  text(52, 812, 'UNKNOWN: keep the ID', 22, 700, C.teal);
  text(52, 842, 'New attempt only in allowed states.', 18, 400, C.muted);
  rect(32, 883, 1216, 87, C.tealFill, C.tealLine);
  const banner = step === 6 ? 'Same execution ID. No duplicate execution.' :
    (step === 5 ? STEPS[4].caption : `Step ${step} / 6 — ${STEPS[step - 1].title}`);
  text(56, 919, banner, 27, 700, C.teal);
  text(56, 952, step === 5 ? 'Keep DISPATCHING. Recover with the same attempt and the same run ID.' : STEPS[step - 1].caption, 22);
  text(32, 992, 'Task 005 checks success or failure. A permitted new attempt still uses the same frozen snapshot.', 18, 400, C.muted);
  add('</svg>');
  return parts.join('\n') + '\n';
}

async function main() {
  const frames = [];
  if (values['frames-dir']) await fs.mkdir(values['frames-dir'], { recursive: true });
  for (let step = 1; step <= 6; step++) {
    const svg = scene(step);
    const frame = sharp(Buffer.from(svg)).flatten({ background: '#fff' }).removeAlpha();
    const { data, info } = await frame.clone().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, WIDTH); assert.equal(info.height, HEIGHT); assert.equal(info.channels, 3);
    frames.push(data);
    if (values['frames-dir']) {
      await fs.writeFile(path.join(values['frames-dir'], `step-${step}.svg`), svg);
      await frame.png().toFile(path.join(values['frames-dir'], `step-${step}.png`));
    }
  }
  const gif = await sharp(Buffer.concat(frames), {
    raw: { width: WIDTH, height: HEIGHT * 6, channels: 3, pageHeight: HEIGHT },
  }).gif({ loop: 0, delay: STEPS.map(s => s.delay), colours: 128, dither: 0, effort: 10 }).toBuffer();
  const meta = await sharp(gif, { animated: true }).metadata();
  assert.equal(meta.pages, 6); assert.equal(meta.pageHeight, HEIGHT); assert.equal(meta.loop, 0);
  assert.deepEqual(meta.delay, STEPS.map(s => s.delay));
  assert.ok(gif.length < 1024 * 1024, 'Keep the README GIF below 1 MiB');
  await fs.writeFile(path.join(__dirname, `${BASENAME}.svg`), scene(6, true));
  await fs.writeFile(path.join(__dirname, `${BASENAME}.gif`), gif);
  console.log(`${BASENAME}: ${WIDTH} × ${HEIGHT}, six steps, ${meta.delay.reduce((a, b) => a + b) / 1000}s loop, ${gif.length} bytes`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
