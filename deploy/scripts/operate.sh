#!/bin/sh
set -eu
: "${DEMO_DEPLOY_ENV:?Set absolute private Compose env file}"
case "${1:-}" in migrate-up|seed) ;; *) echo 'Choose migrate-up or seed' >&2; exit 1;; esac
running=$(docker ps --filter name='^/cost-engine-demo-backend$' --format '{{.ID}}')
[ -z "$running" ] || { echo 'Stop backend before operator mutations' >&2; exit 1; }
docker compose --env-file "$DEMO_DEPLOY_ENV" -f deploy/compose.yaml --profile operations run --rm operator "$1"
