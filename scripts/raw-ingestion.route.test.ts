import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { rawIngestionRoutes } from '../src/modules/raw-ingestion/raw-ingestion.route.js';

test('POST /raw-ingestion-batches with fixed body: 20 concurrent requests', async (t) => {
  const app = Fastify();

  await app.register(rawIngestionRoutes);

  t.after(async () => {
    await app.close();
  });

  const payload = {
    domain: 'DPR_RAW' as const,
    businessKey: 'FAB12:2026Q3:CONCURRENCY_TEST',
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
  const conflictResponses = responses.filter((response) => response.statusCode === 500);

  assert.equal(successResponses.length, 1, 'only the first request should succeed');
  assert.equal(conflictResponses.length, 19, 'remaining requests should hit duplicate active batch rule');

  const successBody = successResponses[0].json();
  assert.equal(typeof successBody.batchId, 'string');
  assert.equal(typeof successBody.ingestionSeriesId, 'string');
  assert.equal(typeof successBody.batchSequence, 'number');
  assert.equal(successBody.status, 'LOADING');

  conflictResponses.forEach((response) => {
    const body = response.json();
    assert.equal(response.statusCode, 500);
    assert.equal(body.code, 'ACTIVE_RAW_INGESTION_BATCH_EXISTS');
    assert.equal(body.message, 'An active raw ingestion batch already exists');
  });
});
