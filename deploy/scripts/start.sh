#!/bin/sh
set -eu
: "${DEMO_DEPLOY_ENV:?Set absolute private Compose env file}"
compose() { docker compose --env-file "$DEMO_DEPLOY_ENV" -f deploy/compose.yaml "$@"; }
compose config --quiet
# Re-running up is idempotent; no scaling or rolling replicas.
compose up -d --wait database backend web
