#!/bin/sh
. "$(dirname -- "$0")/common.sh"
[ "$#" -eq 0 ] || fail 'start.sh takes no arguments'
close_web
compose up -d --no-deps --wait --wait-timeout 120 database >/dev/null 2>&1 || fail 'PostgreSQL startup failed; Web remains closed'
assert_database
state=$(backend_observation backend-state) || fail 'Multiple or foreign Backend identities; refuse startup'
if [ "$state" != RUNNING ]; then
  compose up -d --no-deps --wait --wait-timeout 120 backend >/dev/null 2>&1 || fail 'Backend not ready; Web remains closed; no database rollback performed'
fi
assert_backend
printf 'Backend ready at Deployment Version %s; Web remains closed.\n' "$deployment_version"
