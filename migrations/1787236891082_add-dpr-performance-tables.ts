import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createTable('assets', {
        asset_id: { type: 'bigint', primaryKey: true},
        asset_type: { type: 'varchar(50)', notNull: true},
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()')}
    });

    pgm.sql(`
            CREATE TABLE raw_dpr (
                period_start DATE NOT NULL,
                fab VARCHAR(20) NOT NULL,
                asset_id BIGINT NOT NULL,
                amount NUMERIC(18,2) NOT NULL
            )
            PARTITION BY RANGE (period_start);
        `);

    pgm.sql(`
            CREATE TABLE raw_dpr_2026_q1
            PARTITION OF raw_dpr
            FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');
        `);

    pgm.sql(`
            CREATE TABLE raw_dpr_2026_q2
            PARTITION OF raw_dpr
            FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');
        `);

    pgm.sql(`
            CREATE TABLE raw_dpr_2026_q3
            PARTITION OF raw_dpr
            FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');
        `);

    pgm.sql(`
            CREATE TABLE raw_dpr_2026_q4
            PARTITION OF raw_dpr
            FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');
        `);

    pgm.createTable('dpr_results', {
        dataset_version_id: {
            type: 'uuid',
            notNull: true,
            references: 'dataset_versions',
            onDelete: 'RESTRICT'
        },
        fab: {
            type: 'varchar(20)',
            notNull: true
        },
        asset_type: {
            type: 'varchar(50)',
            notNull: true
        },
        total_amount:  {
            type: 'numeric(20,2)',
            notNull: true
        },
        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('now()')
        }
    });

    pgm.addConstraint(
        'dpr_results',
        'uq_dpr_results_dataset_fab_asset_type',
        {
            unique: [
                'dataset_version_id',
                'fab',
                'asset_type'
            ]
        }
    );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropTable('dpr_results');
    pgm.dropTable('raw_dpr');
    pgm.dropTable('assets');
}