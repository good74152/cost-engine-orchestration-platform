#!/bin/sh
# Run only on the authorized VPS, from this repository, with a private env file.
. "$(dirname -- "$0")/common.sh"
[ "$#" -eq 0 ] || fail 'deploy.sh takes no arguments'
close_web
# Build with Web closed before stopping the existing Backend.
compose --profile operations --profile public-web build backend web operator >/dev/null 2>&1 || fail 'Deployment image build failed; Web remains closed'
# Close public admission first; stop/drain backend before any operator mutation.
state=$(backend_observation backend-state) || fail 'Multiple or foreign Backend identities; abort'
ids=$(backend_ids)
for id in $ids; do
  docker_control update --restart=no "$id" >/dev/null 2>&1 || fail 'Cannot disable Backend restart'
  docker_control stop --time 60 "$id" >/dev/null 2>&1 || fail 'Backend stop failed'
done
assert_offline
compose up -d --no-deps --wait --wait-timeout 120 database >/dev/null 2>&1 || fail 'Database startup failed'
echo 'Backend stopped. Take and validate a backup BEFORE explicit migration/seed.'
echo 'Run operator commands in the runbook, then deploy/scripts/start.sh.'
echo 'Web requires a separate approved open-web.sh command; no automatic migration, seed, drain or cutover.'
