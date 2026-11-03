#!/bin/sh
. "$(dirname -- "$0")/common.sh"
[ "$#" -eq 0 ] || fail 'open-web.sh takes no arguments'
close_web
assert_database
# A ready Backend has already verified migrations and the Demo configuration at startup.
assert_backend
if ! compose --profile public-web up -d --no-deps --wait --wait-timeout 60 web >/dev/null 2>&1; then
  close_web
  fail 'Web startup failed and Web was closed; database and configuration retained'
fi
printf 'Web explicitly opened. Verify public HTTPS/ACME immediately; run close-web.sh immediately if acceptance fails.\n'
