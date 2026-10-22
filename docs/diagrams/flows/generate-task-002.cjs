#!/usr/bin/env node
// Documentation tooling only; matches the Task 003 SVG/Sharp pipeline.
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
  console.error('Use the isolated Sharp installation in docs/diagrams/flows/README.md and pass --sharp-module.');
  process.exit(1);
}

const WIDTH = 1280;
const HEIGHT = 1080;
const BASENAME = 'task-002-dataset-creation';
const C = {
  ink: '#172b4d', muted: '#42526b', line: '#bacbe0', blue: '#f0f5fc',
  teal: '#176270', tealFill: '#e2f2f3', tealLine: '#65a5af',
  amber: '#87500f', amberFill: '#fff8ed', amberLine: '#dec39a',
};
const STEPS = [
  { title: 'Concurrent Requests', lines: ['A and B request the same dataset.', 'Either request may win.'], delay: 2800,
    caption: 'Both requests use the same canonical identity: DPR / TW01 / 2026 / Q3.' },
  { title: 'Acquire Series Lock', lines: ['One transaction holds the row lock.', 'The other waits for coordination.'], delay: 5200,
    caption: 'Per-series locking serializes creation; a first INSERT may also wait on identity uniqueness.' },
  { title: 'Atomic Creation', lines: ['Check active → allocate → DRAFT.', 'Create all required PENDING jobs.'], delay: 5200,
    caption: 'Dataset, counter allocation and the complete job set are written in one transaction.' },
  { title: 'Transaction Commit', lines: ['Commit the complete dataset build.', 'Release the PostgreSQL row lock.'], delay: 3000,
    caption: 'The winning transaction commits before its HTTP 201 response; the waiting request resumes.' },
  { title: 'Second Request', lines: ['Lock, then recheck active versions.', 'Conflict; no new version allocation.'], delay: 4700,
    caption: 'The second transaction finds the active version and rolls back without increasing the counter.' },
  { title: 'Invariant Verified', lines: ['20 requests: one complete creation.', 'No Duplicate Active Dataset.'], delay: 6000,
    caption: 'No Duplicate Active Dataset · Row locking + atomic transactions + database constraints.' },
];
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);

