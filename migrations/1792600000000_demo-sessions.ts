import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`CREATE TABLE demo_sessions (
    id UUID PRIMARY KEY,
    company_code VARCHAR(20) NOT NULL,
    token_hash BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT uq_demo_sessions_company_code UNIQUE (company_code),
    CONSTRAINT uq_demo_sessions_token_hash UNIQUE (token_hash),
    CONSTRAINT ck_demo_sessions_hash CHECK (octet_length(token_hash) = 32),
    CONSTRAINT ck_demo_sessions_company CHECK (company_code ~ '^DEMO_[0-9A-F]{15}$'),
    CONSTRAINT ck_demo_sessions_expiry CHECK (expires_at > created_at),
    CONSTRAINT ck_demo_sessions_revocation CHECK (revoked_at IS NULL OR revoked_at >= created_at)
  )`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`LOCK TABLE demo_sessions IN ACCESS EXCLUSIVE MODE;
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM demo_sessions) THEN
      RAISE EXCEPTION 'Cannot roll back demo sessions with retained session history';
    END IF;
  END $$; DROP TABLE demo_sessions;`);
}
