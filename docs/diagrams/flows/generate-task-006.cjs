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
const BASENAME = 'task-006-dataset-lifecycle';
const C = {
  ink: '#172b4d', muted: '#42526b', line: '#bacbe0', blue: '#f0f5fc',
  teal: '#176270', tealFill: '#e2f2f3', tealLine: '#65a5af',
  amber: '#87500f', amberFill: '#fff8ed', amberLine: '#dec39a', gray: '#64748b',
};
const STEPS = [
  { title: 'Dataset Created', lines: ['Dataset: DRAFT', 'The dataset and its jobs exist.'], delay: 2400,
    caption: 'Creation starts a new Dataset Version in DRAFT.' },
  { title: 'First Run', lines: ['Freeze the build snapshot.', 'DRAFT → BUILDING'], delay: 3300,
    caption: 'First Run freezes inputs once and moves the dataset to BUILDING.' },
  { title: 'Jobs Completed', lines: ['All required jobs: SUCCEEDED', 'Dataset stays BUILDING.'], delay: 4000,
    caption: 'Jobs are complete. The dataset is not published yet.' },
  { title: 'Submit Validation', lines: ['Check all required jobs.', 'Explicit submit → VALIDATING'], delay: 5000,
    caption: 'All jobs must succeed before an explicit Submit Validation can pass.' },
  { title: 'Concurrent Decisions', lines: ['A: Publish · B: Reject', 'One locks the series; one waits.'], delay: 6000,
    caption: 'Both requests lock dataset_series first, then dataset_version.' },
  { title: 'Terminal State Protected', lines: ['Publish commits in this example.', 'Reject rechecks → 409 conflict.'], delay: 6500,
    caption: 'Publish commits. Reject rechecks and returns 409 STATE_CONFLICT.' },
];
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);

