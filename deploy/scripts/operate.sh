#!/bin/sh
. "$(dirname -- "$0")/common.sh"
operation=${1:-}
case "$operation" in
  migrate-up|seed|seed-six-domain) [ "$#" -eq 1 ] || fail 'Unexpected Operator arguments'; target='';;
  admission-status|admission-drain|cutover-status|cutover)
    [ "$#" -eq 3 ] && [ "$2" = '--database-url-file' ] || fail 'Admission/Cutover require an explicit --database-url-file target'
    validate_target "$3"; target=$3;;
  *) fail 'Choose migrate-up, seed, seed-six-domain, admission-status, admission-drain, cutover-status or cutover';;
esac
case "$operation" in admission-status|cutover-status) ;; *) assert_offline;; esac
result=$(run_operator "$operation" "$target" 2>/dev/null) || fail "Operator $operation failed; preserve closure and confirm durable state before any explicit retry; outcome is not assumed"
printf '%s\n' "$result"
