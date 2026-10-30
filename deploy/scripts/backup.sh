#!/bin/sh
. "$(dirname -- "$0")/common.sh"
[ "$#" -eq 2 ] && [ "$1" = '--database-url-file' ] || fail 'Backup requires an explicit --database-url-file target'
validate_target "$2"
: "${DEMO_BACKUP_DIR:?Set existing private absolute off-repository backup directory}"
absolute "$DEMO_BACKUP_DIR"
[ -d "$DEMO_BACKUP_DIR" ] && [ -w "$DEMO_BACKUP_DIR" ] || fail 'Backup directory is unavailable'
backup_root=$(CDPATH= cd -P -- "$DEMO_BACKUP_DIR" && pwd)
ancestor=$backup_root
while :; do
  [ ! -e "$ancestor/.git" ] || fail 'Backup directory must be outside every Git worktree'
  parent=$(dirname -- "$ancestor"); [ "$parent" != "$ancestor" ] || break; ancestor=$parent
done
assert_offline
assert_database
before=$(run_operator cutover-preflight "$2" 2>/dev/null) || fail 'Backup preflight failed; no dump created'
umask 077
bundle=$(mktemp -d "$backup_root/cost-engine-backup-XXXXXXXXXXXX") || fail 'Cannot reserve a new private backup identity'
complete=no
cleanup_backup() {
  if [ "$complete" != yes ]; then
    # Only this newly reserved bundle, never existing backups or arbitrary paths.
    rm -f -- "$bundle/backup.dump.partial" "$bundle/manifest.json.partial" "$bundle/backup.dump" "$bundle/manifest.json"
    rmdir -- "$bundle" 2>/dev/null || true
  fi
}
trap cleanup_backup EXIT
trap 'exit 1' HUP INT TERM
compose exec -T database pg_dump -U demo_owner -d cost_engine_demo -Fc > "$bundle/backup.dump.partial" 2>/dev/null \
  || fail 'Backup dump failed; incomplete artifact removed'
assert_offline
after=$(run_operator cutover-preflight "$2" 2>/dev/null) || fail 'Backup postflight failed; incomplete artifact removed'
printf '{"before":%s,"after":%s}' "$before" "$after" | json_check backup-match >/dev/null 2>&1 \
  || fail 'Database evidence changed during backup; incomplete artifact removed'
size=$(wc -c < "$bundle/backup.dump.partial" | tr -d '[:space:]')
checksum=$(cd -- "$bundle" && sha256sum backup.dump.partial) || fail 'Backup checksum failed'
checksum=${checksum%% *}
printf '%s' "$before" | json_check backup-manifest "$(basename -- "$bundle")" "$size" "$checksum" > "$bundle/manifest.json.partial" 2>/dev/null \
  || fail 'Backup manifest failed; incomplete artifact removed'
mv -- "$bundle/backup.dump.partial" "$bundle/backup.dump"
mv -- "$bundle/manifest.json.partial" "$bundle/manifest.json"
complete=yes
cat -- "$bundle/manifest.json"
