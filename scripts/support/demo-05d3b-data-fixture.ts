import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { operationalDataFixture } from './demo-05d3a-data-fixture.js';

/** Owned disposable data. Keeps the published six-domain graph, then adds
 * independent root datasets with real persisted execution/recovery states. */
export async function drillDataFixture(db: Pool) {
  const base = await operationalDataFixture(db), ids: Record<string, { job: string; attempt: string | null }> = {};
  const type = (await db.query(`SELECT t.id,t.airflow_dag_id,d.id AS definition FROM calculation_types t
    JOIN execution_dependency_definition_versions d ON d.calculation_type_id=t.id AND d.version=1 WHERE t.domain='FAB_COST'`)).rows[0];
  const client = await db.connect();
  try {
    await client.query('BEGIN'); let year = 2030;
    for (const status of ['NONE','PREPARED','DISPATCHING','ACCEPTED','FAILED','DISPATCH_FAILED']) {
      const series = randomUUID(), version = randomUUID(), job = randomUUID(), attempt = status === 'NONE' ? null : randomUUID();
      await client.query(`INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period,last_allocated_version) VALUES($1,'FAB_COST',$2,$3,'Q1',1)`, [series,base.session.companyCode,year++]);
      await client.query(`INSERT INTO dataset_versions(id,dataset_series_id,version,status) VALUES($1,$2,1,$3)`, [version,series,status==='NONE'?'DRAFT':'BUILDING']);
      await client.query(`INSERT INTO calculation_jobs(id,output_dataset_version_id,calculation_type_id,status,resolved_dependency_definition_version_id)
        VALUES($1,$2,$3,$4,$5)`, [job,version,type.id,status==='ACCEPTED'?'RUNNING':status==='FAILED'?'FAILED':'PENDING',status==='NONE'?null:type.definition]);
      if (attempt) {
        await client.query('INSERT INTO dataset_build_snapshots(id,dataset_version_id) VALUES($1,$2)', [randomUUID(),version]);
        await client.query(`INSERT INTO execution_attempts(id,calculation_job_id,attempt_number,status,airflow_dag_id,airflow_dag_run_id)
          VALUES($1,$2,1,$3,$4,$5)`, [attempt,job,status,type.airflow_dag_id,randomUUID()]);
      }
      ids[status] = {job,attempt};
    }
    await client.query('COMMIT'); return {...base,ids};
  } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
