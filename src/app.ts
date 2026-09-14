import 'dotenv/config';
import Fastify from 'fastify';
import { pool } from './db/pool.js';
import { DatasetVersionError } from './modules/dataset-version/dataset-version.errors.js';
import { datasetVersionRoutes } from './modules/dataset-version/dataset-version.route.js';
import { ActiveRawIngestionBatchExistsError } from './modules/raw-ingestion/raw-ingestion.errors.js';
import { rawIngestionRoutes } from './modules/raw-ingestion/raw-ingestion.route.js';

export async function buildApp(options: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DatasetVersionError) {
      return reply.status(error.statusCode).send({
        message: error.message,
        code: error.code,
      });
    }

    if (error instanceof ActiveRawIngestionBatchExistsError) {
      return reply.code(409).send({
        message: error.message,
        code: error.code,
      });
    }

    if (
      typeof error === 'object'
      && error !== null
      && 'statusCode' in error
      && error.statusCode === 400
    ) {
      return reply.status(400).send({
        message: 'Invalid request',
        code: 'INVALID_REQUEST',
      });
    }

    request.log.error(error);

    return reply.status(500).send({
      message: 'Internal Server Error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  app.get('/health', async () => {
    const result = await pool.query<{ now: Date }>(
      'SELECT NOW() AS now',
    );

    return {
      status: 'ok',
      databaseTime: result.rows[0]?.now,
    };
  });

  await app.register(datasetVersionRoutes);
  await app.register(rawIngestionRoutes);

  return app;
}
