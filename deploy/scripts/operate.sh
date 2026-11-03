#!/bin/sh
. "$(dirname -- "$0")/common.sh"
[ "$#" -eq 1 ] || fail 'Choose migrate-up or seed-six-domain'
case "$1" in
  migrate-up|seed-six-domain) ;;
  *) fail 'Choose migrate-up or seed-six-domain';;
esac
assert_offline
result=$(compose --profile operations run --rm -T --no-deps operator "$1" 2>/dev/null) || fail "Operator $1 failed; confirm database state before any explicit retry; outcome is not assumed"
printf '%s\n' "$result"
