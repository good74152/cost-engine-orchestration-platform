import 'dotenv/config';
import { resolveAppMode } from './app-mode.js';
import { loadDeploymentSecrets, publicDemoConfig } from './deployment/public-demo-config.js';
import { DemoMaintenance } from './deployment/demo-maintenance.js';
import { verifyDemoDatabase } from './deployment/verify-database.js';

async function main(): Promise<void> {
  // Validate before importing the module that constructs the PostgreSQL pool.
  loadDeploymentSecrets();
  const profile = publicDemoConfig();
  const appMode = resolveAppMode();
  const { pool } = await import('./db/pool.js');
  pool.on('error', () => { console.error('application_database_connection_failed'); });
  let phase = 'database';
  let ready = false;
  try {
    if (profile) await verifyDemoDatabase(pool);
    phase = 'runtime';
    const [{ buildApp }, { DemoRuntime }, { createConfiguredCalculationExecutor }] = await Promise.all([
      import('./app.js'), import('./modules/demo-session/demo-runtime.js'), import('./executors/executor-factory.js'),
    ]);
    const demoRuntime = appMode === 'demo' ? new DemoRuntime(pool) : undefined;
    const app = await buildApp({ appMode, demoRuntime, readiness: () => ready,
      calculationExecutor: appMode === 'core' ? createConfiguredCalculationExecutor() : undefined });
    phase = 'invalidation';
    await demoRuntime?.reset.startServer();
    const maintenance = profile && demoRuntime ? new DemoMaintenance(demoRuntime, profile.maintenanceBatch,
      event => app.log.info({ event, version: profile.version })) : undefined;
    phase = 'listen';
    await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
    ready = true;
    maintenance?.start(profile!.maintenanceIntervalMs);
    app.log.info({ event: 'application_ready', version: profile?.version ?? 'local' });
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true; ready = false;
      app.log.info({ event: 'application_draining' });
      const draining = app.close(); // stop new admission, drain admitted HTTP work
      await maintenance?.stop();
      await draining;
      await pool.end();
    };
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
      void stop().catch(() => { console.error('application_shutdown_failed'); process.exitCode = 1; });
    });
  } catch {
    console.error(JSON.stringify({ event: 'application_startup_failed', phase, version: profile?.version ?? 'local',
      message: phase === 'invalidation' ? 'Demo startup session invalidation failed' : 'Application startup failed' }));
    await pool.end();
    process.exitCode = 1;
  }
}

main().catch(() => { console.error('application_environment_invalid: verify APP_MODE and production Demo configuration'); process.exitCode = 1; });
