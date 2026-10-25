import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`CREATE TABLE demo_scenario_step_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_id UUID NOT NULL REFERENCES demo_scenario_instances(id) ON DELETE RESTRICT,
    step_number INTEGER NOT NULL CHECK (step_number BETWEEN 1 AND 6),
    request_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED')),
    intent JSONB NOT NULL CHECK (jsonb_typeof(intent)='object'),
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ,
    UNIQUE (scenario_id,step_number),
    UNIQUE (scenario_id,request_id),
    CHECK (((status='PENDING' AND result IS NULL AND completed_at IS NULL) OR
      (status='COMPLETED' AND completed_at IS NOT NULL AND result IS NOT NULL
       AND jsonb_typeof(result)='object'
       AND result @> jsonb_build_object('scenarioId',scenario_id,'stepNumber',step_number,
         'requestId',request_id,'stepStatus','COMPLETED','completedStep',step_number,
         'scenarioStatus',CASE WHEN step_number=6 THEN 'COMPLETED' ELSE 'IN_PROGRESS' END)
       AND jsonb_typeof(result->'stepResult')='object'
       AND result->'stepResult' @> jsonb_build_object(
         'datasetStatus',CASE WHEN step_number=1 THEN 'DRAFT' WHEN step_number=5 THEN 'VALIDATING'
           WHEN step_number=6 THEN 'PUBLISHED' ELSE 'BUILDING' END,
         'jobStatus',CASE WHEN step_number=1 THEN 'PENDING' WHEN step_number<4 THEN 'RUNNING' ELSE 'SUCCEEDED' END)
       AND (step_number=1 OR result->'stepResult' @> jsonb_build_object('attemptStatus',
         CASE WHEN step_number<4 THEN 'ACCEPTED' ELSE 'SUCCEEDED' END))
       AND (step_number<>3 OR result->'stepResult' @> '{"externalStatus":"SUCCEEDED"}'::jsonb))) IS TRUE)
  );

  -- JSON identities are internal, but still validate their owner/parent chain in
  -- PostgreSQL. Never allow a ledger to borrow another Scenario's resources.
  CREATE FUNCTION validate_demo_step_binding() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE company text; prior jsonb; item jsonb;
  BEGIN
    IF TG_OP='UPDATE' AND (NEW.scenario_id<>OLD.scenario_id OR NEW.step_number<>OLD.step_number
      OR NEW.request_id<>OLD.request_id OR NEW.intent<>OLD.intent OR NEW.created_at<>OLD.created_at
      OR OLD.status='COMPLETED') THEN
      RAISE EXCEPTION 'Immutable demo step history' USING ERRCODE='23514';
    END IF;
    SELECT s.company_code INTO STRICT company FROM demo_scenario_instances sc
      JOIN demo_sessions s ON s.id=sc.session_id WHERE sc.id=NEW.scenario_id;
    IF NEW.step_number=1 THEN
      IF NEW.intent<>jsonb_build_object('domain','CAPEX','companyCode',company,'fiscalYear',2026,
        'period','Q4','expectedVersion',1,'calculationTypeCode','DEMO_GUIDED_SUMMARY') THEN
        RAISE EXCEPTION 'Invalid demo dataset intent' USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT result->'stepResult' INTO prior FROM demo_scenario_step_executions
        WHERE scenario_id=NEW.scenario_id AND step_number=NEW.step_number-1 AND status='COMPLETED';
      IF prior IS NULL OR NEW.intent->>'datasetVersionId' IS DISTINCT FROM prior->>'datasetVersionId'
        OR NEW.intent->>'jobId' IS DISTINCT FROM prior->>'jobId'
        OR (NEW.step_number>2 AND NEW.intent->>'executionAttemptId' IS DISTINCT FROM prior->>'executionAttemptId') THEN
        RAISE EXCEPTION 'Invalid demo parent binding' USING ERRCODE='23514';
      END IF;
    END IF;
    FOR item IN SELECT NEW.intent UNION ALL SELECT NEW.result->'stepResult' WHERE NEW.result IS NOT NULL LOOP
      IF item ? 'datasetVersionId' THEN
        IF NOT EXISTS (SELECT 1 FROM dataset_versions v JOIN dataset_series ds ON ds.id=v.dataset_series_id
          JOIN calculation_jobs j ON j.output_dataset_version_id=v.id
          JOIN calculation_types ct ON ct.id=j.calculation_type_id
          WHERE v.id=(item->>'datasetVersionId')::uuid AND j.id=(item->>'jobId')::uuid
            AND ds.company_code=company AND ds.domain='CAPEX' AND ds.fiscal_year=2026 AND ds.period='Q4'
            AND v.version=1 AND ct.domain='CAPEX' AND ct.code='DEMO_GUIDED_SUMMARY') THEN
          RAISE EXCEPTION 'Invalid demo resource binding' USING ERRCODE='23514';
        END IF;
        IF NEW.step_number>1 AND (item->>'datasetVersionId' IS DISTINCT FROM NEW.intent->>'datasetVersionId'
          OR item->>'jobId' IS DISTINCT FROM NEW.intent->>'jobId') THEN
          RAISE EXCEPTION 'Changed demo resource binding' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.step_number>1 OR (NEW.status='COMPLETED' AND item=NEW.result->'stepResult') THEN
        RAISE EXCEPTION 'Missing demo resource binding' USING ERRCODE='23514';
      END IF;
      IF item ? 'executionAttemptId' THEN
        IF NOT EXISTS (SELECT 1 FROM execution_attempts a
          JOIN calculation_jobs j ON j.id=a.calculation_job_id
          JOIN dataset_build_snapshots b ON b.dataset_version_id=j.output_dataset_version_id
          WHERE a.id=(item->>'executionAttemptId')::uuid
          AND a.calculation_job_id=(item->>'jobId')::uuid AND a.attempt_number=1
          AND b.id=(item->>'datasetBuildSnapshotId')::uuid
          AND j.resolved_dependency_definition_version_id=(item->>'resolvedDependencyDefinitionVersionId')::uuid
          AND (NOT item ? 'airflowDagId' OR a.airflow_dag_id=item->>'airflowDagId')
          AND (NOT item ? 'airflowDagRunId' OR a.airflow_dag_run_id=item->>'airflowDagRunId')) THEN
          RAISE EXCEPTION 'Invalid demo attempt binding' USING ERRCODE='23514';
        END IF;
        IF NEW.step_number>2 AND item->>'executionAttemptId' IS DISTINCT FROM NEW.intent->>'executionAttemptId' THEN
          RAISE EXCEPTION 'Changed demo attempt binding' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.step_number>2 OR (NEW.step_number=2 AND NEW.status='COMPLETED' AND item=NEW.result->'stepResult') THEN
        RAISE EXCEPTION 'Missing demo attempt binding' USING ERRCODE='23514';
      END IF;
    END LOOP;
    RETURN NEW;
  END $$;
  CREATE TRIGGER demo_step_binding BEFORE INSERT OR UPDATE ON demo_scenario_step_executions
    FOR EACH ROW EXECUTE FUNCTION validate_demo_step_binding();`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`LOCK TABLE demo_scenario_step_executions IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM demo_scenario_step_executions) THEN
        RAISE EXCEPTION 'Cannot roll back demo steps with retained ledger data';
      END IF;
    END $$;
    DROP TABLE demo_scenario_step_executions;
    DROP FUNCTION validate_demo_step_binding();`);
}
