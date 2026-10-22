#!/usr/bin/env node
// Documentation tooling only. See README.md in this directory for isolated setup.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseArgs } = require('node:util');

const { values } = parseArgs({ options: {
  'sharp-module': { type: 'string' },
  'frames-dir': { type: 'string' },
} });
let sharp;
try {
  sharp = require(values['sharp-module'] || 'sharp');
} catch {
  console.error('Install the isolated Sharp tool described in docs/diagrams/flows/README.md, then pass --sharp-module.');
  process.exit(1);
}

const WIDTH = 1280;
const HEIGHT = 920;
const BASENAME = 'task-003-immutable-snapshot';
const COLORS = {
  ink: '#172b4d', muted: '#42526b', line: '#bacbe0', blue: '#f0f5fc',
  teal: '#176270', frozen: '#e2f2f3', frozenLine: '#65a5af',
  amber: '#87500f', amberFill: '#fff8ed', amberLine: '#dec39a',
};
// One readable hold per semantic step, rather than repeated identical frames.
const STEPS = [
  { title: 'Upstream Ready', lines: ['CAPEX v1 is PUBLISHED.', 'Inputs are ready for a new build.'],
    caption: 'CAPEX v1 is the latest published input for this reporting period.', delay: 2600 },
  { title: 'Create DPR v1', lines: ['DRAFT + two PENDING jobs.', 'No snapshot or attempts yet.'],
    caption: 'Creation allocates the dataset and jobs; it does not resolve dependencies.', delay: 3200 },
  { title: 'First Run', lines: ['Freeze inputs + all job definitions.', 'DRAFT → BUILDING; prepare Job A.'],
    caption: 'One transaction freezes the dataset-wide contract and prepares the selected attempt.', delay: 6500 },
  { title: 'Upstream Changes', lines: ['CAPEX v2 becomes PUBLISHED.', 'The frozen CAPEX v1 pin stays.'],
    caption: 'A newer upstream publication does not replace the version already frozen for DPR v1.', delay: 3200 },
  { title: 'Later Job', lines: ['Prepare Job B; reuse the snapshot.', 'Keep the pinned job definitions.'],
    caption: 'Job B reuses CAPEX v1 and its pinned definition; it does not resolve newer inputs.', delay: 4200 },
  { title: 'Invariant Verified', lines: ['Same dataset, same frozen inputs.', 'Retries also preserve the snapshot.'],
    caption: 'Upstream changes do not modify an existing build snapshot.', delay: 5500 },
];
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);

