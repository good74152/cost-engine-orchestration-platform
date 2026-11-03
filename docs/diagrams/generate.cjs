// Writes every diagram as a dependency-free SVG: node docs/diagrams/generate.cjs
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const STYLE = `<style>
:root{--bg:#fff;--ink:#14213d;--muted:#5b6780;--line:#c9d2e0;--node:#fff;--band:#f4f6fa;
--blue:#1d6fd8;--blue-bg:#eaf2fd;--green:#14804a;--green-bg:#e7f6ee;--red:#c22f3d;--red-bg:#fdecee;--amber:#b35c00;--amber-bg:#fff3e2;--violet:#6a3fc8;--violet-bg:#f1ecfc}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--ink:#e6edf3;--muted:#9aa7b8;--line:#3a4557;--node:#161b22;--band:#161b22;
--blue:#6cb0ff;--blue-bg:#14263f;--green:#4cc98a;--green-bg:#10291e;--red:#ff7b86;--red-bg:#33161a;--amber:#f0a94b;--amber-bg:#33240f;--violet:#b49bff;--violet-bg:#231a3f}}
text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:var(--ink)}
.title{font-size:40px;font-weight:800}.sub{font-size:20px;fill:var(--muted)}
.name{font-size:23px;font-weight:700;text-anchor:middle}.note{font-size:17px;fill:var(--muted);text-anchor:middle}
.label{font-size:16px;fill:var(--muted);text-anchor:middle}.point{font-size:22px;font-weight:700}.foot{font-size:16px;fill:var(--muted)}
.state{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:18px;font-weight:700;text-anchor:middle}
</style>`;
const COLORS = ['blue', 'green', 'red', 'amber', 'violet', 'line'];
const DEFS = `<defs>${COLORS.map(c => `<marker id="m-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="var(--${c})"/></marker>`).join('')}</defs>`;
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;');

const rect = (x, y, w, h, color, dashed) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${color ? `var(--${color}-bg)` : 'var(--node)'}" stroke="${color ? `var(--${color})` : 'var(--line)'}" stroke-width="2.5"${dashed ? ' stroke-dasharray="8 6"' : ''}/>`;
const text = (cls, x, y, value, color) => `<text class="${cls}" x="${x}" y="${y}"${color ? ` style="fill:var(--${color})"` : ''}>${esc(value)}</text>`;
const arrow = (d, color = 'blue', { dashed, both } = {}) => `<path d="${d}" fill="none" stroke="var(--${color})" stroke-width="3"${dashed ? ' stroke-dasharray="8 6"' : ''} marker-end="url(#m-${color})"${both ? ` marker-start="url(#m-${color})"` : ''}/>`;
const label = (x, y, value) => text('label', x, y, value);

