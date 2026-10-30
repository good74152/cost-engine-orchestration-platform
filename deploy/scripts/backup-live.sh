#!/bin/sh
. "$(dirname -- "$0")/common.sh"
[ "$#" -eq 2 ] && [ "$1" = '--database-url-file' ] || fail 'Online backup requires an explicit --database-url-file target'
validate_target "$2"
: "${DEMO_BACKUP_DIR:?Set existing private absolute off-repository backup directory}"
absolute "$DEMO_BACKUP_DIR"
[ -d "$DEMO_BACKUP_DIR" ] && [ -w "$DEMO_BACKUP_DIR" ] || fail 'Backup directory is unavailable'
backup_root=$(CDPATH= cd -P -- "$DEMO_BACKUP_DIR" && pwd)
case "$(uname -s)" in
  MINGW*|MSYS*) ;; # Windows operators must provision equivalent private ACLs.
  *) [ "$(stat -c '%a' "$backup_root")" = 700 ] && [ "$(stat -c '%u' "$backup_root")" = "$(id -u)" ] \
       || fail 'Backup root must be owned by this operator with mode 0700';;
esac
ancestor=$backup_root
while :; do
  [ ! -e "$ancestor/.git" ] || fail 'Backup directory must be outside every Git worktree'
  parent=$(dirname -- "$ancestor"); [ "$parent" != "$ancestor" ] || break; ancestor=$parent
done
# No offline check, Backend stop/start, migration, seed, Cutover or cleanup.
assert_database
backend_state=$(backend_observation backend-state) || fail 'Backend identity cannot be confirmed'
if [ "$backend_state" = RUNNING ]; then assert_backend; fi
umask 077
bundle=$(mktemp -d "$backup_root/cost-engine-live-backup-XXXXXXXXXXXX") || fail 'Cannot reserve a new private backup identity'
identity=$(basename -- "$bundle")
holder=$identity-snapshot
holder_pid=''
complete=no
cleanup_backup() {
  printf '%s\n' ABORT > "$bundle/release.control"
  if [ -n "$holder_pid" ]; then
    observation=$(docker_control inspect "$holder" 2>/dev/null) || observation='[]'
    if [ "$observation" != '[]' ]; then
      printf '%s' "$observation" | json_check live-holder "$project" "$holder" "$identity" "$deployment_version" >/dev/null 2>&1 \
        && docker_control rm --force --volumes "$holder" >/dev/null 2>&1 \
        || printf '%s\n' 'Snapshot holder cleanup unconfirmed; inspect only this backup identity privately' >&2
    fi
    wait "$holder_pid" 2>/dev/null || true
  fi
  rm -f -- "$bundle/release.control" "$bundle/snapshot.json.partial"
  if [ "$complete" != yes ]; then
    rm -f -- "$bundle/backup.dump.partial" "$bundle/manifest.json.partial" "$bundle/backup.dump" "$bundle/manifest.json"
    rmdir -- "$bundle" 2>/dev/null || true
  fi
}
trap cleanup_backup EXIT
trap 'exit 1' HUP INT TERM
started=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
(while [ ! -f "$bundle/release.control" ]; do sleep 1; done; cat -- "$bundle/release.control") | \
compose --profile operations run --rm -T --no-deps --name "$holder" \
  --label "cost-engine.backup.owner=$identity" --label cost-engine.backup.purpose=demo05d3a \
  -e "DEMO_LIVE_BACKUP_DATABASE_URL_FILE=$2" operator backup-live-snapshot \
  > "$bundle/snapshot.json.partial" 2>/dev/null &
holder_pid=$!
remaining=120
while ! snapshot=$(json_check live-snapshot < "$bundle/snapshot.json.partial" 2>/dev/null); do
  kill -0 "$holder_pid" 2>/dev/null || fail 'Online backup snapshot validation failed; no dump created'
  remaining=$((remaining-1)); [ "$remaining" -gt 0 ] || fail 'Online backup snapshot validation timed out; no dump created'
  sleep 1
done
compose exec -T database pg_dump -U demo_owner -d cost_engine_demo -Fc --lock-wait-timeout=3s --snapshot="$snapshot" \
  > "$bundle/backup.dump.partial" 2>/dev/null || fail 'Online backup dump failed or connection lost; incomplete artifact removed'
printf '%s\n' DUMP_COMPLETE > "$bundle/release.control"
wait "$holder_pid" || fail 'Snapshot transaction lost; incomplete artifact removed'
holder_pid=''
size=$(wc -c < "$bundle/backup.dump.partial" | tr -d '[:space:]')
checksum=$(cd -- "$bundle" && sha256sum backup.dump.partial) || fail 'Backup checksum failed'
checksum=${checksum%% *}
json_check live-manifest "$identity" "$size" "$checksum" "$started" < "$bundle/snapshot.json.partial" \
  > "$bundle/manifest.json.partial" 2>/dev/null || fail 'Online backup manifest failed; incomplete artifact removed'
mv -- "$bundle/backup.dump.partial" "$bundle/backup.dump"
mv -- "$bundle/manifest.json.partial" "$bundle/manifest.json"
complete=yes
cat -- "$bundle/manifest.json"
