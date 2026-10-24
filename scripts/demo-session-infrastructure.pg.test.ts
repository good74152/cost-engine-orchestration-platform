import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { runner } from 'node-pg-migrate';
import { Client, type Pool } from 'pg';
import {
  DemoSessionService, LOCAL_SESSION_COOKIE, SECURE_SESSION_COOKIE, publicSession,
  type AuthenticatedDemoSession,
} from '../src/modules/demo-session/demo-session.service.js';
import { DemoSessionCoordinator } from '../src/modules/demo-session/demo-session.coordinator.js';
import { DemoOwnershipValidator } from '../src/modules/demo-session/demo-session.ownership.js';
import { DemoResourceUnavailableError, DemoSessionQueueFullError,
  DemoSessionUnavailableError } from '../src/modules/demo-session/demo-session.errors.js';
import { demoSessionRoutes } from '../src/modules/demo-session/demo-session.route.js';
import { FakeExecutor } from '../src/executors/fake-executor.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Disposable PostgreSQL tests require a configured database service');
function urlFor(name: string) { const url = new URL(source!); url.pathname = '/' + name; return url.toString(); }
const migrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationLogger = { debug() {}, info() {}, warn() {}, error() {} };
function barrier() {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
function expectError(response: Response, status: number, code: string) {
  assert.equal(response.statusCode, status);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
  assert.equal(body.code, code);
  assert.equal(typeof body.message, 'string');
}

test('Demo 01A: real PostgreSQL session foundation, not protected Domain APIs',
  { timeout: 120_000 }, async (t) => {
    const name = `demo_01a_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    assert.match(name, /^demo_01a_test_[a-z0-9_]+$/);
    assert.ok(name.length <= 63);
    const admin = new Client({ connectionString: urlFor('postgres') });
    const previousUrl = process.env.DATABASE_URL;
    const previousEnvironment = process.env.NODE_ENV;
    const apps: FastifyInstance[] = [];
    const clientEnds: Promise<void>[] = [];
    let db: Pool | undefined;
    let created = false;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
      const migrate = (direction: 'up' | 'down', count?: number) => runner({
        databaseUrl: urlFor(name), dir: migrationDirectory, migrationsTable: 'pgmigrations',
        direction, count, singleTransaction: true, checkOrder: true, logger: migrationLogger,
      });
      await migrate('up');
      process.env.DATABASE_URL = urlFor(name);
      process.env.NODE_ENV = 'test';
      const [{ pool }, { buildApp }, { prepareCalculationJobRunService }] = await Promise.all([
        import('../src/db/pool.js'), import('../src/app.js'),
        import('../src/modules/calculation-job-preparation.service.js'),
      ]);
      db = pool;
      pool.on('connect', (client) => {
        clientEnds.push(new Promise<void>((resolve) => client.once('end', () => resolve())));
      });
      const fake = new FakeExecutor();
      const app = await buildApp({ logger: false, calculationExecutor: fake, nodeEnvironment: 'test' });
      apps.push(app);
      const sessions = new DemoSessionService(pool);
      const post = (cookie?: string, target = app) => target.inject({
        method: 'POST', url: '/demo/sessions', payload: {},
        headers: { 'x-demo-session': '1', ...(cookie === undefined ? {} : { cookie }) },
      });
      const get = (cookie?: string, target = app) => target.inject({
        method: 'GET', url: '/demo/sessions/current',
        headers: cookie === undefined ? {} : { cookie },
      });
      function cookieFrom(response: Response): string {
        const header = response.headers['set-cookie'];
        assert.ok(typeof header === 'string', 'Expected one session cookie');
        return (header as string).split(';', 1)[0]!;
      }
      async function newSession() {
        const response = await post();
        assert.equal(response.statusCode, 201);
        const cookie = cookieFrom(response);
        return { response, cookie, context: await sessions.authenticate(cookie, LOCAL_SESSION_COOKIE) };
      }
      const count = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM demo_sessions')).rows[0].n;
      const history = async () => (await pool.query(`SELECT
        (SELECT jsonb_agg(to_jsonb(ds) ORDER BY id) FROM dataset_series ds) AS series,
        (SELECT jsonb_agg(to_jsonb(dv) ORDER BY id) FROM dataset_versions dv) AS datasets,
        (SELECT jsonb_agg(to_jsonb(cj) ORDER BY id) FROM calculation_jobs cj) AS jobs,
        (SELECT jsonb_agg(to_jsonb(ea) ORDER BY id) FROM execution_attempts ea) AS attempts,
        (SELECT jsonb_agg(to_jsonb(bs) ORDER BY id) FROM dataset_build_snapshots bs) AS snapshots`)).rows;
      console.log('DEMO_01A_RUNTIME', JSON.stringify({ node: process.version,
        postgres: (await pool.query('SHOW server_version')).rows[0].server_version,
        database: name, setup: 'template0; all checked-in migrations; owned disposable database' }));

      await t.test('fresh migration and empty down/up are reversible', async () => {
        assert.equal(await count(), 0);
        // Remove the new empty Scenario table before testing Session rollback.
        await migrate('down', 2);
        assert.equal((await pool.query("SELECT to_regclass('public.demo_sessions') AS name")).rows[0].name, null);
        await migrate('up');
        assert.equal(await count(), 0);
      });

      await t.test('creation persists only a 32-byte hash and returns exact safe DTO/cookie', async () => {
        const { response, cookie, context } = await newSession();
        const body = response.json();
        assert.deepEqual(Object.keys(body).sort(), ['companyCode', 'expiresAt', 'sessionId', 'status']);
        assert.equal(body.status, 'ACTIVE');
        assert.match(body.companyCode, /^DEMO_[0-9A-F]{15}$/);
        assert.equal(response.headers['cache-control'], 'no-store');
        const attributes = String(response.headers['set-cookie']).split(';').slice(1).join(';');
        assert.match(attributes, /HttpOnly/); assert.match(attributes, /SameSite=Strict/);
        assert.match(attributes, /Path=\//); assert.doesNotMatch(attributes, /Secure|Domain=/);
        const maxAge = Number(/Max-Age=(\d+)/.exec(attributes)?.[1]);
        assert.ok(maxAge > 0 && maxAge <= 14400);
        const token = cookie.slice(cookie.indexOf('=') + 1);
        assert.ok(/^[A-Za-z0-9_-]{43}$/.test(token), 'Canonical bearer shape');
        const row = (await pool.query('SELECT * FROM demo_sessions WHERE id=$1', [context.sessionId])).rows[0];
        assert.deepEqual(Object.keys(row).sort(), ['company_code', 'created_at', 'expires_at', 'id', 'revoked_at', 'token_hash']);
        assert.ok(row.token_hash.equals(createHash('sha256').update(Buffer.from(token, 'base64url')).digest()), 'Persist SHA-256 only');
        assert.equal(row.token_hash.length, 32);
        assert.equal(row.expires_at.getTime() - row.created_at.getTime(), 4 * 3600_000);
        assert.ok(!JSON.stringify(row).includes(token), 'Database must not contain bearer');
        assert.ok(!response.body.includes(token) && !response.body.includes(row.token_hash.toString('hex')), 'JSON must be credential free');
      });

      await t.test('refresh, POST reuse and fresh app retain identity/expiry without rotation', async () => {
        const { response, cookie } = await newSession();
        const before = await count();
        const other = await buildApp({ logger: false, nodeEnvironment: 'test' }); apps.push(other);
        for (const result of [await get(cookie), await post(cookie), await get(cookie, other), await post(cookie, other)]) {
          assert.equal(result.statusCode, 200);
          assert.deepEqual(result.json(), response.json());
          assert.equal(result.headers['set-cookie'], undefined);
          assert.equal(result.headers['cache-control'], 'no-store');
        }
        assert.equal(await count(), before);
      });

      await t.test('missing/invalid/duplicate/expired/revoked credentials return generic 401 without allocation', async () => {
        const before = await count();
        for (const cookie of [undefined, `${LOCAL_SESSION_COOKIE}=bad`,
          `${LOCAL_SESSION_COOKIE}=${randomBytes(32).toString('base64url')}`,
          `${LOCAL_SESSION_COOKIE}=${randomUUID()}`,
          `${LOCAL_SESSION_COOKIE}=${'A'.repeat(42)}B`,
          `${LOCAL_SESSION_COOKIE}=bad; ${LOCAL_SESSION_COOKIE}=bad`]) {
          expectError(await get(cookie), 401, 'DEMO_SESSION_UNAVAILABLE');
          if (cookie !== undefined) expectError(await post(cookie), 401, 'DEMO_SESSION_UNAVAILABLE');
        }
        const idOnly = await app.inject({ method: 'GET', url: '/demo/sessions/current',
          headers: { 'x-session-id': randomUUID() } });
        expectError(idOnly, 401, 'DEMO_SESSION_UNAVAILABLE');
        assert.equal(await count(), before);
      });

      await t.test('CSRF, invalid body and parser contracts do not allocate sessions', async () => {
        const before = await count();
        for (const headers of [{}, { 'x-demo-session': '1', origin: 'https://attacker.invalid' },
          { 'x-demo-session': '1', origin: 'null' }, { 'x-demo-session': '1', 'sec-fetch-site': 'cross-site' }]) {
          expectError(await app.inject({ method: 'POST', url: '/demo/sessions', payload: {}, headers }),
            403, 'DEMO_SESSION_CSRF_REJECTED');
        }
        for (const payload of [[], null, { sessionId: randomUUID() }, { companyCode: 'DEMO_fake' }]) {
          expectError(await app.inject({ method: 'POST', url: '/demo/sessions',
            headers: { 'x-demo-session': '1', 'content-type': 'application/json' }, payload: JSON.stringify(payload) }),
            400, 'INVALID_REQUEST');
        }
        expectError(await app.inject({ method: 'POST', url: '/demo/sessions',
          headers: { 'x-demo-session': '1', 'content-type': 'application/json' }, payload: '{' }), 400, 'INVALID_REQUEST');
        assert.equal(await count(), before);
        const valid = await app.inject({ method: 'POST', url: '/demo/sessions',
          headers: { 'x-demo-session': '1', origin: 'http://localhost:80' }, payload: {} });
        // Fastify inject's default Host is localhost:80.
        assert.equal(valid.statusCode, 201);
      });

      await t.test('HTTPS cookie security and environment conflict fail closed', async () => {
        const secureApp = await buildApp({ logger: false, demoSession: { secureCookies: true, origin: 'https://demo.example' } });
        apps.push(secureApp);
        const response = await secureApp.inject({ method: 'POST', url: '/demo/sessions', payload: {},
          headers: { 'x-demo-session': '1', origin: 'https://demo.example' } });
        assert.equal(response.statusCode, 201);
        const header = String(response.headers['set-cookie']);
        assert.ok(header.startsWith(SECURE_SESSION_COOKIE + '='), 'Use host-prefixed cookie');
        assert.ok(header.includes('; Secure') && header.includes('; HttpOnly'));
        assert.equal((await get(cookieFrom(response), secureApp)).statusCode, 200);
        expectError(await secureApp.inject({ method: 'POST', url: '/demo/sessions', payload: {},
          headers: { 'x-demo-session': '1', origin: 'https://other.example' } }), 403, 'DEMO_SESSION_CSRF_REJECTED');
        assert.throws(() => demoSessionRoutes(sessions, { nodeEnvironment: 'production', secureCookies: false }), /Insecure/);
        assert.throws(() => demoSessionRoutes(sessions, { origin: 'file:///unsafe' }), /origin/);
        const prior = process.env.NODE_ENV;
        try {
          process.env.NODE_ENV = 'production';
          assert.throws(() => demoSessionRoutes(sessions, { nodeEnvironment: 'test', secureCookies: false }), /Insecure/);
        } finally { process.env.NODE_ENV = prior; }
      });

      await t.test('concurrent new sessions use unique durable identities, hashes and company codes', async () => {
        const before = await count();
        const responses = await Promise.all(Array.from({ length: 20 }, () => post()));
        assert.ok(responses.every((response) => response.statusCode === 201));
        assert.equal(new Set(responses.map((r) => r.json().companyCode)).size, 20);
        assert.equal(new Set(responses.map((r) => r.json().sessionId)).size, 20);
        assert.equal(await count(), before + 20);
        const uniqueness = (await pool.query(`SELECT COUNT(*)::int AS total,
          COUNT(DISTINCT token_hash)::int AS hashes, COUNT(DISTINCT company_code)::int AS codes FROM demo_sessions`)).rows[0];
        assert.equal(uniqueness.total, uniqueness.hashes); assert.equal(uniqueness.total, uniqueness.codes);
      });

      await t.test('real unique collisions retry independently and exhaust at five candidates', async () => {
        const existing = await sessions.create();
        for (const kind of ['id', 'token', 'companyCode'] as const) {
          let calls = 0;
          const controlled = new DemoSessionService(pool, { candidate: () => {
            calls += 1;
            const candidate: { id: string; token: Buffer; companyCode: string } = { id: randomUUID(), token: randomBytes(32),
              companyCode: `DEMO_${randomBytes(8).toString('hex').slice(0, 15).toUpperCase()}` };
            if (calls === 1) {
              if (kind === 'id') candidate.id = existing.session.sessionId;
              if (kind === 'companyCode') candidate.companyCode = existing.session.companyCode;
              if (kind === 'token') candidate.token = Buffer.from(existing.token, 'base64url');
            }
            return candidate;
          } });
          await controlled.create(); assert.equal(calls, 2);
        }
        let calls = 0;
        const exhausted = new DemoSessionService(pool, { candidate: () => {
          calls += 1;
          return { id: randomUUID(), token: randomBytes(32), companyCode: existing.session.companyCode };
        } });
        const before = await count();
        await assert.rejects(exhausted.create(), /^Error: Demo session allocation exhausted$/);
        assert.equal(calls, 5); assert.equal(await count(), before);
      });

      await t.test('historical DEMO company collision skips the first candidate without claiming historical data', async () => {
        const companyCode = `DEMO_${'A'.repeat(15)}`;
        await pool.query(`INSERT INTO dataset_series
          (id,domain,company_code,fiscal_year,period,last_allocated_version)
          VALUES ($1,'CAPEX',$2,2020,'Q1',0)`, [randomUUID(), companyCode]);
        const beforeHistory = await history(); const before = await count();
        const candidates = [
          { id: randomUUID(), token: randomBytes(32), companyCode },
          { id: randomUUID(), token: randomBytes(32), companyCode: `DEMO_${'B'.repeat(15)}` },
        ];
        let calls = 0;
        const controlled = new DemoSessionService(pool, { candidate: () => candidates[calls++]! });
        const created = await controlled.create();
        assert.equal(calls, 2); assert.equal(created.session.companyCode, candidates[1]!.companyCode);
        assert.ok(created.token === candidates[1]!.token.toString('base64url'), 'Return only the accepted candidate token');
        assert.equal(await count(), before + 1);
        assert.equal((await pool.query('SELECT id FROM demo_sessions WHERE id=$1 OR company_code=$2',
          [candidates[0]!.id, companyCode])).rowCount, 0);
        assert.deepEqual(await history(), beforeHistory);
      });

      await t.test('five historical company collisions exhaust safely without cookie, session or credential details', async () => {
        const companyCode = `DEMO_${'C'.repeat(15)}`;
        await pool.query(`INSERT INTO dataset_series
          (id,domain,company_code,fiscal_year,period,last_allocated_version)
          VALUES ($1,'CAPEX',$2,2020,'Q1',0)`, [randomUUID(), companyCode]);
        const beforeHistory = await history(); const before = await count();
        const candidates: { id: string; token: Buffer; companyCode: string }[] = [];
        const controlled = new DemoSessionService(pool, { candidate: () => {
          const candidate = { id: randomUUID(), token: randomBytes(32), companyCode };
          candidates.push(candidate); return candidate;
        } });
        const log: string[] = [];
        const target = Fastify({ logger: { stream: new Writable({ write(chunk, _encoding, done) {
          log.push(String(chunk)); done();
        } }), redact: ['req.headers.cookie', 'res.headers["set-cookie"]'] } }); apps.push(target);
        await target.register(demoSessionRoutes(controlled, { nodeEnvironment: 'test' }));
        const response = await post(undefined, target);
        expectError(response, 500, 'INTERNAL_SERVER_ERROR');
        assert.equal(candidates.length, 5); assert.equal(response.headers['set-cookie'], undefined);
        assert.equal(await count(), before); assert.deepEqual(await history(), beforeHistory);
        const output = response.body + log.join('');
        assert.doesNotMatch(output, /token_hash|constraint|SELECT |INSERT |postgresql:\/\//i);
        for (const candidate of candidates) {
          assert.ok(!output.includes(candidate.token.toString('base64url')), 'No candidate token in response/log');
          assert.ok(!output.includes(createHash('sha256').update(candidate.token).digest('hex')), 'No token hash in response/log');
        }
      });

      await t.test('simultaneous sessions with the same candidate company retry through PostgreSQL uniqueness', async () => {
        const companyCode = `DEMO_${'D'.repeat(15)}`;
        const calls = [0, 0]; const before = await count(); const beforeHistory = await history();
        const creators = [0, 1].map((index) => new DemoSessionService(pool, { candidate: () => {
          calls[index] = calls[index]! + 1;
          return { id: randomUUID(), token: randomBytes(32),
            companyCode: calls[index] === 1 ? companyCode : `DEMO_${index === 0 ? 'E'.repeat(15) : 'F'.repeat(15)}` };
        } }));
        const created = await Promise.all(creators.map((creator) => creator.create()));
        assert.equal(new Set(created.map((row) => row.session.companyCode)).size, 2);
        assert.deepEqual([...calls].sort((left, right) => left - right), [1, 2]); assert.equal(await count(), before + 2);
        assert.equal((await pool.query('SELECT id FROM demo_sessions WHERE company_code=$1', [companyCode])).rowCount, 1);
        assert.deepEqual(await history(), beforeHistory);
      });

      await t.test('PostgreSQL rejects invalid hash, expiry, code, nulls and duplicate writes', async () => {
        const existing = await sessions.create();
        const query = `INSERT INTO demo_sessions (id, company_code, token_hash, created_at, expires_at)
          VALUES ($1,$2,$3,$4,$5)`;
        const now = new Date('2030-01-01T00:00:00Z');
        const later = new Date('2030-01-01T04:00:00Z');
        const goodCode = () => `DEMO_${randomBytes(8).toString('hex').slice(0, 15).toUpperCase()}`;
        for (const [values, code] of [
          [[randomUUID(), goodCode(), randomBytes(31), now, later], '23514'],
          [[randomUUID(), goodCode(), randomBytes(33), now, later], '23514'],
          [[randomUUID(), goodCode(), randomBytes(32), now, now], '23514'],
          [[randomUUID(), ' ', randomBytes(32), now, later], '23514'],
          [[randomUUID(), goodCode() + 'F', randomBytes(32), now, later], '22001'],
          [[randomUUID(), null, randomBytes(32), now, later], '23502'],
          [[randomUUID(), goodCode(), null, now, later], '23502'],
          [[null, goodCode(), randomBytes(32), now, later], '23502'],
          [[randomUUID(), goodCode(), randomBytes(32), null, later], '23502'],
          [[randomUUID(), goodCode(), randomBytes(32), now, null], '23502'],
          [[randomUUID(), existing.session.companyCode, randomBytes(32), now, later], '23505'],
          [[existing.session.sessionId, goodCode(), randomBytes(32), now, later], '23505'],
          [[randomUUID(), goodCode(), createHash('sha256').update(Buffer.from(existing.token, 'base64url')).digest(), now, later], '23505'],
        ] as const) {
          // Never let a failing assertion print PostgreSQL detail/bindings that
          // could include the credential hash. Assert only the safe SQLSTATE.
          const actual = await pool.query(query, [...values]).then(() => null,
            (error: { code?: string }) => error.code);
          assert.equal(actual, code);
        }
        const revocation = await pool.query(`UPDATE demo_sessions
          SET revoked_at=created_at-INTERVAL '1 second' WHERE id=$1`, [existing.session.sessionId])
          .then(() => null, (error: { code?: string }) => error.code);
        assert.equal(revocation, '23514');
      });

      const owned = await newSession();
      const foreign = await newSession();
      const typeId = randomUUID();
      await pool.query(`INSERT INTO calculation_types
        (id,domain,code,airflow_dag_id,is_active,last_allocated_dependency_definition_version)
        VALUES ($1,'DPR','DEMO_TEST','demo_test',true,1)`, [typeId]);
      await pool.query(`INSERT INTO execution_dependency_definition_versions
        (calculation_type_id,version,status,published_at) VALUES ($1,1,'PUBLISHED',now())`, [typeId]);
      async function fixture(context: AuthenticatedDemoSession) {
        // Existing Domain endpoint deliberately remains unchanged/unauthenticated.
        const response = await app.inject({ method: 'POST', url: '/dataset-versions', payload: {
          domain: 'DPR', companyCode: context.companyCode, fiscalYear: 2026, period: 'Q3',
        } });
        assert.equal(response.statusCode, 201);
        const body = response.json();
        const jobId = body.calculationJobs[0].jobId;
        const attempt = await prepareCalculationJobRunService(jobId);
        return { series: body.datasetSeriesId, dataset: body.datasetVersionId,
          job: jobId, attempt: attempt.executionAttemptId };
      }
      const a = await fixture(owned.context);
      const b = await fixture(foreign.context);

      await t.test('validators traverse persisted series/dataset/job/attempt ownership only', async () => {
        const validator = new DemoOwnershipValidator(pool, sessions);
        const before = await history();
        for (const kind of ['series', 'dataset', 'job', 'attempt'] as const) {
          await validator.assertOwned(owned.context, kind, a[kind]);
          await validator.assertOwned(foreign.context, kind, b[kind]);
          for (const id of [b[kind], randomUUID(), 'invalid']) {
            await assert.rejects(validator.assertOwned(owned.context, kind, id), DemoResourceUnavailableError);
          }
        }
        const forged = { ...owned.context, companyCode: foreign.context.companyCode };
        await assert.rejects(validator.assertOwned(forged, 'job', b.job), DemoSessionUnavailableError);
        assert.deepEqual(await history(), before);
        assert.notEqual(a.series, b.series);
        assert.equal(fake.getDispatchHistory().length, 0);
        assert.equal(fake.getStatusLookupHistory().length, 0);
      });

      await t.test('exact expiration boundary rejects admission and retains all orchestration history', async () => {
        let now = new Date(Date.parse(owned.context.expiresAt) - 1);
        const timed = new DemoSessionService(pool, { now: async () => now });
        const context = await timed.authenticate(owned.cookie, LOCAL_SESSION_COOKIE);
        const before = await history();
        now = new Date(owned.context.expiresAt);
        await assert.rejects(timed.authenticate(owned.cookie, LOCAL_SESSION_COOKIE), DemoSessionUnavailableError);
        const queue = new DemoSessionCoordinator(timed);
        let began = false;
        await assert.rejects(queue.run(context, async () => { began = true; }), DemoSessionUnavailableError);
        now = new Date(now.getTime() + 1);
        await assert.rejects(timed.revalidate(context), DemoSessionUnavailableError);
        assert.equal(began, false); assert.equal(queue.activeSessionCount, 0);
        assert.deepEqual(await history(), before);
        // Real route default clock also rejects a durable past-expiry fixture.
        const expired = await newSession();
        await pool.query(`UPDATE demo_sessions SET created_at=clock_timestamp()-INTERVAL '5 hours',
          expires_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=$1`, [expired.context.sessionId]);
        expectError(await get(expired.cookie), 401, 'DEMO_SESSION_UNAVAILABLE');
        expectError(await post(expired.cookie), 401, 'DEMO_SESSION_UNAVAILABLE');
      });

      await t.test('revocation is durable/idempotent across apps without changing history', async () => {
        const before = await history();
        await sessions.revoke(foreign.context.sessionId);
        const first = (await pool.query('SELECT revoked_at FROM demo_sessions WHERE id=$1', [foreign.context.sessionId])).rows;
        await sessions.revoke(foreign.context.sessionId);
        assert.deepEqual((await pool.query('SELECT revoked_at FROM demo_sessions WHERE id=$1', [foreign.context.sessionId])).rows, first);
        expectError(await get(foreign.cookie), 401, 'DEMO_SESSION_UNAVAILABLE');
        expectError(await post(foreign.cookie), 401, 'DEMO_SESSION_UNAVAILABLE');
        const fresh = await buildApp({ logger: false, nodeEnvironment: 'test' }); apps.push(fresh);
        expectError(await get(foreign.cookie, fresh), 401, 'DEMO_SESSION_UNAVAILABLE');
        await assert.rejects(new DemoOwnershipValidator(pool, sessions).assertOwned(foreign.context, 'job', b.job), DemoSessionUnavailableError);
        assert.deepEqual(await history(), before);
      });

      await t.test('same-session queue serializes and failed operation releases its successor', async () => {
        for (const fail of [false, true]) {
          const queue = new DemoSessionCoordinator(sessions);
          const entered = barrier(); const release = barrier();
          const events: string[] = [];
          const failure = new Error('test-owned operation failure');
          const first = queue.run(owned.context, async () => {
            events.push('A'); entered.release(); await release.promise;
            events.push('A finished'); if (fail) throw failure;
          });
          const firstOutcome = first.then(() => null, (error) => error);
          await entered.promise;
          const second = queue.run(owned.context, async () => { events.push('B'); });
          try {
            assert.deepEqual(events, ['A']);
            const idle = await admin.query(`SELECT pid FROM pg_stat_activity
              WHERE datname=$1 AND state='idle in transaction'`, [name]);
            assert.equal(idle.rowCount, 0, 'No transaction held in queue/body');
          } finally { release.release(); }
          assert.equal(await firstOutcome, fail ? failure : null);
          await second;
          assert.deepEqual(events, ['A', 'A finished', 'B']);
          assert.equal(queue.activeSessionCount, 0);
        }
      });

      await t.test('different sessions progress independently; queue bounds reject excess work', async () => {
        const other = await newSession();
        const queue = new DemoSessionCoordinator(sessions, 2, 2);
        const entered = barrier(); const release = barrier();
        const first = queue.run(owned.context, async () => { entered.release(); await release.promise; });
        await entered.promise;
        let queued = false;
        const second = queue.run(owned.context, async () => { queued = true; });
        try {
          await assert.rejects(queue.run(owned.context, async () => {}), DemoSessionQueueFullError);
          let independent = false;
          await queue.run(other.context, async () => { independent = true; });
          assert.equal(independent, true); assert.equal(queued, false);
        } finally { release.release(); }
        await Promise.all([first, second]);
        assert.equal(queue.activeSessionCount, 0);
        const limited = new DemoSessionCoordinator(sessions, 1, 1);
        const inBody = barrier(); const finish = barrier();
        const held = limited.run(owned.context, async () => { inBody.release(); await finish.promise; });
        await inBody.promise;
        try { await assert.rejects(limited.run(other.context, async () => {}), DemoSessionQueueFullError); }
        finally { finish.release(); }
        await held; assert.equal(limited.activeSessionCount, 0);
        assert.throws(() => new DemoSessionCoordinator(sessions, 0), /positive/);
      });

      await t.test('queued expiry/revocation denies body; admitted operation can finish', async () => {
        for (const action of ['expire', 'revoke'] as const) {
          const created = await sessions.create();
          let now = new Date(Date.parse(created.session.expiresAt) - 1);
          const timed = new DemoSessionService(pool, { now: async () => now });
          const context = await timed.authenticate(`${LOCAL_SESSION_COOKIE}=${created.token}`, LOCAL_SESSION_COOKIE);
          const queue = new DemoSessionCoordinator(timed);
          const entered = barrier(); const release = barrier();
          const first = queue.run(context, async () => { entered.release(); await release.promise; return 'finished'; });
          await entered.promise;
          let began = false;
          const second = queue.run(context, async () => { began = true; await pool.query('SELECT 1'); });
          const denied = assert.rejects(second, DemoSessionUnavailableError);
          const before = await history();
          try {
            if (action === 'expire') now = new Date(context.expiresAt);
            else await timed.revoke(context.sessionId);
          } finally { release.release(); }
          assert.equal(await first, 'finished'); await denied;
          assert.equal(began, false); assert.equal(queue.activeSessionCount, 0);
          assert.deepEqual(await history(), before);
        }
        const queue = new DemoSessionCoordinator(sessions);
        await assert.rejects(queue.run({ ...owned.context }, async () => {}), DemoSessionUnavailableError);
        assert.equal(queue.activeSessionCount, 0);
      });

      await t.test('persistence failure emits no successful cookie, credentials, or unsafe logs', async () => {
        const log: string[] = [];
        const target = Fastify({ logger: { stream: new Writable({ write(chunk, _encoding, done) {
          log.push(String(chunk)); done();
        } }), redact: ['req.headers.cookie', 'res.headers["set-cookie"]'] } });
        apps.push(target); await target.register(demoSessionRoutes(sessions, { nodeEnvironment: 'test' }));
        await pool.query(`CREATE FUNCTION demo_test_reject_insert() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'test-owned insert failure'; END $$;
          CREATE TRIGGER demo_test_reject BEFORE INSERT ON demo_sessions
          FOR EACH ROW EXECUTE FUNCTION demo_test_reject_insert()`);
        const before = await count();
        try {
          const response = await post(undefined, target);
          expectError(response, 500, 'INTERNAL_SERVER_ERROR');
          assert.equal(response.headers['set-cookie'], undefined);
          assert.equal(await count(), before);
          const bad = `${LOCAL_SESSION_COOKIE}=${randomBytes(32).toString('base64url')}`;
          expectError(await get(bad, target), 401, 'DEMO_SESSION_UNAVAILABLE');
          const text = log.join('');
          assert.ok(!text.includes(bad.slice(bad.indexOf('=') + 1)), 'No bearer in logs');
          assert.ok(!text.includes('token_hash') && !text.includes('test-owned insert failure'), 'No SQL details in logs');
        } finally {
          await pool.query('DROP TRIGGER demo_test_reject ON demo_sessions; DROP FUNCTION demo_test_reject_insert()');
        }
      });

      await t.test('populated down refuses atomically; no domain HTTP authorization was introduced', async () => {
        const before = await count();
        // Empty Scenario migration rolls back first; retained Session history
        // still rejects the complete atomic down operation.
        await assert.rejects(migrate('down', 2), /retained session history/);
        assert.equal(await count(), before);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM pgmigrations WHERE name='1792600000000_demo-sessions'")).rows[0].n, 1);
        assert.deepEqual(publicSession(owned.context), owned.response.json());
        expectError(await app.inject({ method: 'POST', url: '/dataset-versions', payload: {} }), 400, 'INVALID_REQUEST');
        assert.equal((await app.inject({ method: 'POST', url: '/demo/sessions/revoke' })).statusCode, 404);
      });
    } finally {
      try {
        await Promise.all(apps.map((app) => app.close()));
        if (db) { await db.end(); await Promise.all(clientEnds); }
      } finally {
        if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
        if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment;
        try {
          if (created) {
            const remaining = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name]);
            assert.equal(remaining.rowCount, 0, 'All owned clients must close before normal DROP');
            assert.match(name, /^demo_01a_test_[a-z0-9_]+$/);
            await admin.query(`DROP DATABASE "${name}"`);
            console.log('DEMO_01A_TEARDOWN', JSON.stringify({ database: name, sessions: 0, dropped: true, forced: false }));
          }
        } finally { await admin.end(); }
      }
    }
  });