function scene(step, overview = false) {
  const parts = [];
  const add = value => parts.push(value);
  const rect = (x, y, w, h, fill = '#fff', stroke = COLORS.line, extra = '') =>
    add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" ${extra}/>`);
  const text = (x, y, content, size = 20, weight = 400, fill = COLORS.ink) =>
    add(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}">${escape(content)}</text>`);
  const arrow = (d, color = COLORS.teal) =>
    add(`<path class="flow-arrow" d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" marker-end="url(#arrow)"/>`);
  const frozen = step >= 3;
  const created = step >= 2;
  const later = step >= 5;
  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="flow-title flow-desc">`);
  add(`<title id="flow-title">Task 003 — Immutable Dataset Build Snapshot${overview ? ' — Complete Flow' : ` — Step ${step}`}</title>`);
  add('<desc id="flow-desc">Six-step example: CAPEX v1 is published; DPR v1 is created DRAFT with PENDING jobs; First Run takes ordered PostgreSQL row locks, resolves published definitions for every job and selects CAPEX v1, freezes one dataset-wide snapshot and all job definition pins, then commits BUILDING with Job A still PENDING and its attempt PREPARED. CAPEX v2 publishes later. Preparing Job B reuses CAPEX v1 and pinned definitions, without refreshing inputs. DPR v1 always points through its frozen snapshot to CAPEX v1; retries retain that snapshot too. Preparation is Task 003; dispatch and executor acceptance belong to Task 004. This example assumes both jobs require CAPEX at the same company, year and period; it is not a hard-coded domain pipeline.</desc>');
  add(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" fill="${COLORS.teal}"/></marker></defs>`);
  add('<style>text { font-family: Arial, Helvetica, sans-serif; }</style>');
  rect(0, 0, WIDTH, HEIGHT, '#fff', 'none');
  text(32, 49, 'Immutable Dataset Build Snapshot', 32, 700);
  text(32, 84, 'Task 003 · One dataset version, one frozen input contract', 22, 400, COLORS.muted);
  text(32, 139, overview ? 'COMPLETE BUILD SEQUENCE' : `BUILD SEQUENCE · STEP ${step} / 6`, 17, 700, COLORS.teal);

  // A persistent timeline makes the loop and the static fallback understandable.
  add(`<path d="M 58 191 V 681" stroke="${COLORS.line}" stroke-width="2"/>`);
  STEPS.forEach((item, i) => {
    const n = i + 1;
    const y = 164 + i * 98;
    const active = overview || n === step;
    if (active) rect(32, y, 360, 92, COLORS.blue, COLORS.line);
    const complete = n <= step;
    add(`<circle cx="58" cy="${y + 27}" r="15" fill="${complete ? COLORS.teal : '#fff'}" stroke="${COLORS.teal}"/>`);
    text(n < 10 ? 53 : 48, y + 33, n, 17, 700, complete ? '#fff' : COLORS.teal);
    text(84, y + 31, item.title, 21, 700);
    item.lines.forEach((line, j) => text(84, y + 57 + j * 22, line, 17, 400, COLORS.muted));
  });

  text(450, 139, 'EXAMPLE · TW01 / 2026 / Q3', 17, 700, COLORS.teal);
  text(450, 168, 'Both DPR jobs require CAPEX at the same reporting coordinates.', 19, 400, COLORS.muted);

  // Pin arrows appear only after the first-run transaction commits.
  if (frozen) {
    arrow('M 670 270 H 760');
    arrow('M 1005 270 H 1080');
    text(686, 253, 'owns', 17, 400, COLORS.teal);
    text(1021, 253, 'pins', 17, 400, COLORS.teal);
    arrow('M 700 405 V 370 H 820 V 350');
    if (later) {
      arrow('M 900 405 V 350');
      text(922, 389, 'reuse', 17, 700, COLORS.teal);
    }
  }

  rect(450, 195, 220, 155, created ? COLORS.blue : '#fff', COLORS.line, created ? '' : 'stroke-dasharray="6 5"');
  text(470, 235, created ? 'DPR v1' : 'DPR dataset', 28, 700);
  text(470, 273, created ? (frozen ? 'BUILDING' : 'DRAFT') : 'Not created yet', 23, 700, frozen ? COLORS.teal : COLORS.muted);
  text(470, 317, created ? 'Two calculation jobs' : 'Awaiting creation', 18, 400, COLORS.muted);

  rect(760, 195, 245, 155, frozen ? COLORS.frozen : '#fff', frozen ? COLORS.frozenLine : COLORS.line,
    frozen ? 'stroke-width="2"' : 'stroke-dasharray="6 5"');
  text(780, 232, frozen ? 'Frozen Snapshot' : 'Build Snapshot', 24, 700, frozen ? COLORS.teal : COLORS.muted);
  text(780, 269, frozen ? 'CAPEX → v1' : 'Not frozen yet', 24, 700, frozen ? COLORS.teal : COLORS.muted);
  text(780, 303, frozen ? 'All job definitions pinned' : 'Created at First Run', 18, 400, COLORS.muted);
  text(780, 330, frozen ? 'One per Dataset Version' : 'Dataset-wide scope', 18, 400, COLORS.muted);

  rect(1080, 195, 168, 155, COLORS.frozen, COLORS.frozenLine);
  text(1096, 235, 'CAPEX v1', 26, 700);
  text(1096, 273, 'PUBLISHED', 19, 700, COLORS.teal);
  text(1096, 317, frozen ? 'Frozen input' : 'Latest published', 18, 400, COLORS.muted);

  text(450, 389, 'CALCULATION JOBS', 17, 700, COLORS.muted);
  for (const [index, name] of ['A', 'B'].entries()) {
    const x = index === 0 ? 450 : 740;
    const prepared = index === 0 ? frozen : later;
    rect(x, 405, 265, 155, prepared ? COLORS.blue : '#fff', COLORS.line);
    text(x + 20, 442, `Job ${name}`, 23, 700);
    text(x + 20, 476, created ? 'Job: PENDING' : 'Not created yet', 21, 400, COLORS.muted);
    text(x + 20, 512, prepared ? 'Attempt: PREPARED' : 'No attempt', 20, prepared ? 700 : 400, prepared ? COLORS.teal : COLORS.muted);
    text(x + 20, 542, frozen ? 'Uses frozen definition' : (created ? 'Definition not pinned' : 'Created with DPR v1'), 17, 400, COLORS.muted);
  }
  if (step >= 4) {
    rect(1080, 405, 168, 155, COLORS.amberFill, COLORS.amberLine);
    text(1096, 442, 'CAPEX v2', 26, 700);
    text(1096, 476, 'PUBLISHED', 19, 700, COLORS.amber);
    text(1096, 512, 'New latest', 18, 400, COLORS.muted);
    text(1096, 542, 'Not adopted', 18, 700, COLORS.amber);
  }

  rect(450, 592, 798, 164, frozen ? COLORS.frozen : COLORS.blue, frozen ? COLORS.frozenLine : COLORS.line);
  if (step === 5 && !overview) {
    text(470, 629, 'Later preparation · Existing BUILDING snapshot', 23, 700, COLORS.teal);
    text(470, 663, 'Lock output version → verify snapshot → lock selected job', 20, 400, COLORS.muted);
    text(470, 696, 'Reuse frozen upstream versions and pinned dependency definitions.', 20, 400, COLORS.muted);
    text(470, 729, 'Job B remains PENDING · Its attempt becomes PREPARED', 20, 700, COLORS.teal);
  } else if (frozen) {
    text(470, 629, 'First Run · One PostgreSQL transaction', 23, 700, COLORS.teal);
    text(470, 663, 'Row locks: calculation types → upstream series → output version → selected job', 20, 400, COLORS.muted);
    text(470, 696, 'Resolve PUBLISHED definitions → select CAPEX v1 → freeze once', 20, 400, COLORS.muted);
    text(470, 729, 'Commit: DPR BUILDING · Job A PENDING · Attempt PREPARED', 20, 700, COLORS.teal);
  } else {
    text(470, 629, step === 1 ? 'Upstream ready for a future First Run' : 'Creation is separate from snapshot freeze', 23, 700);
    text(470, 668, step === 1 ? 'CAPEX v1 is available for this company, fiscal year and period.' : 'DPR v1 exists, with one PENDING job per active calculation type.', 20, 400, COLORS.muted);
    text(470, 704, 'Definitions and concrete upstream versions are selected at First Run.', 20, 400, COLORS.muted);
    text(470, 738, 'No executor interaction occurs during Task 003 preparation.', 20, 700, COLORS.teal);
  }

  rect(32, 787, 1216, 98, frozen ? COLORS.frozen : COLORS.blue, frozen ? COLORS.frozenLine : COLORS.line);
  text(56, 825, step === 6 ? 'DPR v1 → Frozen Snapshot → CAPEX v1' : `Step ${step} / 6 — ${STEPS[step - 1].title}`, 27, 700, COLORS.teal);
  text(56, 863, STEPS[step - 1].caption, step === 6 ? 23 : 22, step === 6 ? 700 : 400, COLORS.ink);
  text(32, 910, 'Preparation creates a PREPARED attempt; dispatch and executor acceptance belong to Task 004.', 18, 400, COLORS.muted);
  add('</svg>');
  return parts.join('\n') + '\n';
}

