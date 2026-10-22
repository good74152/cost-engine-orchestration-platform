import 'dotenv/config';
import Fastify, { errorCodes } from 'fastify';
import { pool } from './db/pool.js';
import type { CalculationExecutor } from './executors/calculation-executor.js';
import { FakeExecutor } from './executors/fake-executor.js';
import { isApprovedFakeExecutorEnvironment } from './executors/executor-factory.js';
import { CalculationJobError } from './modules/calculation-job.errors.js';
import { calculationJobRoutes } from './modules/calculation-job.route.js';
import { DatasetVersionError } from './modules/dataset-version/dataset-version.errors.js';
import { datasetVersionRoutes } from './modules/dataset-version/dataset-version.route.js';
import { executorCallbackRoutes } from './modules/executor-callback.route.js';
import { fakeExecutorControlRoutes } from './modules/fake-executor-control.route.js';
import { ActiveRawIngestionBatchExistsError } from './modules/raw-ingestion/raw-ingestion.errors.js';
import { rawIngestionRoutes } from './modules/raw-ingestion/raw-ingestion.route.js';
import { DemoSessionService } from './modules/demo-session/demo-session.service.js';
import { demoSessionRoutes, type DemoSessionRouteOptions } from './modules/demo-session/demo-session.route.js';

export interface BuildAppOptions {
  logger?: boolean;
  calculationExecutor?: CalculationExecutor;
  nodeEnvironment?: string;
  demoSession?: DemoSessionRouteOptions;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: options.logger === false ? false : {
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    // Fastify v5 passes param limits via routerOptions. Otherwise its default
    // 100-character cap returns 404 before UUID validation can reject the input.
    routerOptions: { maxParamLength: 1024 },
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof CalculationJobError) {
      return reply.status(error.statusCode).send({
        message: error.message,
        code: error.code,
      });
    }

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

    // Recognize concrete Fastify parser failures instead of trusting an
    // arbitrary application's statusCode as a framework client error.
    if (error instanceof errorCodes.FST_ERR_CTP_BODY_TOO_LARGE) {
      return reply.status(413).send({
        message: 'Invalid request',
        code: 'INVALID_REQUEST',
      });
    }

    if (error instanceof errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE) {
      return reply.status(415).send({
        message: 'Invalid request',
        code: 'INVALID_REQUEST',
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
  await app.register(demoSessionRoutes(new DemoSessionService(pool), {
    nodeEnvironment: options.nodeEnvironment, ...options.demoSession,
  }));
  if (options.calculationExecutor) {
    await app.register(calculationJobRoutes(options.calculationExecutor));
    await app.register(executorCallbackRoutes(options.calculationExecutor));
    if (
      options.calculationExecutor instanceof FakeExecutor
      && isApprovedFakeExecutorEnvironment(options.nodeEnvironment)
    ) {
      await app.register(fakeExecutorControlRoutes(options.calculationExecutor));
    }
  }

  return app;
}