/** A box with a bold name and muted lines, centered. */
function node(x, y, w, h, name, lines = [], { color, dashed } = {}) {
  const top = y + (h - (30 + lines.length * 23)) / 2 + 24;
  return rect(x, y, w, h, color, dashed) + text('name', x + w / 2, top, name)
    + lines.map((line, i) => text('note', x + w / 2, top + 28 + i * 23, line)).join('');
}
/** A colored outcome: plain name, exact state, short note. */
function outcome(x, y, w, h, color, name, state, note) {
  const cx = x + w / 2;
  return rect(x, y, w, h, color) + text('name', cx, y + 32, name, color) + text('state', cx, y + 60, state)
    + (note ? text('note', cx, y + 84, note) : '');
}
const head = (title, sub) => text('title', 40, 66, title) + text('sub', 40, 100, sub);
function takeaway(width, y, point, foot) {
  return `<rect x="40" y="${y}" width="${width - 80}" height="${foot ? 84 : 60}" rx="14" fill="var(--band)"/>`
    + text('point', 64, y + (foot ? 36 : 38), point) + (foot ? text('foot', 64, y + 64, foot) : '');
}
const svg = (height, alt, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 ${height}" width="1200" height="${height}" role="img" aria-label="${esc(alt)}">${STYLE}${DEFS}<rect width="1200" height="${height}" rx="18" fill="var(--bg)"/>${body}</svg>\n`;
const fan = (fromX, fromY, toX, toY, color) => arrow(`M${fromX} ${fromY}C${fromX + 40} ${fromY} ${toX - 40} ${toY} ${toX - 2} ${toY}`, color);

const diagrams = {
  'architecture.svg': svg(584, 'Browser to Caddy to a Fastify backend to PostgreSQL, with a simulated job system in the backend process',
    head('Where each part runs', 'Only Caddy is public. Everything else stays on private networks.')
    + '<rect x="290" y="134" width="870" height="346" rx="18" fill="none" stroke="var(--line)" stroke-width="2" stroke-dasharray="4 6"/>'
    + text('foot', 312, 164, 'Docker Compose on one host')
    + node(40, 190, 190, 120, 'Browser', ['React page'])
    + node(316, 190, 190, 120, 'Caddy', ['HTTPS', 'serves the page'], { color: 'blue' })
    + node(600, 190, 240, 120, 'Backend', ['Fastify', 'tracks reports, jobs, tries'], { color: 'violet' })
    + node(910, 190, 220, 120, 'PostgreSQL 18', ['the source of truth'], { color: 'green' })
    + arrow('M230 250H314') + label(274, 238, 'HTTPS')
    + arrow('M506 250H598') + label(552, 238, '/demo/*')
    + arrow('M840 250H908', 'green', { both: true }) + label(874, 238, 'SQL')
    + node(560, 368, 320, 92, 'Simulated job system', ['in-process, in place of Airflow'], { color: 'amber', dashed: true })
    + arrow('M720 310V366', 'amber', { dashed: true, both: true }) + `<text class="label" x="732" y="344" style="text-anchor:start">start run · check result</text>`
    + takeaway(1200, 504, "The backend tracks the work. It doesn't do the calculation.")),

  'system-flow.svg': svg(600, 'Create, first run, dispatch, reconcile and submit, ending in published or rejected, with retry and unknown loops',
    head('From create to publish', 'Each step is an explicit command. Nothing publishes on its own.')
    + node(40, 250, 150, 110, 'Create', ['DRAFT', 'PENDING jobs'])
    + node(226, 250, 150, 110, 'First Run', ['inputs frozen', 'BUILDING'])
    + node(412, 250, 150, 110, 'Dispatch', ['save try,', 'then call'], { color: 'violet' })
    + node(598, 250, 150, 110, 'Reconcile', ['reads the', 'real result'], { color: 'violet' })
    + node(784, 250, 150, 110, 'Submit', ['all succeeded', 'VALIDATING'])
    + outcome(980, 176, 180, 82, 'green', 'Publish', 'PUBLISHED')
    + outcome(980, 358, 180, 82, 'red', 'Reject', 'REJECTED')
    + arrow('M190 305H224') + arrow('M376 305H410') + arrow('M562 305H596') + arrow('M748 305H782')
    + fan(934, 305, 980, 217, 'green') + fan(934, 305, 980, 399, 'red')
    + node(462, 130, 236, 84, 'Failed', ['new try, same inputs'], { color: 'red' })
    + arrow('M673 250V216', 'red') + arrow('M487 214V248', 'red')
    + node(462, 396, 236, 84, 'Unknown', ['same try, same run ID'], { color: 'amber' })
    + arrow('M487 360V394', 'amber') + arrow('M673 396V362', 'amber')
    + takeaway(1200, 504, 'A failure adds a try. An unknown result keeps the same one.')),

  'flows/task-002-dataset-creation.svg': svg(604, 'Two requests lock one series row. One creates the version; the other rechecks and gets 409',
    head('Two requests create the same report', 'Dataset creation: one row lock decides the order.')
    + node(40, 150, 220, 90, 'Request A') + node(40, 340, 220, 90, 'Request B')
    + node(410, 225, 280, 130, 'Lock the series row', ['one row per report,', 'year and period'], { color: 'violet' })
    + fan(260, 195, 410, 275, 'blue') + fan(260, 385, 410, 305, 'blue')
    + outcome(840, 140, 320, 100, 'green', 'First to get the lock', 'DRAFT + jobs', 'saved in one transaction')
    + outcome(840, 340, 320, 100, 'red', 'Second waits, rechecks', '409', 'an active version exists')
    + fan(690, 275, 840, 190, 'green') + fan(690, 305, 840, 390, 'red')
    + takeaway(1200, 500, 'One request creates the version. The other waits, rechecks and gets 409.', 'A partial unique index also allows only one active version per report.')),

  'flows/task-003-immutable-snapshot.svg': svg(604, 'Depreciation freezes CAPEX v1 at first run. Later jobs and retries keep v1 after v2 is published. A new version picks v2',
    head('What if upstream data changes mid-build?', 'Frozen inputs: the first Run decides, once, for the whole version.')
    + node(40, 140, 300, 110, 'CAPEX v1', ['PUBLISHED'], { color: 'green' })
    + node(430, 140, 320, 110, 'DPR version 1', ['first Run freezes CAPEX v1'], { color: 'violet' })
    + node(840, 140, 320, 110, 'Its later jobs and retries', ['stay on CAPEX v1'])
    + arrow('M340 195H428') + arrow('M750 195H838')
    + node(40, 330, 300, 110, 'CAPEX v2', ['published later'], { color: 'amber' })
    + node(430, 330, 320, 110, 'DPR version 2', ['first Run freezes CAPEX v2'], { color: 'violet' })
    + node(840, 330, 320, 110, 'Its later jobs and retries', ['stay on CAPEX v2'])
    + arrow('M340 385H428', 'amber') + arrow('M750 385H838', 'amber')
    + takeaway(1200, 500, 'Every job and retry in a version uses the same inputs.', 'Newer upstream data needs a new version. Inputs are frozen at first Run, not at Create.')),

  'flows/task-004-execution-dispatch.svg': svg(612, 'When a response is lost the try stays open, and recovery reuses the same run ID',
    head('What if the response is lost?', 'Execution dispatch: save first, then call the job system.')
    + node(40, 240, 220, 130, '1. Save first', ['Try and run ID', 'COMMIT'])
    + node(310, 240, 240, 130, '2. Call job system', ['no open transaction'])
    + arrow('M260 305H308')
    + fan(550, 305, 620, 186, 'green') + fan(550, 305, 620, 310, 'red') + fan(550, 305, 620, 434, 'amber')
    + outcome(620, 136, 250, 100, 'green', 'Accepted', 'ACCEPTED', 'Job RUNNING')
    + outcome(620, 260, 250, 100, 'red', 'Rejected', 'DISPATCH_FAILED', 'No run exists')
    + outcome(620, 384, 250, 100, 'amber', 'Unknown', 'DISPATCHING', 'Same try stays open')
    + arrow('M870 310H918', 'red') + node(920, 260, 240, 100, 'Run again', ['new try'])
    + arrow('M870 434H918', 'amber') + node(920, 384, 240, 100, 'Run or Reconcile', ['same run ID'])
    + takeaway(1200, 508, "Unknown isn't failure. Recovery keeps the run ID, so nothing runs twice.", 'This needs the job system to honor the run ID. The simulator does; a real one must too.')),

  'flows/task-005-executor-reconciliation.svg': svg(604, 'Reconcile reads the saved run ID, asks the job system outside a transaction, then either saves the result or changes nothing',
    head('What if the job finished but the database disagrees?', 'Reconciliation: the job system holds the truth.')
    + node(40, 225, 220, 130, '1. Saved run ID', ['Reconcile or callback'])
    + node(310, 225, 240, 130, '2. Ask job system', ['no open transaction'])
    + arrow('M260 290H308')
    + fan(550, 290, 620, 190, 'green') + fan(550, 290, 620, 390, 'amber')
    + outcome(620, 140, 250, 100, 'green', 'Result known', 'SUCCEEDED / FAILED', 'or still running')
    + outcome(620, 340, 250, 100, 'amber', 'No result', '503', 'not found or unavailable')
    + arrow('M870 190H918', 'green') + node(920, 140, 240, 100, 'Recheck and save', ['job and try together'])
    + arrow('M870 390H918', 'amber') + node(920, 340, 240, 100, 'Change nothing', ['it does not prove failure'])
    + takeaway(1200, 500, 'A failed lookup proves nothing, so saved state stays as it is.', 'Checks run only on Reconcile or a callback. There is no background worker.')),

  'flows/task-006-dataset-lifecycle.svg': svg(604, 'Draft to building to validating, ending in published or rejected. Draft and building can be abandoned',
    head('Who makes the final decision?', 'Dataset lifecycle: explicit commands, and final states never change.')
    + node(40, 210, 190, 110, 'DRAFT', ['after Create'])
    + node(310, 210, 190, 110, 'BUILDING', ['after first Run'])
    + node(620, 210, 190, 110, 'VALIDATING', ['all jobs succeeded'], { color: 'violet' })
    + arrow('M230 265H308') + label(270, 253, 'Run')
    + arrow('M500 265H618') + label(560, 253, 'Submit')
    + node(930, 130, 230, 100, 'PUBLISHED', ['downstream can use it'], { color: 'green' })
    + node(930, 300, 230, 100, 'REJECTED', ['kept as history'], { color: 'red' })
    + fan(810, 265, 930, 180, 'green') + fan(810, 265, 930, 350, 'red')
    + label(872, 192, 'Publish') + label(872, 352, 'Reject')
    + node(160, 390, 220, 80, 'ABANDONED', ['only with no open try'], { color: 'amber' })
    + arrow('M100 320V430H158', 'amber') + arrow('M440 320V430H382', 'amber')
    + takeaway(1200, 500, 'If Publish and Reject race, a row lock orders them. One wins; the other gets 409.', 'Successful jobs alone never publish a report.')),
};

for (const [file, content] of Object.entries(diagrams)) writeFileSync(join(__dirname, file), content);
