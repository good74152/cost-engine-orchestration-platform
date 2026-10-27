import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import test from 'node:test';

async function command(args: string[], input?: Buffer, allowFailure = false): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((done, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] }); const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk)); child.once('error', reject);
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.once('close', code => {
      const result = { code: code ?? -1, out: Buffer.concat(out), err: Buffer.concat(err).toString() };
      if (code !== 0 && !allowFailure) reject(new Error(`Docker operation failed (${code}): ${result.err.slice(-3500)}`));
      else done(result);
    });
  });
}
async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())); return address.port;
}

test('Demo-04 isolated Compose, HTTPS, production UI and PostgreSQL operations', { timeout: 1200000 }, async t => {
  const id = `demo04_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`; assert.match(id, /^demo04_test_[a-f0-9]+$/);
  const directory = await mkdtemp(join(tmpdir(), id + '-')); const secrets = join(directory, 'secrets');
  const { mkdir } = await import('node:fs/promises'); await mkdir(secrets, { mode: 0o700 });
  const port = await freePort(); const origin = `https://localhost:${port}`;
  const password = randomBytes(24).toString('hex'); const proxy = randomBytes(32).toString('hex');
  const databaseUrl = `postgres://demo_owner:${password}@database:5432/cost_engine_demo`;
  for (const [name, value] of Object.entries({ postgres_password: password, database_url: databaseUrl, proxy_secret: proxy })) {
    // Private parent directory; Docker binds individual readable files to non-root Node.
    await writeFile(join(secrets, name), value, { mode: 0o644 });
  }
  const envFile = join(directory, 'compose.env');
  await writeFile(envFile, `DEPLOYMENT_VERSION=${id}\nDEMO_PUBLIC_ORIGIN=${origin}\nACME_EMAIL=local-test@example.invalid\nDEMO_SECRETS_DIR=${JSON.stringify(secrets.replaceAll('\\', '/'))}\nDEMO_CREATES_PER_MINUTE=100\n`);
  const override = join(directory, 'override.yaml');
  await writeFile(override, `services:\n  backend:\n    container_name: ${id}-backend\n  web:\n    environment:\n      DEMO_TLS_DIRECTIVE: tls internal\n    ports: !override\n      - "127.0.0.1:${port}:${port}"\n`);
  const base = ['compose', '--project-name', id, '--env-file', envFile, '-f', resolve('deploy/compose.yaml'), '-f', override];
  const compose = (...args: string[]) => command([...base, ...args]);
  const sql = async (query: string, database = 'cost_engine_demo') => (await compose('exec', '-T', 'database', 'psql', '-U', 'demo_owner', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', query)).out.toString().trim();
  let initialized = false; let ca: Buffer;
  const https = (path: string, method = 'GET', cookie?: string, body?: unknown, extra: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((done, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(origin + path, { ca, family: 4, method, headers: { ...(cookie ? { cookie } : {}),
        ...(payload ? { origin, 'content-type': 'application/json', 'x-demo-session': '1', 'content-length': String(Buffer.byteLength(payload)) } : {}), ...extra } }, res => {
        const chunks: Buffer[] = []; res.on('data', c => chunks.push(c));
        res.on('end', () => done({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      }); req.on('error', reject); req.end(payload);
    });
  try {
    await t.test('Compose validates internal-only DB/backend, PG18 layout, secrets and one backend identity', async () => {
      const config = JSON.parse((await compose('config', '--format', 'json')).out.toString());
      assert.equal(config.services.database.image, 'postgres:18');
      assert.equal(config.services.database.volumes[0].target, '/var/lib/postgresql');
      assert.equal(config.services.database.ports, undefined); assert.equal(config.services.backend.ports, undefined);
      assert.equal(config.services.backend.read_only, true); assert.equal(config.services.backend.container_name, `${id}-backend`);
      assert.equal(config.networks.database.internal, true); assert.equal(config.networks.proxy.internal, true);
      assert.equal(config.services.backend.environment.NODE_ENV, 'production');
      assert.equal(config.services.backend.environment.DATABASE_URL, undefined);
      const missingEnv = join(directory, 'missing.env');
      await writeFile(missingEnv, 'DEPLOYMENT_VERSION=\nDEMO_PUBLIC_ORIGIN=\n');
      const missing = await command(['compose', '--env-file', missingEnv, '-f', resolve('deploy/compose.yaml'), 'config', '--quiet'], undefined, true);
      assert.notEqual(missing.code, 0);
      const text = await readFile('deploy/compose.yaml', 'utf8');
      assert.match(text, /DEPLOYMENT_VERSION:\?Set/); assert.match(text, /DEMO_SECRETS_DIR:\?Set/);
    });
    await t.test('production backend/operator/frontend/Caddy Docker builds', async () => {
      console.info('DEMO04_DOCKER_BUILD_STARTED');
      const build = await compose('--profile', 'operations', 'build', 'backend', 'operator', 'web');
      await writeFile(join(directory, 'build.log'), build.err + build.out.toString());
      console.info('DEMO04_DOCKER_BUILD_COMPLETED');
    });
    await t.test('operator shell scripts parse without executing deployment operations', async () => {
      await command(['run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh', '--mount',
        `type=bind,source=${resolve('deploy/scripts')},target=/operator-scripts,readonly`,
        `cost-engine-demo-web:${id}`, '-c', 'for script in /operator-scripts/*.sh; do sh -n "$script" || exit; done']);
    });
    initialized = true; await compose('up', '-d', '--wait', 'database');
    await t.test('startup without migrations/seed fails closed; explicit offline operations are idempotent', async () => {
      for (const invalid of ['DEMO_PROXY_SECRET_FILE=/run/secrets/missing', 'DEMO_PUBLIC_ORIGIN=http://localhost']) {
        const failed = await command([...base, 'run', '--rm', '--no-deps', '-e', invalid, 'backend'], undefined, true);
        assert.equal(failed.code, 1); assert.match(failed.err + failed.out.toString(), /application_environment_invalid/);
      }
      const before = await command([...base, 'run', '--rm', '--no-deps', 'backend'], undefined, true); assert.equal(before.code, 1);
      assert.match(before.err + before.out.toString(), /application_startup_failed/);
      await compose('--profile', 'operations', 'run', '--rm', 'operator', 'migrate-up');
      const unseeded = await command([...base, 'run', '--rm', '--no-deps', 'backend'], undefined, true); assert.equal(unseeded.code, 1);
      for (let n = 0; n < 2; n++) await compose('--profile', 'operations', 'run', '--rm', 'operator', 'seed');
      assert.equal(await sql('SELECT count(*) FROM pgmigrations'), '11');
    });
    await compose('up', '-d', '--wait', 'backend', 'web');
    const webId = (await compose('ps', '-q', 'web')).out.toString().trim();
    const caFile = join(directory, 'root.crt'); await command(['cp', `${webId}:/data/caddy/pki/authorities/local/root.crt`, caFile]); ca = await readFile(caFile);
    await t.test('real locally trusted TLS, readiness, static CSP/assets and SPA history refresh', async () => {
      const health = await https('/health/ready'); assert.equal(health.status, 200, health.body); assert.equal(JSON.parse(health.body).status, 'ready');
      for (const path of ['/', '/guided', '/datasets', '/exploration', '/about']) {
        const r = await https(path); assert.equal(r.status, 200); assert.match(r.body, /<div id="root">/);
        assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/); assert.equal(r.headers['cache-control'], 'no-cache');
      }
      const html = await https('/'); const script = html.body.match(/src="(\/assets\/[^" ]+\.js)"/); assert.ok(script);
      const asset = await https(script[1]!); assert.equal(asset.status, 200); assert.match(String(asset.headers['cache-control']), /immutable/);
      for (const secret of [password, proxy, databaseUrl]) assert.ok(!asset.body.includes(secret));
      for (const path of ['/dataset-versions', '/raw-ingestion-batches', '/internal/fake-executor/x', '/executor-callbacks/airflow', '/debug', '/seed']) {
        assert.equal((await https(path, 'POST', undefined, {})).status, 404, path);
      }
      const blocked = await https('/demo/sessions', 'POST', undefined, {}, { origin: 'https://evil.invalid', 'x-forwarded-for': '192.0.2.9' }); assert.equal(blocked.status, 403);
    });
    let persistentId = ''; let oldCookie = '';
    await t.test('HTTPS session, all guided steps, publish and Reset; UNKNOWN recovers 202 to 200', async () => {
      for (const type of ['HAPPY_PATH', 'FAILURE_RETRY', 'LOST_RESPONSE_RECOVERY']) {
        const r = await https('/demo/sessions', 'POST', undefined, {}, { 'x-demo-proxy-key': 'spoofed', 'x-demo-client-ip': 'spoofed' });
        assert.equal(r.status, 201, r.body); const cookie = r.headers['set-cookie']![0]!.split(';')[0]!;
        assert.match(r.headers['set-cookie']![0]!, /Secure/); assert.match(cookie, /^__Host-/);
        const sc = await https('/demo/scenarios', 'POST', cookie, { scenarioType: type }); assert.equal(sc.status, 201, sc.body);
        const scenarioId = JSON.parse(sc.body).scenarioId;
        for (let n = 1; n <= (type === 'FAILURE_RETRY' ? 9 : 6); n++) {
          const payload = { expectedStep: n, requestId: randomUUID() }; const path = `/demo/scenarios/${scenarioId}/next`;
          let step = await https(path, 'POST', cookie, payload);
          if (type === 'LOST_RESPONSE_RECOVERY' && n === 2) { assert.equal(step.status, 202, step.body); step = await https(path, 'POST', cookie, payload); }
          assert.equal(step.status, 200, step.body);
        }
        const dto = JSON.parse(r.body); assert.equal(await sql(`SELECT v.status FROM dataset_versions v JOIN dataset_series s ON s.id=v.dataset_series_id WHERE s.company_code='${dto.companyCode}'`), 'PUBLISHED');
        assert.equal((await https('/demo/sessions/reset', 'POST', cookie, {})).status, 204);
      }
      const r = await https('/demo/sessions', 'POST', undefined, {}); assert.equal(r.status, 201);
      oldCookie = r.headers['set-cookie']![0]!.split(';')[0]!; persistentId = JSON.parse(r.body).sessionId;
      assert.equal((await https('/demo/dataset-versions', 'POST', oldCookie, { domain: 'CAPEX', fiscalYear: 2026, period: 'Q4' })).status, 201);
    });
    await t.test('actual Chromium production UI works with CSP, host cookie and same-origin API', async () => {
      const require = createRequire(resolve('frontend/package.json'));
      const { chromium } = require('playwright') as typeof import('../frontend/node_modules/playwright/index.js');
      const browser = await chromium.launch({ headless: true });
      try {
        // Node TLS requests above validate the isolated CA. Chromium trusts only this test context.
        const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage(); const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/guided');
        const started = page.waitForResponse(r => new URL(r.url()).pathname === '/demo/sessions' && r.request().method() === 'POST');
        await page.getByRole('button', { name: 'Start demo session', exact: true }).click();
        const created = await started; assert.equal(created.status(), 201);
        await page.locator('.session-card').getByText((await created.json()).companyCode, { exact: true }).waitFor();
        await page.goto(origin + '/guided');
        await page.getByRole('button', { name: 'Start Happy Path', exact: true }).click();
        for (const action of ['Create dataset', 'Run calculation', 'Simulate success', 'Reconcile execution', 'Submit validation', 'Publish dataset']) {
          await page.getByRole('button', { name: action, exact: true }).click();
        }
        await page.getByText('Dataset published.', { exact: true }).waitFor();
        const cookies = await context.cookies(); const cookie = cookies.find(c => c.name === '__Host-ce_demo_session'); assert.ok(cookie?.secure && cookie.httpOnly);
        await page.reload(); await page.getByText('Dataset published.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Reset session', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm reset', exact: true }).click();
        await page.getByRole('button', { name: 'Start demo session', exact: true }).waitFor(); assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
    await t.test('database volume survives PostgreSQL container recreation', async () => {
      const count = await sql('SELECT count(*) FROM dataset_versions');
      await compose('up', '-d', '--force-recreate', '--wait', 'database');
      assert.equal(await sql('SELECT count(*) FROM dataset_versions'), count);
      assert.equal(await sql(`SELECT count(*) FROM demo_sessions WHERE id='${persistentId}'`), '1');
    });
    await t.test('custom-format backup restores to a separate disposable database', async () => {
      const dump = await compose('exec', '-T', 'database', 'pg_dump', '-U', 'demo_owner', '-d', 'cost_engine_demo', '-Fc');
      assert.equal(dump.out.subarray(0, 5).toString(), 'PGDMP');
      await compose('exec', '-T', 'database', 'createdb', '-U', 'demo_owner', 'restore_validation');
      try {
        await command([...base, 'exec', '-T', 'database', 'pg_restore', '-U', 'demo_owner', '-d', 'restore_validation', '--exit-on-error', '--no-owner'], dump.out);
        for (const table of ['pgmigrations', 'dataset_series', 'dataset_versions', 'calculation_jobs', 'demo_sessions']) {
          assert.equal(await sql(`SELECT count(*) FROM ${table}`, 'restore_validation'), await sql(`SELECT count(*) FROM ${table}`));
        }
      } finally { await compose('exec', '-T', 'database', 'dropdb', '-U', 'demo_owner', 'restore_validation'); }
    });
    await t.test('backend restart invalidates sessions; fixed identity rejects a second replica', async () => {
      const scaled = await command([...base, 'up', '-d', '--scale', 'backend=2', 'backend'], undefined, true); assert.notEqual(scaled.code, 0);
      const otherProject = [...base]; otherProject[2] = id + '_other';
      try {
        const overlap = await command([...otherProject, 'up', '-d', '--no-deps', 'backend'], undefined, true); assert.notEqual(overlap.code, 0);
      } finally { await command([...otherProject, 'down', '--volumes']); }
      await compose('restart', 'backend'); await compose('up', '-d', '--wait', 'backend');
      assert.equal((await https('/demo/sessions/current', 'GET', oldCookie)).status, 401);
      assert.equal((await https('/health/ready')).status, 200);
      const logs = (await compose('logs', '--no-color', 'backend')).out.toString();
      for (const secret of [password, proxy, oldCookie, databaseUrl]) assert.ok(!logs.includes(secret), 'No credentials in process logs');
      assert.match(logs, /application_draining/); assert.match(logs, /application_ready/);
    });
    console.info('DEMO04_CONTAINER_VERIFIED', JSON.stringify({ localHttps: true, publicVps: false, migrations: 11, volumePersistence: true, restore: true }));
  } finally {
    // Only the randomly named, explicitly owned disposable project/volumes.
    assert.match(id, /^demo04_test_[a-f0-9]+$/);
    if (initialized) {
      const config = JSON.parse((await compose('config', '--format', 'json')).out.toString());
      assert.equal(config.name, id);
      await compose('down', '--volumes', '--remove-orphans');
      for (const project of [id, id + '_other']) {
        const volumes = await command(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']);
        assert.equal(volumes.out.toString().trim(), '', 'No owned disposable volumes remain');
      }
    }
    // Never retain temporary credentials; test-runner output records stage failures.
    console.info('DEMO04_CONTAINER_TEARDOWN', JSON.stringify({ project: id, disposableVolumesRemoved: initialized }));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith(id + '-'));
    await rm(directory, { recursive: true, force: true });
  }
});
