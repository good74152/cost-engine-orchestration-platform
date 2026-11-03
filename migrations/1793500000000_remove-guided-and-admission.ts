import type { MigrationBuilder } from 'node-pg-migrate';

// Guided scenarios and the admission gate are gone (ADR-0022). Forward only: their
// rows are disposable demo data, and the code that used these objects no longer exists.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE demo_scenario_step_executions;
    DROP TABLE demo_scenario_instances;
    DROP FUNCTION validate_demo_step_binding();
    DROP FUNCTION validate_demo_step_binding_02c();
    DROP FUNCTION validate_demo_step_binding_02d();
    DROP FUNCTION preserve_demo_scenario_binding();
    DROP TABLE demo_admission_control;
    DROP FUNCTION protect_demo_admission_control();`);
}

export const down = false;
