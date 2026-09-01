import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../src/db/pool.js';
import { rawIngestionRoutes } from '../src/modules/raw-ingestion/raw-ingestion.route.js';

test('POST /raw-ingestion-batches: 20 concurrent requests should yield 1 success and 19 conflicts', async (t) => {
  const app = Fastify();

  await app.register(rawIngestionRoutes);

  t.after(async () => {
    await app.close();
  });

  const payload = {
    domain: 'DPR_RAW' as const,
    businessKey: `FAB12:2026Q3:CONCURRENCY_TEST:${crypto.randomUUID()}`,
  };

  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      app.inject({
        method: 'POST',
        url: '/raw-ingestion-batches',
        payload,
      })
    )
  );

  const fulfilledResults = results.filter((result) => result.status === 'fulfilled');
  assert.equal(fulfilledResults.length, 20, 'all requests should resolve as HTTP responses');

  const responses = fulfilledResults.map((result) => result.value);
  const successResponses = responses.filter((response) => response.statusCode === 201);
  const conflictResponses = responses.filter((response) => response.statusCode === 409);

  assert.equal(successResponses.length, 1, 'only the first request should succeed');
  assert.equal(conflictResponses.length, 19, 'remaining requests should be rejected with conflict');

  const successBody = successResponses[0].json();
  assert.equal(typeof successBody.batchId, 'string');
  assert.equal(typeof successBody.ingestionSeriesId, 'string');
  assert.equal(typeof successBody.batchSequence, 'number');
  assert.equal(successBody.status, 'LOADING');

  conflictResponses.forEach((response) => {
    const body = response.json();
    assert.equal(response.statusCode, 409);
    assert.equal(body.code, 'ACTIVE_RAW_INGESTION_BATCH_EXISTS');
    assert.equal(body.message, 'An active raw ingestion batch already exists');
  });

  const row = await pool.query<{ last_batch_sequence: number }>(
    `SELECT last_batch_sequence
     FROM raw_ingestion_series
     WHERE domain = $1 AND business_key = $2`,
    [payload.domain, payload.businessKey],
  );

  assert.equal(row.rows.length, 1, 'exactly one series should exist for this key');
  assert.equal(row.rows[0].last_batch_sequence, 1, 'sequence should stay at 1 after the single success');
});
