import 'dotenv/config';
import Fastify from 'fastify';
import { pool } from './db/pool.js';
import {
  calculationJobRoutes,
  failCalculationJobRoutes,
  publishCalculationJobRoutes,
  rejectCalculationJobRoutes,
  startCalculationJobRoutes,
  submitCalculationForValidationRoutes,
} from './modules/calculation-job.route.js';
import {
  ActiveCalculationJobExistsError,
  CalculationJobNotFoundError,
  CalculationJobNotStartableError,
  CalculationJobStateConflictError,
} from './modules/calculation-job.errors.js';
import { ActiveRawIngestionBatchExistsError } from './modules/raw-ingestion/raw-ingestion.errors.js';
import { rawIngestionRoutes } from './modules/raw-ingestion/raw-ingestion.route.js';

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ActiveCalculationJobExistsError) {
      return reply.status(409).send({
        message: error.message,
        code: error.code,
      });
    }

    if (error instanceof CalculationJobNotFoundError) {
      return reply.status(404).send({
        message: error.message,
        code: error.code,
      });
    }

    if (error instanceof CalculationJobNotStartableError) {
      return reply.status(409).send({
        message: error.message,
        code: error.code,
      });
    }

    if (error instanceof CalculationJobStateConflictError) {
      return reply.code(409).send({
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

    request.log.error(error);

    return reply.status(500).send({
      message: error instanceof Error ? error.message : 'Internal Server Error',
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

  await app.register(calculationJobRoutes);
  await app.register(startCalculationJobRoutes);
  await app.register(submitCalculationForValidationRoutes);
  await app.register(publishCalculationJobRoutes);
  await app.register(rejectCalculationJobRoutes);
  await app.register(failCalculationJobRoutes);
  await app.register(rawIngestionRoutes);

  return app;
}
