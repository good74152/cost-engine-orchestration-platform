import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

export const admissionMigrationPattern = '1793(?:300000000_demo-admission-control|400000000_demo-workflow-admission).*';

/** Historical migration tests keep their original migration inventory/down target.
 * Install the current admission prerequisite using a separate fixture ledger.
 * Only for independently owned test DBs; never application startup or deployment.
 */
export async function installHistoricalAdmissionFixture(databaseUrl: string): Promise<void> {
  const name = new URL(databaseUrl).pathname.slice(1);
  if (!/^(demo_01a_test_|demo_02[b-e]_test_|naming_01_test_)/.test(name)) throw new Error('Historical admission fixture requires an owned test database');
  await runner({ databaseUrl, dir: fileURLToPath(new URL('../../migrations/', import.meta.url)),
    ignorePattern: `^(?!${admissionMigrationPattern}).*`, migrationsTable: 'demo_admission_fixture_migrations',
    direction: 'up', singleTransaction: true, checkOrder: true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
}
