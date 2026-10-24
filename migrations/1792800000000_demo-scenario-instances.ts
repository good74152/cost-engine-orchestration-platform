import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`CREATE TABLE demo_scenario_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES demo_sessions(id) ON DELETE RESTRICT,
    scenario_type VARCHAR(50) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'READY',
    completed_step INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_demo_scenario_session UNIQUE (session_id),
    CONSTRAINT ck_demo_scenario_type CHECK (scenario_type IN ('HAPPY_PATH','FAILURE_RETRY','LOST_RESPONSE_RECOVERY')),
    CONSTRAINT ck_demo_scenario_status CHECK (status IN ('READY','IN_PROGRESS','COMPLETED')),
    CONSTRAINT ck_demo_scenario_step CHECK (completed_step >= 0)
  )`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`LOCK TABLE demo_scenario_instances IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM demo_scenario_instances) THEN
        RAISE EXCEPTION 'Cannot roll back demo scenarios with retained scenario data';
      END IF;
    END $$;
    DROP TABLE demo_scenario_instances;`);
}
