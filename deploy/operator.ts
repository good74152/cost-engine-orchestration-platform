import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadDeploymentSecrets, publicDemoConfig } from '../src/deployment/public-demo-config.js';

async function main() {
  loadDeploymentSecrets();
  if (!publicDemoConfig()) throw new Error('Explicit public Demo profile required');
  const operation = process.argv[2];
  if (operation === 'migrate-up') {
    const result = spawnSync('npm', ['run', 'migrate', '--', 'up'], { env: process.env, stdio: 'pipe' });
    // Migration output may include SQL/data. Do not emit it into shared logs.
    if (result.status !== 0) throw new Error('Migration failed; inspect database using private operator tooling');
    console.info('Migrations applied');
  } else if (operation === 'seed') {
    // An explicit seed target is mandatory, even though the mounted target can be the same file.
    const file = process.env.DEMO_SEED_DATABASE_URL_FILE;
    if (!file || process.env.DEMO_SEED_DATABASE_URL) throw new Error('Explicit seed file required');
    process.env.DEMO_SEED_DATABASE_URL = readFileSync(file, 'utf8').trim();
    const { runDemoSeed } = await import('../scripts/seed-demo-guided-configuration.js');
    await runDemoSeed();
  } else throw new Error('Choose migrate-up or seed; automatic down is unsupported');
}
main().catch(() => { console.error('Demo operator operation failed; verify explicit target and compatibility privately'); process.exitCode = 1; });
