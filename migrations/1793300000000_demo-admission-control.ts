import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`CREATE TABLE demo_admission_control (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    state TEXT NOT NULL DEFAULT 'LEGACY_OPEN' CHECK (state IN ('LEGACY_OPEN','DRAINING')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  );
  INSERT INTO demo_admission_control(id) VALUES (1);
  CREATE FUNCTION protect_demo_admission_control() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
      RAISE EXCEPTION 'Demo admission control cannot be removed';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR (OLD.state='DRAINING' AND NEW.state<>'DRAINING') THEN
      RAISE EXCEPTION 'Demo admission drain is irreversible';
    END IF;
    NEW.updated_at := CASE WHEN NEW.state IS DISTINCT FROM OLD.state THEN clock_timestamp() ELSE OLD.updated_at END;
    RETURN NEW;
  END $$;
  CREATE TRIGGER protect_demo_admission_row BEFORE UPDATE OR DELETE ON demo_admission_control
    FOR EACH ROW EXECUTE FUNCTION protect_demo_admission_control();
  CREATE TRIGGER protect_demo_admission_truncate BEFORE TRUNCATE ON demo_admission_control
    FOR EACH STATEMENT EXECUTE FUNCTION protect_demo_admission_control();`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Offline only. Never erase a durable DRAINING barrier or active users.
  pgm.sql(`LOCK TABLE demo_admission_control IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE demo_sessions IN SHARE MODE;
  DO $$ BEGIN
    IF (SELECT count(*) FROM demo_admission_control WHERE id=1 AND state='LEGACY_OPEN')<>1
      OR EXISTS (SELECT 1 FROM demo_sessions WHERE revoked_at IS NULL AND expires_at>clock_timestamp())
      OR EXISTS (SELECT 1 FROM demo_scenario_instances) THEN
      RAISE EXCEPTION 'Cannot remove admission gate after drain or with active sessions or retained scenarios';
    END IF;
  END $$;
  DROP TABLE demo_admission_control;
  DROP FUNCTION protect_demo_admission_control();`);
}