async function main() {
  const rawFrames = [];
  if (values['frames-dir']) await fs.mkdir(values['frames-dir'], { recursive: true });
  for (let step = 1; step <= STEPS.length; step++) {
    const svg = scene(step);
    const frame = sharp(Buffer.from(svg)).flatten({ background: '#fff' }).removeAlpha();
    const { data, info } = await frame.clone().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, WIDTH);
    assert.equal(info.height, HEIGHT);
    assert.equal(info.channels, 3);
    rawFrames.push(data);
    if (values['frames-dir']) {
      await fs.writeFile(path.join(values['frames-dir'], `step-${step}.svg`), svg);
      await frame.png().toFile(path.join(values['frames-dir'], `step-${step}.png`));
    }
  }
  const gif = await sharp(Buffer.concat(rawFrames), {
    raw: { width: WIDTH, height: HEIGHT * STEPS.length, channels: 3, pageHeight: HEIGHT },
  }).gif({ loop: 0, delay: STEPS.map(s => s.delay), colours: 128, dither: 0, effort: 10 }).toBuffer();
  const meta = await sharp(gif, { animated: true }).metadata();
  assert.equal(meta.pages, 6);
  assert.equal(meta.pageHeight, HEIGHT);
  assert.equal(meta.loop, 0);
  assert.deepEqual(meta.delay, STEPS.map(s => s.delay));
  assert.ok(gif.length < 1024 * 1024, 'Keep the README GIF under 1 MiB');
  await fs.writeFile(path.join(__dirname, `${BASENAME}.svg`), scene(6, true));
  await fs.writeFile(path.join(__dirname, `${BASENAME}.gif`), gif);
  console.log(`${BASENAME}: ${WIDTH} × ${HEIGHT}, 6 frames, ${meta.delay.reduce((a, b) => a + b) / 1000}s loop, ${gif.length} bytes`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
