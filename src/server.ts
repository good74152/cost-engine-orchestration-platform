import 'dotenv/config';
import { buildApp } from './app.js';
import { createConfiguredCalculationExecutor } from './executors/executor-factory.js';
import { resolveAppMode } from './app-mode.js';

const appMode = resolveAppMode();
const app = await buildApp({
  appMode,
  calculationExecutor: appMode === 'core' ? createConfiguredCalculationExecutor() : undefined,
});
const port = Number(process.env.PORT ?? 3000);

await app.listen({
  port,
  host: '0.0.0.0',
});
