import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createTable('dpr_calculation_inputs', {
        input_snapshot_id: {
            type: 'uuid',
            notNull: true,
            references: 'dpr_calculation_input_snapshots',
            onDelete: 'RESTRICT'
        },
        fab: {
            type: 'varchar(20)',
            notNull: true
        },
        asset_id: {
            type: 'bigint',
            notNull: true,
            references: 'assets',
            onDelete: 'RESTRICT'
        },
        amount: {
            type: 'numeric(18,2)',
            notNull: true
        }
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropTable('dpr_calculation_inputs');
}