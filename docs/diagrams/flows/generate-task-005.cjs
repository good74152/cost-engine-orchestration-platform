#!/usr/bin/env node
// Documentation-only SVG/Sharp pipeline, matching the existing flow generators.
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
const HEIGHT = 1080;
const BASENAME = 'task-005-executor-reconciliation';
const C = {
  ink: '#172b4d', muted: '#42526b', line: '#bacbe0', blue: '#f0f5fc',
  teal: '#176270', tealFill: '#e2f2f3', tealLine: '#65a5af',
  amber: '#87500f', amberFill: '#fff8ed', amberLine: '#dec39a',
};
const STEPS = [
  { title: 'Job Running', lines: ['Job RUNNING · Attempt ACCEPTED', 'Executor: RUNNING'], delay: 2400,
    caption: 'Dispatch is confirmed. PostgreSQL and the executor both show running work.' },
  { title: 'Executor Finished', lines: ['Executor: SUCCEEDED', 'PostgreSQL still shows RUNNING.'], delay: 3600,
    caption: 'The executor finished, but the backend has not updated its state.' },
  { title: 'Check Execution Status', lines: ['Manual request or callback.', 'Both use the same check service.'], delay: 3800,
    caption: 'A callback asks the backend to check. It is not proof of success or failure.' },
  { title: 'Ask the Executor', lines: ['Use the saved DAG ID + run ID.', 'Lookup holds no DB transaction.'], delay: 4800,
    caption: 'No database transaction stays open while waiting for the executor.' },
  { title: 'Update PostgreSQL', lines: ['Lock job → attempt → recheck.', 'Update both states → COMMIT.'], delay: 5200,
    caption: 'Job and attempt states are updated together.' },
  { title: 'Duplicate Callback', lines: ['Check the same execution again.', 'Keep the same confirmed result.'], delay: 8000,
    caption: 'Check again. No new attempt, no new run, no terminal rewrite.' },
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
  const arrow = d => add(`<path class="flow-arrow" d="${d}" fill="none" stroke="${C.teal}" stroke-width="3" stroke-linejoin="round" marker-end="url(#arrow)"/>`);
  const updated = step >= 5;
  const lagging = step >= 2 && !updated;
  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="flow-title flow-desc">`);
  add(`<title id="flow-title">Task 005 — Executor Reconciliation and Recovery${overview ? ' — Complete Flow' : ` — Step ${step}`}</title>`);
  add('<desc id="flow-desc">The saved job is RUNNING and its attempt ACCEPTED. FakeExecutor changes the execution to SUCCEEDED, while PostgreSQL remains unchanged. A manual POST /calculation-jobs/:jobId/reconcile or an executor callback enters the same reconciliation service. The callback only supplies execution identity; it does not prove success or failure. The service uses saved airflowDagId plus airflowDagRunId to ask the executor outside a database transaction and row locks. After a SUCCEEDED reply it starts a transaction, locks Calculation Job then Execution Attempt, rechecks identity and state, updates both to SUCCEEDED, and commits. A matching duplicate callback checks again and keeps the confirmed result, with no new attempt or execution. RUNNING confirms ACCEPTED/RUNNING for a current non-terminal attempt; confirmed SUCCEEDED or FAILED updates both states. NOT_FOUND and UNAVAILABLE leave local state unchanged. A DISPATCHING attempt can recover to ACCEPTED/RUNNING or directly to a confirmed terminal result using the same attempt. Older callbacks cannot overwrite a newer retry; contradictory terminal facts raise an invariant error. Dataset remains BUILDING in this scenario. Only manual and callback-triggered checks exist; no periodic reconciliation worker or real Airflow adapter is shown. FakeExecutor is development/test only and its in-memory state does not survive a restart.</desc>');
  add(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" fill="${C.teal}"/></marker></defs>`);
  add('<style>text { font-family: Arial, Helvetica, sans-serif; }</style>');
  rect(0, 0, WIDTH, HEIGHT, '#fff', 'none');
  text(32, 49, 'Executor Reconciliation & Recovery', 32, 700);
  text(32, 84, 'Task 005 · Check the executor. Save the confirmed result.', 22, 400, C.muted);
  text(32, 139, overview ? 'COMPLETE RECONCILIATION FLOW' : `RECONCILIATION · STEP ${step} / 6`, 17, 700, C.teal);
  add(`<path d="M 58 191 V 681" stroke="${C.line}" stroke-width="2"/>`);
  STEPS.forEach((s, i) => {
    const y = 164 + i * 98;
    if (overview || i + 1 === step) rect(32, y, 360, 92, C.blue);
    add(`<circle cx="58" cy="${y + 27}" r="15" fill="${i < step ? C.teal : '#fff'}" stroke="${C.teal}"/>`);
    text(53, y + 33, i + 1, 17, 700, i < step ? '#fff' : C.teal);
    text(84, y + 31, s.title, 21, 700);
    s.lines.forEach((line, j) => text(84, y + 57 + j * 22, line, 17, 400, C.muted));
  });

  text(430, 139, 'Executor result → Confirmed stored state', 25, 700);
  text(430, 168, 'The executor is the source of the execution result.', 19, 400, C.muted);
  rect(430, 195, 335, 205, lagging ? C.amberFill : (updated ? C.tealFill : C.blue), lagging ? C.amberLine : (updated ? C.tealLine : C.line));
  text(450, 232, 'Backend + PostgreSQL', 24, 700);
  text(450, 273, `Job: ${updated ? 'SUCCEEDED' : 'RUNNING'}`, 23, 700, lagging ? C.amber : C.teal);
  text(450, 311, `Attempt: ${updated ? 'SUCCEEDED' : 'ACCEPTED'}`, 22, 700, lagging ? C.amber : C.teal);
  text(450, 350, 'Dataset: BUILDING', 21, 400, C.muted);
  text(450, 381, updated ? 'Confirmed result saved' : (lagging ? 'Not updated yet' : 'Dispatch already confirmed'), 18, 400, C.muted);
  rect(950, 195, 298, 205, step >= 2 ? C.tealFill : '#fff', step >= 2 ? C.tealLine : C.line);
  text(970, 232, 'FakeExecutor', 26, 700);
  text(970, 272, 'Execution:', 21, 400, C.muted);
  text(970, 311, step >= 2 ? 'SUCCEEDED' : 'RUNNING', 27, 700, C.teal);
  text(970, 381, 'Development / test only', 18, 400, C.muted);
  if (step >= 4) {
    arrow('M 765 265 H 950');
    text(step === 6 ? 785 : 818, 247, step === 6 ? 'check again' : 'status?', 18, 700, C.teal);
    arrow('M 950 344 H 765');
    text(794, 327, 'SUCCEEDED', 18, 700, C.teal);
  }
  if (step >= 3) {
    rect(430, 435, 320, 52, C.blue);
    text(450, 469, 'Manual /reconcile', 23, 700);
    rect(928, 435, 320, 52, C.blue);
    text(948, 469, 'Executor callback', 23, 700);
    arrow('M 590 487 V 505 H 680 V 520');
    arrow('M 1088 487 V 505 H 1005 V 520');
    rect(430, 520, 818, 75, C.tealFill, C.tealLine);
    text(450, 551, 'Same Reconciliation Service', 24, 700, C.teal);
    text(450, 580, 'Callback asks for a check; it does not prove the result.', 19, 400, C.muted);
    text(430, 625, 'After lookup: lock Job → lock Attempt → recheck → save or keep → COMMIT', 19, 700, C.teal);
  } else {
    text(450, 480, 'The executor owns the execution result.', 27, 700, C.teal);
    text(450, 526, 'PostgreSQL changes only after a confirmed check.', 22, 400, C.muted);
  }

  rect(430, 645, 818, 282, C.blue);
  if (step === 6) {
    text(450, 680, 'Other results and matching repeats', 23, 700);
    const rows = [
      ['RUNNING', 'Job RUNNING · Attempt ACCEPTED'],
      ['SUCCEEDED', 'Job + attempt SUCCEEDED'],
      ['FAILED', 'Job + attempt FAILED'],
      ['NOT_FOUND', 'Keep local state unchanged'],
      ['UNAVAILABLE', 'Keep local state unchanged'],
      ['Duplicate (same result)', 'Keep the confirmed result'],
    ];
    rows.forEach(([result, action], i) => {
      const y = 717 + i * 35;
      text(450, y, result, 20, 700, i >= 3 && i < 5 ? C.amber : C.teal);
      text(760, y, action, 20, 400, C.muted);
    });
    text(450, 919, 'Current attempt: check state before applying a result.', 17, 400, C.muted);
  } else {
    const details = [
      ['After dispatch', ['The executor is running.', 'PostgreSQL stores Job RUNNING + Attempt ACCEPTED.', 'The dataset stays BUILDING.']],
      ['Executor finished. Stored state is still old.', ['Only the fake execution state changed.', 'PostgreSQL will not change by itself.', 'A check is still needed.']],
      ['Manual request or callback → same service', ['POST /calculation-jobs/:jobId/reconcile', 'Callback carries execution IDs only.', 'It cannot set job success or failure.']],
      ['Read the saved ID → ask FakeExecutor', ['airflowDagId + airflowDagRunId', 'Result: SUCCEEDED', 'No open database transaction or row locks.', 'Wait for the reply before starting the update.']],
      ['New PostgreSQL transaction', ['1  Lock Calculation Job', '2  Lock Execution Attempt', '3  Recheck saved state and attempt identity', '4  Update job + attempt → SUCCEEDED → COMMIT']],
    ][step - 1];
    text(450, 684, details[0], 24, 700, C.teal);
    details[1].forEach((line, i) => text(450, 733 + i * 45, line, 22, step === 5 ? 700 : 400, C.muted));
  }
  rect(32, 780, 360, 147, C.blue);
  text(52, 813, 'Recovery keeps the attempt', 22, 700, C.teal);
  text(52, 848, 'DISPATCHING + found run:', 18, 700);
  text(52, 881, 'Confirm ACCEPTED or final result.', 18, 400, C.muted);
  text(52, 914, 'Same attempt; no new execution.', 18, 400, C.muted);
  rect(32, 948, 1216, 96, C.tealFill, C.tealLine);
  text(56, 986, step === 6 ? 'Duplicate notifications do not change completed results.' : `Step ${step} / 6 — ${STEPS[step - 1].title}`, 27, 700, C.teal);
  text(56, 1023, STEPS[step - 1].caption, 22);
  text(32, 1070, 'No periodic worker. Fake state is in memory. Job success does not publish the dataset.', 18, 400, C.muted);
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
