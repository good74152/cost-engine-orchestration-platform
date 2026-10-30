import { randomUUID, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { DemoSessionService } from '../../src/modules/demo-session/demo-session.service.js';

/** Disposable data only. Full six-domain, ten-job persisted graph; real API
 * behavior and the live FakeExecutor are separately exercised by Docker tests. */
export async function operationalDataFixture(db: Pool) {
  const { session } = await new DemoSessionService(db, { capacity: { active: 100, retained: 1000 } }).create();
  const client = await db.connect();
  const versions: Record<string, { series: string; version: string; jobs: string[] }> = {};
  try {
    await client.query('BEGIN');
    for (const domain of ['FAB_COST', 'CAPEX', 'DPR', 'INSURANCE', 'ONE_STD_COST', 'E2E_COST']) {
      const series = randomUUID(), version = randomUUID(), snapshot = randomUUID(); const jobs: string[] = [];
      await client.query(`INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period,last_allocated_version)
        VALUES($1,$2,$3,2026,'Q4',1)`, [series, domain, session.companyCode]);
      await client.query(`INSERT INTO dataset_versions(id,dataset_series_id,version,status,building_started_at,validating_at,published_at)
        VALUES($1,$2,1,'PUBLISHED',now(),now(),now())`, [version, series]);
      await client.query('INSERT INTO dataset_build_snapshots(id,dataset_version_id) VALUES($1,$2)', [snapshot, version]);
      const types = (await client.query<{ id: string; airflow_dag_id: string; definition: string }>(`SELECT t.id,t.airflow_dag_id,d.id AS definition FROM calculation_types t
        JOIN execution_dependency_definition_versions d ON d.calculation_type_id=t.id AND d.version=t.last_allocated_dependency_definition_version WHERE t.domain=$1 ORDER BY t.code`, [domain])).rows;
      for (const type of types) {
        const job = randomUUID(); jobs.push(job);
        await client.query(`INSERT INTO calculation_jobs(id,output_dataset_version_id,calculation_type_id,resolved_dependency_definition_version_id,status)
          VALUES($1,$2,$3,$4,'SUCCEEDED')`, [job, version, type.id, type.definition]);
        await client.query(`INSERT INTO execution_attempts(id,calculation_job_id,attempt_number,status,airflow_dag_id,airflow_dag_run_id,accepted_at,finished_at)
          VALUES($1,$2,1,'SUCCEEDED',$3,$4,now(),now())`, [randomUUID(), job, type.airflow_dag_id, randomBytes(16).toString('hex')]);
      }
      const required = ({ CAPEX: 'FAB_COST', DPR: 'CAPEX', INSURANCE: 'FAB_COST', ONE_STD_COST: 'FAB_COST', E2E_COST: 'ONE_STD_COST' } as Record<string, string>)[domain];
      if (required) await client.query('INSERT INTO dataset_build_snapshot_dependencies VALUES($1,$2,$3)', [snapshot, versions[required]!.series, versions[required]!.version]);
      versions[domain] = { series, version, jobs };
    }
    await client.query('COMMIT'); return { session, versions };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
