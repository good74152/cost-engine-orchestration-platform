#!/bin/sh
# No deployment target, Compose env, deployed credentials or restore URL is read.
set -eu
CONTROL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fail() { printf '%s\n' "$1" >&2; exit 1; }
docker_control() { MSYS_NO_PATHCONV=1 docker "$@"; }
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
json_check() {
  if command -v node >/dev/null 2>&1; then node "$CONTROL_DIR/control-json.cjs" "$@"
  else
    docker_control run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user node \
      --mount "type=bind,source=$(host_path "$CONTROL_DIR/control-json.cjs"),target=/control-json.cjs,readonly" \
      node:24-bookworm-slim node /control-json.cjs "$@"
  fi
}
[ "$#" -eq 2 ] && [ "$1" = '--backup-file' ] || fail 'Choose only --backup-file with an explicit archive; restore targets are never accepted'
case "$2" in /*/backup.dump) ;; *) fail 'Use an absolute backup.dump path';; esac
[ -f "$2" ] && [ ! -L "$2" ] || fail 'Backup archive is unavailable or is a symlink'
bundle=$(CDPATH= cd -P -- "$(dirname -- "$2")" && pwd) || fail 'Backup directory unavailable'
ancestor=$bundle
while :; do
  [ ! -e "$ancestor/.git" ] || fail 'Restore archive must be outside every Git worktree'
  parent=$(dirname -- "$ancestor"); [ "$parent" != "$ancestor" ] || break; ancestor=$parent
done
archive=$bundle/backup.dump
[ -f "$bundle/manifest.json" ] && [ ! -L "$bundle/manifest.json" ] || fail 'Complete backup manifest required'
[ "$(head -c 5 "$archive")" = PGDMP ] || fail 'PostgreSQL custom archive required'
size=$(wc -c < "$archive" | tr -d '[:space:]')
checksum=$(cd -- "$bundle" && sha256sum backup.dump) || fail 'Cannot verify archive checksum'
checksum=${checksum%% *}
metadata=$(json_check backup-metadata "$(basename -- "$bundle")" "$size" "$checksum" < "$bundle/manifest.json" 2>/dev/null) \
  || fail 'Backup integrity or complete preflight evidence rejected'
IFS='|' read -r version checksum identity <<EOF
$metadata
EOF
nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
case "$nonce" in ''|*[!a-f0-9]*) fail 'Cannot create independent restore identity';; esac
[ "${#nonce}" -eq 32 ] || fail 'Invalid restore identity'
volume=demo05d2_restore_${nonce}_data
container=demo05d2_restore_${nonce}_postgres
database=restore_$nonce
container_id=''
volume_owned=no
assert_volume() {
  observation=$(docker_control volume inspect "$volume" 2>/dev/null) || return 1
  printf '%s' "$observation" | json_check restore-volume "$volume" "$nonce" >/dev/null 2>&1
}
assert_container() {
  observation=$(docker_control inspect "$container_id" 2>/dev/null) || return 1
  printf '%s' "$observation" | json_check restore-container "$container_id" "$volume" "$nonce" >/dev/null 2>&1
}
cleanup_restore() {
  if [ -n "$container_id" ]; then
    assert_container || { printf '%s\n' 'Restore ownership unconfirmed; refuse cleanup' >&2; return 1; }
    docker_control rm --force --volumes "$container_id" >/dev/null 2>&1 || return 1
    container_id=''
  fi
  if [ "$volume_owned" = yes ]; then
    assert_volume || { printf '%s\n' 'Restore volume ownership unconfirmed; refuse cleanup' >&2; return 1; }
    docker_control volume rm "$volume" >/dev/null 2>&1 || return 1
    volume_owned=no
  fi
}
trap 'cleanup_restore || printf "Restore cleanup unconfirmed; inspect container %s and volume %s privately\n" "$container" "$volume" >&2' EXIT
trap 'exit 1' HUP INT TERM
if docker_control volume inspect "$volume" >/dev/null 2>&1 || docker_control inspect "$container" >/dev/null 2>&1; then fail 'Restore identity collision; no existing resource may be reused'; fi
docker_control volume create --label "cost-engine.restore.owner=$nonce" --label cost-engine.restore.purpose=demo05d2 "$volume" >/dev/null 2>&1 \
  || fail 'Cannot create independent restore volume'
assert_volume || fail 'Independent volume ownership rejected'
volume_owned=yes
container_id=$(docker_control create --name "$container" --label "cost-engine.restore.owner=$nonce" --label cost-engine.restore.purpose=demo05d2 \
  --network none --restart no --mount "type=volume,source=$volume,target=/var/lib/postgresql" \
  --env POSTGRES_USER=restore_owner --env "POSTGRES_DB=$database" --env POSTGRES_HOST_AUTH_METHOD=trust postgres:18 2>/dev/null) \
  || fail 'Cannot create independent restore PostgreSQL'
assert_container || fail 'Restore isolation rejected before startup'
docker_control start "$container_id" >/dev/null 2>&1 || fail 'Restore PostgreSQL startup failed'
remaining=60
# The entrypoint's temporary init server exposes only a Unix socket. Wait for
# final TCP readiness so it cannot be mistaken for the fully initialized DB.
until docker_control exec "$container_id" pg_isready -h 127.0.0.1 -U restore_owner -d "$database" >/dev/null 2>&1; do
  remaining=$((remaining-1)); [ "$remaining" -gt 0 ] || fail 'Restore PostgreSQL is unavailable'; sleep 1
done
assert_volume && assert_container || fail 'Restore isolation rejected before pg_restore'
docker_control exec -i "$container_id" pg_restore -U restore_owner -d "$database" --exit-on-error --no-owner --no-privileges < "$archive" >/dev/null 2>&1 \
  || fail 'Actual PostgreSQL restore failed; no restore verification or production recovery claimed'
restored=$(docker_control run --rm --network "container:$container_id" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  --entrypoint ./node_modules/.bin/tsx --env "DEPLOYMENT_VERSION=$version" "cost-engine-demo-operator:$version" deploy/verify-restored.ts "$nonce" 2>/dev/null) \
  || fail 'Restored schema, configuration or empty-data verification failed'
result=$(printf '{"manifest":%s,"restored":%s}' "$(cat -- "$bundle/manifest.json")" "$restored" \
  | json_check restore-result "$container" "$volume" "$nonce" 2>/dev/null) || fail 'Restored state does not match backup evidence'
cleanup_restore || fail 'Restore completed but owned resource cleanup failed; verification withheld'
printf '%s\n' "$result"
