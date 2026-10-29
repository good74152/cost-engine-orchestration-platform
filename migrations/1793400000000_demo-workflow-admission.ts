import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s';
  LOCK TABLE demo_admission_control IN ACCESS EXCLUSIVE MODE;
  ALTER TABLE demo_admission_control DROP CONSTRAINT demo_admission_control_state_check;
  ALTER TABLE demo_admission_control ADD CONSTRAINT demo_admission_control_state_check
    CHECK (state IN ('LEGACY_OPEN','DRAINING','WORKFLOW_OPEN'));
  CREATE OR REPLACE FUNCTION protect_demo_admission_control() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
      RAISE EXCEPTION 'Demo admission control cannot be removed';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NOT (
      NEW.state=OLD.state OR (OLD.state='LEGACY_OPEN' AND NEW.state='DRAINING')
      OR (OLD.state='DRAINING' AND NEW.state='WORKFLOW_OPEN')) THEN
      RAISE EXCEPTION 'Demo admission transition is irreversible';
    END IF;
    NEW.updated_at := CASE WHEN NEW.state IS DISTINCT FROM OLD.state THEN clock_timestamp() ELSE OLD.updated_at END;
    RETURN NEW;
  END $$;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s';
  LOCK TABLE demo_admission_control IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE calculation_types,execution_dependency_definition_versions IN SHARE MODE;
  DO $$ BEGIN
    IF (SELECT count(*) FROM demo_admission_control WHERE id=1 AND state IN ('LEGACY_OPEN','DRAINING'))<>1
      OR EXISTS (SELECT 1 FROM calculation_types WHERE domain='CAPEX' AND code='DEMO_CAPEX_TABLE_Y')
      OR EXISTS (SELECT 1 FROM execution_dependency_definition_versions d JOIN calculation_types t ON t.id=d.calculation_type_id
        WHERE t.domain='CAPEX' AND t.code='DEMO_GUIDED_SUMMARY' AND d.version>1) THEN
      RAISE EXCEPTION 'Cannot reverse completed or inconsistent Workflow cutover';
    END IF;
  END $$;
  ALTER TABLE demo_admission_control DROP CONSTRAINT demo_admission_control_state_check;
  ALTER TABLE demo_admission_control ADD CONSTRAINT demo_admission_control_state_check CHECK (state IN ('LEGACY_OPEN','DRAINING'));
  CREATE OR REPLACE FUNCTION protect_demo_admission_control() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
      RAISE EXCEPTION 'Demo admission control cannot be removed';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR (OLD.state='DRAINING' AND NEW.state<>'DRAINING') THEN
      RAISE EXCEPTION 'Demo admission drain is irreversible';
    END IF;
    NEW.updated_at := CASE WHEN NEW.state IS DISTINCT FROM OLD.state THEN clock_timestamp() ELSE OLD.updated_at END;
    RETURN NEW;
  END $$;`);
}
