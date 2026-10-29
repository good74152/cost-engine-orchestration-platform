#!/bin/sh
. "$(dirname -- "$0")/common.sh"
close_web
[ "$#" -eq 3 ] && [ "$1" = '--confirm-owner-acceptance-05d2-05d3' ] && [ "$2" = '--database-url-file' ] \
  || fail 'Owner approval including Demo-05D-2/05D-3 acceptance is required before Web can accept public traffic'
validate_target "$3"
assert_database
assert_backend
status=$(run_operator cutover-status "$3" 2>/dev/null) || fail 'Cutover status query failed; keep Web closed and confirm durable state privately'
printf '%s' "$status" | json_check workflow-status 2>/dev/null >/dev/null || fail 'Web refused: complete WORKFLOW_OPEN + WORKFLOW status is required'
if ! compose --profile public-web up -d --no-deps --wait --wait-timeout 60 web >/dev/null 2>&1; then
  close_web
  fail 'Web startup failed and Web was closed; database and configuration retained'
fi
printf 'Web explicitly opened. Verify public HTTPS/ACME immediately; run close-web.sh immediately if acceptance fails.\n'
