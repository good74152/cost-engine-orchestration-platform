#!/bin/sh
. "$(dirname -- "$0")/common.sh"
[ "$#" -eq 2 ] && [ "$1" = '--database-url-file' ] || fail 'Online backup requires an explicit --database-url-file target'
validate_target "$2"
# Coreutils is also used for private-directory checks and archive checksums.
timeout --version >/dev/null 2>&1 || fail 'GNU timeout is required for bounded backup cleanup'
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
resources_cleaned=no
cleanup_resources() (
  # EXIT cleanup must continue after any filesystem error. Bound every Docker
  # call here, including json_check's Docker fallback; never signal host PIDs.
  set +e
  docker_control() { MSYS_NO_PATHCONV=1 timeout --kill-after=2s 8s docker "$@"; }
  cleanup_ok=yes
  { printf '%s\n' ABORT > "$bundle/release.control"; } 2>/dev/null || cleanup_ok=no
  if [ -n "$holder_pid" ]; then
    if observation=$(docker_control inspect "$holder" 2>/dev/null); then
      if owned_id=$(printf '%s' "$observation" | json_check live-holder "$project" "$holder" "$identity" "$deployment_version" 2>/dev/null); then
        # Immutable ID, never a name that another administrator could replace.
        docker_control rm --force --volumes "$owned_id" >/dev/null 2>&1 || cleanup_ok=no
      else
        cleanup_ok=no
        printf 'Snapshot ownership unconfirmed for %s; inspect manually; no unverified container removed\n' "$identity" >&2
      fi
    else
      # A failed inspect is not proof of absence. Confirm through a separate,
      # successful exact-name enumeration before accepting automatic removal.
      if remaining_ids=$(docker_control ps --all --filter "name=^/$holder\$" --format '{{.ID}}' 2>/dev/null) && [ -z "$remaining_ids" ]; then :
      else cleanup_ok=no; printf 'Snapshot cleanup unconfirmed for %s; inspect ownership manually\n' "$identity" >&2; fi
    fi
  fi
  # No wait here: a failed release write can leave the producer waiting. It
  # observes this foreground process exiting and closes only its own stdin pipe.
  if [ -d "$bundle/release.control" ] && [ ! -L "$bundle/release.control" ]; then
    rmdir -- "$bundle/release.control" 2>/dev/null || cleanup_ok=no
  else rm -f -- "$bundle/release.control" 2>/dev/null || cleanup_ok=no; fi
  rm -f -- "$bundle/snapshot.json.partial" 2>/dev/null || cleanup_ok=no
  [ "$cleanup_ok" = yes ] || { printf 'Backup cleanup failed for %s; inspect this backup attempt manually\n' "$identity" >&2; exit 1; }
)
on_exit() {
  outcome=$?
  trap - EXIT HUP INT TERM
  if [ "$resources_cleaned" != yes ]; then cleanup_resources || outcome=1; fi
  if [ "$complete" != yes ]; then
    rm -f -- "$bundle/backup.dump.partial" "$bundle/manifest.json.partial" "$bundle/backup.dump" "$bundle/manifest.json" 2>/dev/null || outcome=1
    rmdir -- "$bundle" 2>/dev/null || outcome=1
  fi
  exit "$outcome"
}
trap on_exit EXIT
trap 'exit 1' HUP INT TERM
started=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
backup_pid=$$
(remaining=3600
 while [ ! -f "$bundle/release.control" ]; do
   kill -0 "$backup_pid" 2>/dev/null || exit 1
   remaining=$((remaining-1)); [ "$remaining" -gt 0 ] || exit 1
   sleep 1
 done
 cat -- "$bundle/release.control") 2>/dev/null | \
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
{ printf '%s\n' DUMP_COMPLETE > "$bundle/release.control"; } 2>/dev/null || fail 'Snapshot release failed; backup withheld'
remaining=15
while kill -0 "$holder_pid" 2>/dev/null; do
  remaining=$((remaining-1)); [ "$remaining" -gt 0 ] || fail 'Snapshot completion timed out; backup withheld'
  sleep 1
done
wait "$holder_pid" || fail 'Snapshot transaction lost; incomplete artifact removed'
size=$(wc -c < "$bundle/backup.dump.partial" | tr -d '[:space:]')
checksum=$(cd -- "$bundle" && sha256sum backup.dump.partial) || fail 'Backup checksum failed'
checksum=${checksum%% *}
json_check live-manifest "$identity" "$size" "$checksum" "$started" < "$bundle/snapshot.json.partial" \
  > "$bundle/manifest.json.partial" 2>/dev/null || fail 'Online backup manifest failed; incomplete artifact removed'
cleanup_resources || fail 'Snapshot cleanup failed; backup withheld'
resources_cleaned=yes
mv -- "$bundle/backup.dump.partial" "$bundle/backup.dump"
mv -- "$bundle/manifest.json.partial" "$bundle/manifest.json"
complete=yes
cat -- "$bundle/manifest.json"
