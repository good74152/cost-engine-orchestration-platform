import 'dotenv/config';
import { buildApp } from './app.js';
import { createConfiguredCalculationExecutor } from './executors/executor-factory.js';
import { resolveAppMode } from './app-mode.js';
import { pool } from './db/pool.js';
import { DemoRuntime } from './modules/demo-session/demo-runtime.js';

const appMode = resolveAppMode();
const demoRuntime = appMode === 'demo' ? new DemoRuntime(pool) : undefined;
const app = await buildApp({
  appMode,
  demoRuntime,
  calculationExecutor: appMode === 'core' ? createConfiguredCalculationExecutor() : undefined,
});
const port = Number(process.env.PORT ?? 3000);

// Real process lifecycle only; repeated buildApp calls never revoke sessions.
await demoRuntime?.reset.startServer();
await app.listen({
  port,
  host: '0.0.0.0',
});
