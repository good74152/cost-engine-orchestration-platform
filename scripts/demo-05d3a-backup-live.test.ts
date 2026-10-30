import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { setImmediate } from 'node:timers/promises';

interface Result { code: number; out: string; err: string }
async function command(exe: string, args: string[], env = process.env, input?: string): Promise<Result> {
  return new Promise((done, reject) => {
    const p = spawn(exe, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', err = '';
    p.stdout.on('data', b => out += String(b)); p.stderr.on('data', b => err += String(b)); p.once('error', reject);
    p.stdin.on('error', () => {}); p.stdin.end(input); p.once('close', code => done({ code: code ?? -1, out, err }));
  });
}
const posix = (p: string) => process.platform === 'win32' ? p.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d: string) => '/' + d.toLowerCase()) : p;
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function until<T>(read: () => Promise<T>, ready: (v: T) => boolean, label: string) {
  const deadline = Date.now() + 120000;
  for (;;) { const value = await read(); if (ready(value)) return value; assert.ok(Date.now() < deadline, label); await setImmediate(); }
}

test('Demo-05D-3A real Docker: live API writes, shared snapshot and isolated data restore', { timeout: 1200000 }, async t => {
  const id = 'demo05d3a_test_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const directory = await mkdtemp(join(tmpdir(), id + '-')), secrets = join(directory, 'secrets'), backups = join(directory, 'backups');
  await mkdir(secrets, { mode: 0o700 }); await mkdir(backups, { mode: 0o700 });
  const password = randomBytes(24).toString('hex'), proxy = randomBytes(32).toString('hex'), url = `postgres://demo_owner:${password}@database:5432/cost_engine_demo`;
  const privateValues = [password, proxy, url];
  for (const [key, value] of Object.entries({ postgres_password: password, proxy_secret: proxy, database_url: url })) await writeFile(join(secrets, key), value, { mode: 0o644 });
  const envFile = join(directory, 'compose.env'), override = join(directory, 'override.yaml');
  await writeFile(envFile, `DEPLOYMENT_VERSION=${id}\nCOMPOSE_PROJECT_NAME=${id}\nDEMO_PUBLIC_ORIGIN=https://localhost\nACME_EMAIL=test@example.invalid\nDEMO_SECRETS_DIR=${JSON.stringify(secrets.replaceAll('\\', '/'))}\nDEMO_CREATES_PER_MINUTE=100\nDEMO_MUTATIONS_PER_MINUTE=1000\nDEMO_GLOBAL_MUTATIONS_PER_MINUTE=5000\n`);
  await writeFile(override, `services:\n  backend:\n    container_name: ${id}-backend\n  web:\n    ports: !override []\n`);
  const base = ['compose', '--project-name', id, '--env-file', envFile, '-f', resolve('deploy/compose.yaml'), '-f', override];
  const safe = (s: string) => privateValues.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), s);
  const docker = async (args: string[], ok = true, input?: string) => {
    const r = await command('docker', args, process.env, input); if (ok) assert.equal(r.code, 0, safe(r.err.slice(-2500) + r.out.slice(-1000))); return r;
  };
  const compose = (...args: string[]) => docker([...base, ...args]);
  const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'sh';
  const env = { ...process.env, COMPOSE_PROJECT_NAME: id, DEMO_DEPLOY_ENV: posix(envFile), DEMO_COMPOSE_FILE: posix(resolve('deploy/compose.yaml')),
    DEMO_COMPOSE_OVERRIDE: posix(override), DEMO_BACKUP_DIR: posix(backups) };
  const target = ['--database-url-file', '/run/secrets/database_url'];
  const script = async (name: string, args: string[] = [], ok = true, extra: NodeJS.ProcessEnv = {}) => {
    const r = await command(shell, [posix(resolve('deploy/scripts/' + name + '.sh')), ...args], { ...env, ...extra });
    for (const secret of privateValues) assert.ok(!(r.out + r.err).includes(secret), 'No credentials or Session tokens in backup logs');
    if (ok) assert.equal(r.code, 0, safe(r.err + r.out));
    else { assert.notEqual(r.code, 0); assert.doesNotMatch(r.out, /BACKUP_CREATED|RESTORE_VERIFIED/); } return r;
  };
  const backup = (ok = true, extra: NodeJS.ProcessEnv = {}) => script('backup-live', target, ok, extra);
  const sql = async (q: string) => (await compose('exec', '-T', 'database', 'psql', '-U', 'demo_owner', '-d', 'cost_engine_demo', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q)).out.trim();
  const inspect = async (service: string) => { const name = (await compose('ps', '--all', '-q', service)).out.trim(); return name ? JSON.parse((await docker(['inspect', name])).out)[0] : null; };
  const resources = async () => ({ containers: (await docker(['ps', '--all', '--filter', 'label=cost-engine.restore.purpose=demo05d2', '--format', '{{.ID}}'])).out.trim(),
    volumes: (await docker(['volume', 'ls', '--filter', 'label=cost-engine.restore.purpose=demo05d2', '--format', '{{.Name}}'])).out.trim() });
  const api = async (path: string, cookie = '', body: unknown = {}, method = 'POST') => {
    const js = `import{readFileSync}from'node:fs';const x=JSON.parse(readFileSync(0,'utf8'));const r=await fetch('http://127.0.0.1:3000'+x.path,{method:x.method,headers:{origin:process.env.DEMO_PUBLIC_ORIGIN,'content-type':'application/json','x-demo-session':'1','x-demo-proxy-key':readFileSync('/run/secrets/proxy_secret','utf8').trim(),'x-demo-client-ip':'127.0.0.1',...(x.cookie?{cookie:x.cookie}:{})},...(x.method==='POST'?{body:JSON.stringify(x.body)}:{})});console.log(JSON.stringify({status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0]??'',body:await r.json()}));`;
    const r = await docker([...base, 'exec', '-T', 'backend', 'node', '--input-type=module', '-e', js], true, JSON.stringify({ path, cookie, body, method }));
    const value = JSON.parse(r.out); if (value.cookie) privateValues.push(value.cookie);
    assert.equal(value.status, path === '/demo/sessions' || path === '/demo/dataset-versions' ? 201 : 200, safe(JSON.stringify(value.body)));
    return value;
  };
  let cookie = '', fab: any, capex: any, archive = '', manifest: any, initialized = false;
  const create = async (domain: string, year = 2026) => (await api('/demo/dataset-versions', cookie, { domain, fiscalYear: year, period: 'Q4' })).body;
  const run = async (job: string, completion = 'RUNNING') => (await api(`/demo/calculation-jobs/${job}/run`, cookie, { simulation: { dispatch: 'ACCEPT', completion } })).body;
  const reconcile = (job: string) => api(`/demo/calculation-jobs/${job}/reconcile`, cookie);
  const publish = async (dataset: any) => { await api(`/demo/dataset-versions/${dataset.datasetVersionId}/submit-validation`, cookie); await api(`/demo/dataset-versions/${dataset.datasetVersionId}/publish`, cookie); };
  const sourceIdentity = async () => {
    const db = await inspect('database'), b = await inspect('backend');
    const volume = db.Mounts.find((m: { Type: string; Destination: string }) => m.Type === 'volume' && m.Destination === '/var/lib/postgresql');
    assert.ok(volume?.Name);
    return { database: db.Id, volume: volume.Name, backend: b?.Id, started: b?.State.StartedAt,
      gate: await sql('SELECT row_to_json(g) FROM demo_admission_control g') };
  };
  const fault = async (mode: string) => {
    const bin = join(directory, 'shim-' + mode); await mkdir(bin);
    const actual = (await command(shell, ['-c', 'command -v docker'])).out.trim(); assert.ok(actual);
    const marker = join(directory, mode + '.ready'), release = join(directory, mode + '.release');
    const dumpFirst = mode === 'connection-after-dump' ? '"$DEMO_TEST_REAL_DOCKER" "$@" || exit 48\n' : '';
    const stopAfter = mode === 'connection-after-dump' ? 'exit 0\n' : '';
    await writeFile(join(bin, 'docker'), `#!/bin/sh\ncase " $* " in *" pg_dump "*)\n ${dumpFirst}printf ready > "$DEMO_TEST_MARKER"\n ${mode === 'fail' ? 'exit 47' : 'while [ ! -f "$DEMO_TEST_RELEASE" ]; do sleep 0.05; done'}\n ${stopAfter};; esac\nexec "$DEMO_TEST_REAL_DOCKER" "$@"\n`, { mode: 0o755 });
    const pending = command(shell, ['-c', 'PATH="$1:$PATH"; export PATH; exec sh "$2" --database-url-file /run/secrets/database_url', 'fault', posix(bin), posix(resolve('deploy/scripts/backup-live.sh'))],
      { ...env, DEMO_TEST_REAL_DOCKER: actual, DEMO_TEST_MARKER: posix(marker), DEMO_TEST_RELEASE: posix(release) });
    pending.catch(() => {}); return { pending, marker, release };
  };
  try {
    await t.test('production images contain operational tools; all scripts parse without deploying to production', async () => {
      await compose('--profile', 'operations', 'build', 'backend', 'operator'); initialized = true;
      await docker(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '--mount', `type=bind,source=${resolve('deploy/scripts')},target=/scripts,readonly`, 'node:24-bookworm-slim', '-c', 'for f in /scripts/*.sh; do sh -n "$f" || exit; done']);
      await compose('up', '-d', '--no-deps', '--wait', 'database'); await script('operate', ['migrate-up']); await script('operate', ['seed-six-domain']);
    });
    await t.test('LEGACY_OPEN and DRAINING refuse online backup and leave no artifacts', async () => {
      await backup(false); assert.deepEqual(await readdir(backups), []);
      await script('operate', ['admission-drain', ...target]); await backup(false); assert.deepEqual(await readdir(backups), []);
      await script('operate', ['cutover', ...target]);
    });
    await t.test('exact configuration conflict refuses backup without changing the gate', async () => {
      await sql("UPDATE calculation_types SET airflow_dag_id='fixture_conflict' WHERE code='DEMO_CAPEX_TABLE_Y'");
      try { await backup(false); } finally { await sql("UPDATE calculation_types SET airflow_dag_id='demo_capex_table_y' WHERE code='DEMO_CAPEX_TABLE_Y'"); }
      assert.equal(await sql('SELECT state FROM demo_admission_control'), 'WORKFLOW_OPEN');
    });
    await t.test('explicit Compose Demo target and safe outside-Git directory are mandatory', async () => {
      await script('backup-live', [], false); await script('backup-live', ['--database-url-file', '/run/secrets/other'], false);
      await backup(false, { DEMO_BACKUP_DIR: posix(resolve('.')) });
      await writeFile(join(secrets, 'database_url'), url + '?host=outside.invalid');
      try { await backup(false); } finally { await writeFile(join(secrets, 'database_url'), url); }
      assert.deepEqual(await readdir(backups), []);
    });
    await t.test('live Backend creates valid Session, Dataset, multi-job attempts and immutable snapshots through real APIs', async () => {
      await script('start'); cookie = (await api('/demo/sessions')).cookie; assert.ok(cookie);
      fab = await create('FAB_COST'); for (const j of fab.calculationJobs) { await run(j.jobId, 'SUCCEEDED'); await reconcile(j.jobId); } await publish(fab);
      capex = await create('CAPEX'); assert.equal(capex.calculationJobs.length, 2); for (const j of capex.calculationJobs) await run(j.jobId);
      assert.equal(await sql('SELECT count(*) FROM execution_attempts'), '3'); assert.equal(await sql('SELECT count(*) FROM dataset_build_snapshots'), '2');
    });
    await t.test('WORKFLOW_OPEN with business data creates private pg_dump -Fc, correct SHA/size/version without stopping Backend', async () => {
      const before = await sourceIdentity(); manifest = JSON.parse((await backup()).out); archive = join(backups, manifest.identity, 'backup.dump');
      const bytes = await readFile(archive); assert.equal(bytes.subarray(0, 5).toString(), 'PGDMP'); assert.equal(digest(bytes), manifest.sha256);
      assert.equal(bytes.length, Number(manifest.sizeBytes)); assert.equal(manifest.snapshot.deploymentVersion, id);
      assert.equal(manifest.snapshot.admissionState, 'WORKFLOW_OPEN'); assert.equal(manifest.snapshot.counts.demo_sessions, 1);
      assert.equal(manifest.snapshot.counts.execution_attempts, 3); assert.equal(manifest.snapshot.counts.dataset_build_snapshots, 2);
      assert.deepEqual(await sourceIdentity(), before); assert.equal((await inspect('backend')).State.Running, true);
      if (process.platform !== 'win32') { assert.equal((await stat(archive)).mode & 0o077, 0); assert.equal((await stat(dirname(archive))).mode & 0o077, 0); }
      console.info('LIVE_BACKUP_CREATED', JSON.stringify({ identity: manifest.identity, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, snapshot: manifest.snapshot }));
    });
    await t.test('real PostgreSQL 18 restore matches complete schema/configuration/data and preserves live source and FakeExecutor', async () => {
      const before = await sourceIdentity(), initial = await resources();
      const r = JSON.parse((await script('verify-backup-live', ['--backup-file', posix(archive)], true, { DATABASE_URL: url, DEMO_LIVE_BACKUP_DATABASE_URL: url })).out);
      assert.equal(r.result, 'RESTORE_VERIFIED'); assert.equal(r.admissionState, 'WORKFLOW_OPEN'); assert.equal(r.schemaSha256, manifest.snapshot.schemaSha256);
      assert.equal(r.configurationSha256, manifest.snapshot.configurationSha256); assert.equal(r.dataSha256, manifest.snapshot.dataSha256);
      assert.deepEqual(r.counts, manifest.snapshot.counts); assert.equal(r.isolation.network, 'none'); assert.equal(r.isolation.cleaned, true);
      assert.notEqual(r.isolation.volume, before.volume); assert.deepEqual(await resources(), initial); assert.deepEqual(await sourceIdentity(), before);
      // The original in-memory fake identity still exists; verifier neither restarted
      // Backend nor attempted to reconstruct/dispatch restored fake runs.
      for (const j of capex.calculationJobs) await reconcile(j.jobId);
      assert.equal(await sql('SELECT count(*) FROM execution_attempts'), '3'); assert.equal(await inspect('web'), null);
      console.info('LIVE_RESTORE_VERIFIED', JSON.stringify(r));
    });
    await t.test('explicit dump barrier permits Session/Dataset creation, Attempt/Job updates and Publish after snapshot export', async () => {
      const before = await sourceIdentity(), initial = await readdir(backups); const f = await fault('concurrent');
      try {
        await until(() => stat(f.marker).then(() => true, () => false), Boolean, 'pg_dump invocation barrier');
        assert.equal(await sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='cost-engine-operational-backup' AND state='idle in transaction'"), '1');
        assert.equal(await sql("SELECT count(*)>0 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='cost-engine-operational-backup' AND l.relation='dataset_versions'::regclass AND l.mode='AccessShareLock' AND l.granted"), 't');
        await api('/demo/sessions'); const later = await create('FAB_COST', 2027); assert.ok(later.datasetVersionId);
        for (const j of capex.calculationJobs) {
          const attempt = JSON.parse(await sql(`SELECT json_agg(id) FROM execution_attempts WHERE calculation_job_id='${j.jobId}'`))[0];
          await api(`/demo/execution-attempts/${attempt}/fake-state`, cookie, { state: 'SUCCEEDED' }); await reconcile(j.jobId);
        }
        await publish(capex); assert.equal(await sql('SELECT count(*) FROM demo_sessions'), '2'); assert.equal(await sql('SELECT count(*) FROM dataset_versions'), '3');
        await writeFile(f.release, 'release'); const r = await f.pending; assert.equal(r.code, 0, safe(r.err));
        const m = JSON.parse(r.out); assert.equal(m.snapshot.counts.demo_sessions, 1); assert.equal(m.snapshot.counts.dataset_versions, 2);
        const restored = JSON.parse((await script('verify-backup-live', ['--backup-file', posix(join(backups, m.identity, 'backup.dump'))])).out);
        assert.deepEqual(restored.counts, m.snapshot.counts); assert.equal(restored.dataSha256, m.snapshot.dataSha256);
        assert.deepEqual(await sourceIdentity(), before); assert.equal((await readdir(backups)).length, initial.length + 1);
        console.info('LIVE_CONCURRENCY_VERIFIED', JSON.stringify({ snapshotSessions: 1, liveSessions: 2, snapshotDatasets: 2, liveDatasets: 3, restoreMatchesExportedSnapshot: true, backendRestarted: false }));
      } finally { await writeFile(f.release, 'release'); await f.pending; }
    });
    await t.test('repeated backups have independent identities and never overwrite the first archive', async () => {
      const m = JSON.parse((await backup()).out); assert.notEqual(m.identity, manifest.identity); assert.equal(digest(await readFile(archive)), manifest.sha256);
      assert.equal(m.snapshot.counts.demo_sessions, 2); assert.equal(m.snapshot.counts.dataset_versions, 3);
    });
    await t.test('pg_dump failure never outputs success, releases holder and removes only its incomplete bundle', async () => {
      const initial = (await readdir(backups)).sort(), before = await sourceIdentity(); const f = await fault('fail'); const r = await f.pending;
      assert.notEqual(r.code, 0); assert.match(r.err, /dump failed/); assert.doesNotMatch(r.out, /BACKUP_CREATED/);
      assert.deepEqual((await readdir(backups)).sort(), initial); assert.equal(await sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='cost-engine-operational-backup'"), '0');
      assert.deepEqual(await sourceIdentity(), before);
    });
    await t.test('snapshot connection loss during dump fails closed and cleans only the current attempt', async () => {
      const initial = (await readdir(backups)).sort(); const f = await fault('connection');
      try {
        await until(() => stat(f.marker).then(() => true, () => false), Boolean, 'connection-loss dump barrier');
        assert.equal(await sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='cost-engine-operational-backup'"), 't');
        await writeFile(f.release, 'release'); const r = await f.pending; assert.notEqual(r.code, 0); assert.doesNotMatch(r.out, /BACKUP_CREATED/);
        assert.deepEqual((await readdir(backups)).sort(), initial);
      } finally { await writeFile(f.release, 'release'); await f.pending; }
    });
    await t.test('lost snapshot holder after successful pg_dump still withholds success and removes the unconfirmed archive', async () => {
      const initial = (await readdir(backups)).sort(), f = await fault('connection-after-dump');
      try {
        await until(() => stat(f.marker).then(() => true, () => false), Boolean, 'successful dump / holder-release barrier');
        assert.equal(await sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='cost-engine-operational-backup'"), 't');
        await writeFile(f.release, 'release'); const r = await f.pending; assert.notEqual(r.code, 0); assert.match(r.err, /Snapshot transaction lost/);
        assert.doesNotMatch(r.out, /BACKUP_CREATED/); assert.deepEqual((await readdir(backups)).sort(), initial);
      } finally { await writeFile(f.release, 'release'); await f.pending; }
    });
    const damaged = async (label: string, bytes: Buffer, rehash = false) => {
      const identity = 'cost-engine-live-backup-' + label + '-' + randomBytes(6).toString('hex'), dir = join(backups, identity); await mkdir(dir);
      const m = { ...manifest, identity, ...(rehash ? { sizeBytes: String(bytes.length), sha256: digest(bytes) } : {}) };
      await writeFile(join(dir, 'backup.dump'), bytes); await writeFile(join(dir, 'manifest.json'), JSON.stringify(m)); return join(dir, 'backup.dump');
    };
    await t.test('modified/truncated archives refuse restore before creating resources', async () => {
      const initial = await resources(), bytes = await readFile(archive), changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
      for (const file of [await damaged('changed', changed), await damaged('truncated', bytes.subarray(0, 256))]) await script('verify-backup-live', ['--backup-file', posix(file)], false);
      assert.deepEqual(await resources(), initial);
    });
    await t.test('rehashed malformed dump must actually fail pg_restore and remove all owned resources', async () => {
      const initial = await resources(), file = await damaged('rehashed', (await readFile(archive)).subarray(0, 256), true);
      const r = await script('verify-backup-live', ['--backup-file', posix(file)], false); assert.match(r.err, /Actual PostgreSQL restore failed/); assert.deepEqual(await resources(), initial);
    });
    await t.test('forged data evidence cannot pass on pg_restore exit code alone', async () => {
      const initial = await resources(), file = await damaged('mismatch', await readFile(archive), true), path = join(dirname(file), 'manifest.json');
      const m = JSON.parse(await readFile(path, 'utf8')); m.snapshot.dataSha256 = '0'.repeat(64); await writeFile(path, JSON.stringify(m));
      const r = await script('verify-backup-live', ['--backup-file', posix(file)], false); assert.match(r.err, /does not match backup evidence/); assert.deepEqual(await resources(), initial);
    });
    await t.test('no arbitrary restore target and no cross-use of first-deployment manifests', async () => {
      for (const args of [[], ['--backup-file', posix(archive), '--database-url', url], ['--backup-file', posix(archive), '--target', 'production']]) await script('verify-backup-live', args, false);
      await script('verify-backup', ['--backup-file', posix(archive)], false); await script('backup', target, false);
      assert.equal((await inspect('backend')).State.Running, true); assert.equal(await inspect('web'), null);
    });
    await t.test('restore succeeds with source database stopped and never starts/restarts Backend or reconstructs fake state', async () => {
      const backend = await inspect('backend'), initial = await resources(); await compose('stop', 'database');
      try { const r = JSON.parse((await script('verify-backup-live', ['--backup-file', posix(archive)])).out); assert.equal(r.result, 'RESTORE_VERIFIED'); }
      finally { await compose('up', '-d', '--no-deps', '--wait', 'database'); }
      const after = await inspect('backend'); assert.equal(after.Id, backend.Id); assert.equal(after.State.StartedAt, backend.State.StartedAt);
      assert.deepEqual(await resources(), initial); assert.equal(await sql('SELECT state FROM demo_admission_control'), 'WORKFLOW_OPEN');
    });
  } finally {
    const holders = (await docker(['ps', '--all', '--filter', 'label=cost-engine.backup.purpose=demo05d3a', '--filter', 'label=com.docker.compose.project=' + id, '--format', '{{.ID}}'])).out.trim();
    assert.equal(holders, '', 'All snapshot holders must be released');
    if (initialized) { const cfg = JSON.parse((await compose('--profile', 'operations', '--profile', 'public-web', 'config', '--format', 'json')).out); assert.equal(cfg.name, id); await compose('--profile', 'operations', '--profile', 'public-web', 'down', '--volumes', '--remove-orphans'); }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith(id + '-')); await rm(directory, { recursive: true, force: true });
    console.info('DEMO05D3A_DOCKER_TEARDOWN', JSON.stringify({ project: id, removed: true, production: false }));
  }
});
