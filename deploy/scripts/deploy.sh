#!/bin/sh
# Run only on the authorized VPS, from this repository, with a private env file.
set -eu
: "${DEMO_DEPLOY_ENV:?Set absolute private Compose env file}"
case "$DEMO_DEPLOY_ENV" in /*) ;; *) echo 'Use an absolute env file' >&2; exit 1;; esac
compose() { docker compose --env-file "$DEMO_DEPLOY_ENV" -f deploy/compose.yaml "$@"; }
compose config --quiet
count=$(docker ps --filter name='^/cost-engine-demo-backend$' --format '{{.ID}}' | wc -l)
[ "$count" -le 1 ] || { echo 'Multiple backends; abort' >&2; exit 1; }
# Build before maintenance; existing traffic can continue on the old image.
compose --profile operations build backend web operator
# Close public admission first; stop/drain backend before any operator mutation.
compose stop web backend
running=$(docker ps --filter name='^/cost-engine-demo-backend$' --format '{{.ID}}')
[ -z "$running" ] || { echo 'Backend still running; abort' >&2; exit 1; }
compose up -d --wait database
echo 'Backend stopped. Take and validate a backup BEFORE explicit migration/seed.'
echo 'Run operator commands in the runbook, then deploy/scripts/start.sh.'