function scene(step, overview = false) {
  const p = [];
  const add = value => p.push(value);
  const rect = (x, y, w, h, fill = '#fff', stroke = C.line) =>
    add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}"/>`);
  const text = (x, y, value, size = 20, weight = 400, fill = C.ink) =>
    add(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}">${escape(value)}</text>`);
  const arrow = (d, color = C.teal, waiting = false) =>
    add(`<path class="flow-arrow" d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" ${waiting ? 'stroke-dasharray="7 6"' : `marker-end="url(#${color === C.amber ? 'wait-arrow' : 'arrow'})"`}/>`);
  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="flow-title flow-desc">`);
  add(`<title id="flow-title">Task 002 — Concurrent Dataset Creation${overview ? ' — Complete Flow' : ` — Step ${step}`}</title>`);
  add('<desc id="flow-desc">Two HTTP requests create DPR/TW01/2026/Q3 concurrently. Either may win; A wins only in this illustration. Each transaction inserts the canonical dataset series with ON CONFLICT DO NOTHING, then locks it with SELECT FOR UPDATE. A new series insert may wait on unique-identity conflict; an existing-row contender may wait on its row lock. The winner checks for active versions, increments dataset_series.last_allocated_version, creates a DRAFT version and one PENDING job per active calculation type, then commits and releases the lock. The second request acquires the row lock, sees an active version, rolls back before allocating, and returns 409 ACTIVE_DATASET_VERSION_EXISTS. The real PostgreSQL regression fixture with three active types asserts that 20 concurrent requests yield one HTTP 201, nineteen HTTP 409, one dataset series, one DRAFT version, three PENDING jobs and counter one. These are existing test assertions, not a newly executed database test report. Database constraints backstop per-series locking and atomic transactions. Different series can proceed without a shared global lock. Zero active types rolls back all creation writes. Creation makes no snapshot or execution attempt; committed historical version numbers are never reused.</desc>');
  add(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" fill="${C.teal}"/></marker><marker id="wait-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" fill="${C.amber}"/></marker></defs>`);
  add('<style>text { font-family: Arial, Helvetica, sans-serif; }</style>');
  rect(0, 0, WIDTH, HEIGHT, '#fff', 'none');
  text(32, 49, 'Dataset Creation & PostgreSQL Concurrency', 32, 700);
  text(32, 84, 'Task 002 · Per-Series Row Locking · Atomic Transaction · Database Constraints', 22, 400, C.muted);
  text(32, 139, overview ? 'COMPLETE CREATION SEQUENCE' : `CREATION SEQUENCE · STEP ${step} / 6`, 17, 700, C.teal);
  add(`<path d="M 58 191 V 681" stroke="${C.line}" stroke-width="2"/>`);
  STEPS.forEach((s, i) => {
    const y = 164 + i * 98;
    if (overview || i + 1 === step) rect(32, y, 360, 92, C.blue);
    add(`<circle cx="58" cy="${y + 27}" r="15" fill="${i < step ? C.teal : '#fff'}" stroke="${C.teal}"/>`);
    text(53, y + 33, i + 1, 17, 700, i < step ? '#fff' : C.teal);
    text(84, y + 31, s.title, 21, 700);
    s.lines.forEach((line, j) => text(84, y + 57 + j * 22, line, 17, 400, C.muted));
  });

  text(430, 139, 'DPR / TW01 / 2026 / Q3', 25, 700);
  text(430, 168, 'Identity: (domain, companyCode, fiscalYear, period) · Either request may win', 19, 400, C.muted);
  const waiting = step === 2 || step === 3;
  const committed = step >= 4;
  const conflicted = step >= 5;
  rect(430, 195, 350, 120, step >= 2 ? C.tealFill : C.blue, step >= 2 ? C.tealLine : C.line);
  text(450, 232, 'Request A', 26, 700);
  text(450, 267, committed ? 'HTTP 201 · Created' : (step >= 2 ? 'Transaction A · Holds lock' : 'BEGIN transaction A'), 22, 700, step >= 2 ? C.teal : C.ink);
  text(450, 296, committed ? 'Complete dataset committed' : 'POST /dataset-versions', 18, 400, C.muted);
  rect(898, 195, 350, 120, step >= 2 ? C.amberFill : C.blue, step >= 2 ? C.amberLine : C.line);
  text(918, 232, 'Request B', 26, 700);
  text(918, 267, conflicted ? 'HTTP 409 · Conflict' : (waiting ? 'WAITING · Transaction B' : (step === 4 ? 'Resumes after A commits' : 'BEGIN transaction B')), 22, 700, step >= 2 ? C.amber : C.ink);
  text(918, 296, conflicted ? 'Rollback; allocation unchanged' : (waiting ? 'INSERT conflict / row lock' : 'POST /dataset-versions'), 18, 400, C.muted);

  if (step >= 2) {
    arrow('M 605 315 V 356 H 760 V 388');
    text(623, 345, 'FOR UPDATE', 17, 700, C.teal);
    if (waiting) {
      arrow('M 1074 315 V 366', C.amber, true);
      add(`<path d="M 1059 367 H 1089" stroke="${C.amber}" stroke-width="3"/>`);
      text(1092, 355, 'wait', 18, 700, C.amber);
    } else {
      arrow('M 1074 315 V 388', C.amber);
      text(1092, 355, 'recheck', 18, 700, C.amber);
    }
  }
  text(450, 419, 'First insert', 22, 700, C.amber);
  text(450, 451, 'may wait on', 18, 400, C.muted);
  text(450, 483, 'UNIQUE identity', 18, 700, C.amber);
  rect(650, 388, 598, 115, C.blue);
  text(670, 419, 'dataset_series · Shared coordination row', 23, 700);
  text(670, 451, step === 1 ? 'Per-Series Row Lock · Acquired inside each transaction' :
    (waiting ? 'Per-Series Row Lock · A holds; B waits for coordination' :
      (step === 4 ? 'A COMMIT → row lock released → B can acquire' : 'B rechecks under lock → ROLLBACK releases lock')), 19, 700, C.teal);
  text(670, 483, `last_allocated_version = ${step >= 3 ? '1' : '0'}${step === 3 ? ' (uncommitted)' : (committed ? ' (committed)' : ' (initial)')}`, 21, 400, C.muted);

  rect(430, 536, 818, 220, conflicted && step === 5 ? C.amberFill : C.tealFill, conflicted && step === 5 ? C.amberLine : C.tealLine);
  if (step <= 2) {
    text(450, 573, 'Find / create the series, then lock it', 24, 700, C.teal);
    text(450, 611, 'INSERT … ON CONFLICT (canonical identity) DO NOTHING', 21, 400, C.muted);
    text(450, 644, 'SELECT dataset_series … FOR UPDATE', 21, 700, C.teal);
    text(450, 680, 'New series: an INSERT may wait on the unique-identity conflict.', 20, 400, C.muted);
    text(450, 713, 'Existing row: FOR UPDATE may wait for the current holder.', 20, 400, C.muted);
    text(450, 742, 'Constraints backstop locking; they are not the only protection.', 19, 400, C.muted);
  } else if (step === 5) {
    text(450, 573, '409 ACTIVE_DATASET_VERSION_EXISTS', 27, 700, C.amber);
    text(450, 615, 'B acquires the series lock and finds an active DRAFT version.', 21, 400, C.muted);
    text(450, 653, 'ROLLBACK before version allocation; counter remains 1.', 21, 700, C.amber);
    text(450, 691, 'No second active Dataset Version; no additional jobs.', 21, 400, C.muted);
    text(450, 731, 'The active check includes DRAFT / BUILDING / VALIDATING.', 20, 400, C.muted);
  } else {
    text(450, 573, 'Atomic Transaction · Winning request', 24, 700, C.teal);
    text(450, 611, '1  Check: no active DRAFT / BUILDING / VALIDATING version', 21, 400, C.muted);
    text(450, 647, '2  Increment dataset_series.last_allocated_version → 1', 21, 400, C.muted);
    text(450, 683, '3  Insert Dataset Version v1 with status DRAFT', 21, 400, C.muted);
    text(450, 719, '4  Insert PENDING jobs for all active calculation types', 21, 400, C.muted);
    text(450, 745, step === 3 ? 'All writes remain uncommitted; A keeps the lock.' : 'COMMIT complete dataset + jobs → release lock → HTTP 201', 18, 700, C.teal);
  }

  rect(32, 780, 360, 154, C.blue);
  text(52, 812, 'Database Constraints', 23, 700);
  text(52, 843, 'Unique identity + series/version', 18, 400, C.muted);
  text(52, 869, 'One active version per series', 18, 400, C.muted);
  text(52, 895, 'Different series run in parallel', 18, 700, C.teal);
  text(52, 921, 'Per-series locks; no global lock', 18, 400, C.muted);
  rect(430, 780, 818, 154, step === 6 ? C.tealFill : C.blue, step === 6 ? C.tealLine : C.line);
  if (step === 6) {
    text(450, 812, 'PostgreSQL regression · 20 concurrent requests', 23, 700, C.teal);
    text(450, 850, '1 × HTTP 201', 23, 700, C.teal);
    text(832, 850, '19 × HTTP 409', 23, 700, C.amber);
    text(450, 885, '1 Dataset Series', 21, 700);
    text(832, 885, '1 DRAFT Dataset Version', 21, 700);
    text(450, 920, '3 PENDING Jobs', 21, 700);
    text(832, 920, 'Version Counter = 1', 21, 700);
  } else {
    text(450, 815, 'Regression fixture · Three active DPR calculation types', 23, 700);
    text(450, 852, 'ASSET_SUMMARY · TABLE_X · TABLE_Y', 22, 400, C.muted);
    text(450, 892, '20 same-series requests; final database counts in Step 6.', 21, 400, C.muted);
    text(450, 921, 'Source: dataset-version-creation-v2.pg.test.ts', 18, 400, C.muted);
  }
  rect(32, 948, 1216, 96, C.tealFill, C.tealLine);
  text(56, 986, step === 6 ? 'One series → One active dataset → One complete job set' : `Step ${step} / 6 — ${STEPS[step - 1].title}`, 27, 700, C.teal);
  text(56, 1023, STEPS[step - 1].caption, 22, step === 6 ? 700 : 400);
  text(32, 1070, 'No active types → full rollback. Creation makes no snapshot or attempt. Committed version numbers are never reused.', 18, 400, C.muted);
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
  assert.ok(gif.length < 1024 * 1024, 'README GIF must stay below 1 MiB');
  await fs.writeFile(path.join(__dirname, `${BASENAME}.svg`), scene(6, true));
  await fs.writeFile(path.join(__dirname, `${BASENAME}.gif`), gif);
  console.log(`${BASENAME}: ${WIDTH} × ${HEIGHT}, six steps, ${meta.delay.reduce((a, b) => a + b) / 1000}s loop, ${gif.length} bytes`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
