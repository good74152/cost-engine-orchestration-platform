#!/bin/sh
set -eu
: "${DEMO_DEPLOY_ENV:?Set private Compose env file}"
: "${DEMO_BACKUP_DIR:?Set private absolute off-repository backup directory}"
case "$DEMO_BACKUP_DIR" in /*) ;; *) echo 'Use an absolute backup directory' >&2; exit 1;; esac
umask 077
mkdir -p "$DEMO_BACKUP_DIR"
file="$DEMO_BACKUP_DIR/cost-engine-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
docker compose --env-file "$DEMO_DEPLOY_ENV" -f deploy/compose.yaml exec -T database \
  pg_dump -U demo_owner -d cost_engine_demo -Fc > "$file.partial"
mv "$file.partial" "$file"
echo 'Backup completed; validate restore on an isolated target and copy off-host.'