function scene(step, overview = false) {
  const p = [];
  const add = value => p.push(value);
  const rect = (x, y, w, h, fill = '#fff', stroke = C.line, extra = '') =>
    add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" ${extra}/>`);
  const text = (x, y, value, size = 20, weight = 400, fill = C.ink) =>
    add(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}">${escape(value)}</text>`);
  const arrow = (d, tone = 'teal', waiting = false, extra = '') =>
    add(`<path class="flow-arrow" d="${d}" fill="none" stroke="${C[tone]}" stroke-width="2.5" stroke-linejoin="round" ${waiting ? 'stroke-dasharray="7 6"' : `marker-end="url(#${tone}-arrow)"`} ${extra}/>`);
  const current = step === 1 ? 'DRAFT' : (step <= 3 ? 'BUILDING' : (step <= 5 ? 'VALIDATING' : 'PUBLISHED'));
  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="flow-title flow-desc">`);
  add(`<title id="flow-title">Task 006 — Dataset Lifecycle and Concurrent Decisions${overview ? ' — Complete State Machine' : ` — Step ${step}`}</title>`);
  add('<desc id="flow-desc">Complete dataset state machine: DRAFT to BUILDING at First Run, BUILDING to VALIDATING only after all required jobs succeed and validation is explicitly submitted, VALIDATING to PUBLISHED or REJECTED, and DRAFT or BUILDING to ABANDONED when no active attempt exists. PUBLISHED, REJECTED and ABANDONED are terminal. No dataset-level FAILED exists. The six-step example shows creation, snapshot freeze, jobs completed while dataset remains BUILDING, explicit validation, concurrent Publish and Reject, and protected PUBLISHED state. Publish wins only in this illustration; either request may win. Each decision transaction locks dataset_series then dataset_version. Publish commits and releases its lock; Reject then acquires the locks, sees PUBLISHED and returns 409 STATE_CONFLICT without rewriting history. Same-target repeats keep saved state. Submit Validation locks dataset_version, ordered calculation_jobs, then ordered execution_attempts; any normal incomplete job returns 409 DATASET_NOT_READY_FOR_VALIDATION. Abandon locks series, version, jobs and attempts, in that order. PREPARED, DISPATCHING or ACCEPTED attempts block it with 409 DATASET_HAS_ACTIVE_EXECUTION. Abandon preserves jobs, attempt history and the frozen snapshot and does not cancel execution. It is not Demo Session Reset. This diagram documents existing PostgreSQL lifecycle tests; it does not claim a fresh database test run.</desc>');
  add('<defs>');
  for (const tone of ['teal', 'amber', 'gray']) add(`<marker id="${tone}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" fill="${C[tone]}"/></marker>`);
  add('</defs><style>text { font-family: Arial, Helvetica, sans-serif; }</style>');
  rect(0, 0, WIDTH, HEIGHT, '#fff', 'none');
  text(32, 49, 'Dataset Lifecycle & Concurrent Decisions', 32, 700);
  text(32, 84, 'Task 006 · Explicit validation. One final decision. Protected history.', 22, 400, C.muted);
  text(32, 139, overview ? 'COMPLETE LIFECYCLE' : `LIFECYCLE · STEP ${step} / 6`, 17, 700, C.teal);
  add(`<path d="M 58 191 V 681" stroke="${C.line}" stroke-width="2"/>`);
  STEPS.forEach((s, i) => {
    const y = 164 + i * 98;
    if (overview || i + 1 === step) rect(32, y, 360, 92, C.blue);
    add(`<circle cx="58" cy="${y + 27}" r="15" fill="${i < step ? C.teal : '#fff'}" stroke="${C.teal}"/>`);
    text(53, y + 33, i + 1, 17, 700, i < step ? '#fff' : C.teal);
    text(84, y + 31, s.title, 21, 700);
    s.lines.forEach((line, j) => text(84, y + 57 + j * 22, line, 17, 400, C.muted));
  });

  text(430, 139, 'Dataset state machine', 25, 700);
  text(430, 168, 'Explicit validation. No automatic publication.', 19, 400, C.muted);
  const edge = (from, to, d, active = false) => arrow(d, active ? 'teal' : 'gray', false, `data-from="${from}" data-to="${to}"`);
  edge('DRAFT', 'BUILDING', 'M 562 287 V 355', step >= 2 || overview);
  edge('BUILDING', 'VALIDATING', 'M 562 447 V 515', step >= 4 || overview);
  edge('DRAFT', 'ABANDONED', 'M 695 241 H 822 V 303 H 970');
  edge('BUILDING', 'ABANDONED', 'M 695 401 H 862 V 339 H 970');
  edge('VALIDATING', 'PUBLISHED', 'M 695 552 H 970', step === 6 || overview);
  edge('VALIDATING', 'REJECTED', 'M 562 607 V 671 H 970');
  text(582, 325, 'First Run', 19, 700, C.teal);
  text(582, 485, 'Submit validation', 19, 700, C.teal);
  text(720, 228, 'Abandon', 19, 700, C.gray);
  text(720, 388, 'Abandon', 19, 700, C.gray);
  text(790, 535, 'Publish', 19, 700, C.teal);
  text(760, 652, 'Reject', 19, 700, C.gray);
  text(970, 254, 'Final (terminal) states', 18, 700, C.teal);

  const node = (name, x, y, w, lines) => {
    const selected = name === current;
    const terminal = ['PUBLISHED', 'REJECTED', 'ABANDONED'].includes(name);
    rect(x, y, w, 92, selected ? C.tealFill : (terminal ? C.blue : '#fff'), selected ? C.tealLine : C.line, `data-state="${name}"`);
    text(x + 20, y + 35, name, 25, 700, selected ? C.teal : C.ink);
    lines.forEach((line, i) => text(x + 20, y + 65 + i * 20, line, 17, 400, C.muted));
  };
  node('DRAFT', 430, 195, 265, ['Dataset created']);
  node('BUILDING', 430, 355, 265, ['Snapshot frozen', 'Jobs prepare / run / finish']);
  node('VALIDATING', 430, 515, 265, ['All jobs succeeded;', 'validation submitted']);
  node('ABANDONED', 970, 275, 278, ['Safely stopped · Terminal']);
  node('PUBLISHED', 970, 485, 278, ['Dataset released · Terminal']);
  node('REJECTED', 970, 625, 278, ['Validation rejected · Terminal']);

  if (step >= 5) text(430, 737, 'Publish wins in this example; either request may win.', 20, 400, C.muted);
  rect(430, 752, 818, 175, C.blue);
  if (step >= 5) {
    const done = step === 6;
    rect(450, 779, 310, 44, C.tealFill, C.tealLine);
    text(470, 808, done ? 'A: Publish · 200' : 'A: Publish · LOCKED', 22, 700, C.teal);
    rect(918, 779, 310, 44, C.amberFill, C.amberLine);
    text(938, 808, done ? 'B: Reject · 409' : 'B: Reject · WAITING', 22, 700, C.amber);
    arrow('M 605 823 V 844 H 760 V 862');
    if (done) arrow('M 1073 823 V 862', 'amber');
    else {
      arrow('M 1073 823 V 849', 'amber', true);
      add(`<path d="M 1059 850 H 1087" stroke="${C.amber}" stroke-width="3"/>`);
    }
    text(450, 874, done ? 'Commit → release' : 'Same series', 18, 700, C.teal);
    text(450, 905, done ? 'Reject rechecks' : 'PostgreSQL row lock', 18, 400, C.muted);
    rect(690, 862, 538, 46, '#fff');
    text(710, 891, done ? 'PUBLISHED · 409 STATE_CONFLICT' : 'dataset_series → dataset_version', 21, 700, done ? C.amber : C.teal);
  } else {
    const details = [
      ['Dataset: DRAFT', ['Task 002 created the dataset and its required jobs.', 'No build snapshot exists at creation.']],
      ['First Run freezes the snapshot', ['Task 003 saves one frozen build snapshot.', 'The dataset changes from DRAFT to BUILDING.']],
      ['All jobs: SUCCEEDED · Dataset: BUILDING', ['Jobs are complete. The dataset is not published yet.', 'Submit Validation is a separate command.']],
      ['Submit Validation checks all required jobs', ['All succeeded → VALIDATING', 'Otherwise: 409 DATASET_NOT_READY_FOR_VALIDATION', 'Locks: dataset_version → calculation_jobs → execution_attempts']],
    ][step - 1];
    text(450, 788, details[0], 23, 700, C.teal);
    details[1].forEach((line, i) => text(450, 828 + i * 37, line, step === 4 ? 19 : 21, 400, C.muted));
  }

  rect(32, 780, 360, 147, C.blue);
  text(52, 812, 'Safe Abandon', 22, 700, C.teal);
  text(52, 838, 'DRAFT / BUILDING only.', 18, 400, C.muted);
  text(52, 863, 'Active attempts block it:', 17, 700);
  text(52, 886, 'PREPARED / DISPATCHING / ACCEPTED', 16, 400, C.muted);
  text(52, 914, '409 DATASET_HAS_ACTIVE_EXECUTION', 16, 700, C.amber);
  rect(32, 948, 1216, 96, C.tealFill, C.tealLine);
  text(56, 986, step === 6 ? 'Only one final decision can succeed.' : `Step ${step} / 6 — ${STEPS[step - 1].title}`, 27, 700, C.teal);
  text(56, 1023, STEPS[step - 1].caption, 22);
  text(32, 1070, 'Terminal states never change. No dataset-level FAILED. Abandon keeps history; it is not Demo Session Reset.', 18, 400, C.muted);
  add('</svg>');
  return p.join('\n') + '\n';
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
