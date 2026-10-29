#!/bin/sh
# Sourced by explicit trusted commands. No automatic migration, seed or cutover.
set -eu
CONTROL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_ROOT=$(CDPATH= cd -- "$CONTROL_DIR/.." && pwd)
fail() { printf '%s\n' "$1" >&2; exit 1; }
absolute() { case "$1" in /*) ;; *) fail 'Use an absolute deployment configuration path';; esac; }
: "${DEMO_DEPLOY_ENV:?Set absolute private Compose env file}"
absolute "$DEMO_DEPLOY_ENV"
DEMO_COMPOSE_FILE=${DEMO_COMPOSE_FILE:-$DEPLOY_ROOT/compose.yaml}
absolute "$DEMO_COMPOSE_FILE"
[ -r "$DEMO_DEPLOY_ENV" ] && [ -r "$DEMO_COMPOSE_FILE" ] || fail 'Deployment configuration is unreadable'
if [ -n "${DEMO_COMPOSE_OVERRIDE:-}" ]; then absolute "$DEMO_COMPOSE_OVERRIDE"; [ -r "$DEMO_COMPOSE_OVERRIDE" ] || fail 'Compose override unreadable'; fi
# Native Docker on Git Bash needs host paths; production POSIX hosts use them unchanged.
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
docker_control() { MSYS_NO_PATHCONV=1 docker "$@"; }
compose() {
  if [ -n "${DEMO_COMPOSE_OVERRIDE:-}" ]; then
    docker_control compose --env-file "$(host_path "$DEMO_DEPLOY_ENV")" -f "$(host_path "$DEMO_COMPOSE_FILE")" -f "$(host_path "$DEMO_COMPOSE_OVERRIDE")" "$@"
  else docker_control compose --env-file "$(host_path "$DEMO_DEPLOY_ENV")" -f "$(host_path "$DEMO_COMPOSE_FILE")" "$@"; fi
}
json_check() {
  if command -v node >/dev/null 2>&1; then node "$CONTROL_DIR/control-json.cjs" "$@"
  else
    docker_control run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user node \
      --mount "type=bind,source=$(host_path "$CONTROL_DIR/control-json.cjs"),target=/control-json.cjs,readonly" \
      node:24-bookworm-slim node /control-json.cjs "$@"
  fi
}
configuration=$(compose --profile operations --profile public-web config --format json 2>/dev/null) || fail 'Compose configuration failed'
metadata=$(printf '%s' "$configuration" | json_check config 2>/dev/null) || fail 'Deployment version, environment or security configuration rejected'
IFS='|' read -r deployment_version project backend_name backend_image web_image <<EOF
$metadata
EOF
service_ids() { docker_control ps --all --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1" --format '{{.ID}}' 2>/dev/null; }
backend_ids() {
  owned=$(service_ids backend) || fail 'Cannot inspect Backend containers'
  named=$(docker_control ps --all --filter "name=^/$backend_name\$" --format '{{.ID}}' 2>/dev/null) || fail 'Cannot inspect Backend identity'
  printf '%s\n%s\n' "$owned" "$named" | sort -u
}
inspect_ids() { if [ -z "$1" ]; then printf '[]'; else docker_control inspect $1 2>/dev/null; fi; }
backend_observation() {
  ids=$(backend_ids) || fail 'Backend enumeration failed; offline state is unconfirmed'
  observation=$(inspect_ids "$ids") || fail 'Backend inspection failed'
  printf '%s' "$observation" | json_check "$1" "$project" "$backend_name" "$backend_image" "$deployment_version" 2>/dev/null
}
assert_offline() {
  backend_observation offline || fail 'Stop the unique Backend and disable its restart policy before a modifying Operator command'
  ids=$(service_ids web) || fail 'Cannot inspect Web containers'
  observation=$(inspect_ids "$ids") || fail 'Web inspection failed'
  printf '%s' "$observation" | json_check stopped "$project" 2>/dev/null || fail 'Close Web before a modifying Operator command'
}
close_web() {
  ids=$(service_ids web) || fail 'Cannot inspect Web containers'
  for id in $ids; do
    docker_control update --restart=no "$id" >/dev/null 2>&1 || fail 'Cannot disable Web restart; verify entrypoint privately'
    docker_control stop --time 30 "$id" >/dev/null 2>&1 || fail 'Cannot stop Web; entrypoint closure is unconfirmed'
  done
  ids=$(service_ids web) || fail 'Cannot confirm Web closure'
  observation=$(inspect_ids "$ids") || fail 'Cannot confirm Web closure'
  printf '%s' "$observation" | json_check stopped "$project" 2>/dev/null || fail 'Web is not confirmed stopped'
}
assert_backend() {
  backend_observation backend || fail 'Unique Backend health, image tag or Deployment Version mismatch'
  compose exec -T backend node -e 'try { const r=await fetch("http://127.0.0.1:3000/health/ready",{signal:AbortSignal.timeout(5000)});const b=await r.json();if(r.status!==200||b.status!=="ready"||b.version!==process.argv[1])process.exit(1); } catch { process.exit(1); }' "$deployment_version" >/dev/null 2>&1 \
    || fail 'Backend readiness or Deployment Version check failed'
}
assert_database() {
  compose exec -T database pg_isready -U demo_owner -d cost_engine_demo >/dev/null 2>&1 || fail 'PostgreSQL is unavailable'
}
validate_target() { [ "$1" = '/run/secrets/database_url' ] || fail 'Explicit target must be the mounted Demo database file /run/secrets/database_url'; }
run_operator() {
  case "$1" in
    admission-*) compose --profile operations run --rm -T --no-deps -e "DEMO_ADMISSION_DATABASE_URL_FILE=$2" operator "$1";;
    cutover*) compose --profile operations run --rm -T --no-deps -e "DEMO_CUTOVER_DATABASE_URL_FILE=$2" operator "$1";;
    *) compose --profile operations run --rm -T --no-deps operator "$1";;
  esac
}
