import 'dotenv/config';
import { buildApp } from './app.js';
import { createConfiguredCalculationExecutor } from './executors/executor-factory.js';

const app = await buildApp({
  calculationExecutor: createConfiguredCalculationExecutor(),
});
const port = Number(process.env.PORT ?? 3000);

await app.listen({
  port,
  host: '0.0.0.0',
});
