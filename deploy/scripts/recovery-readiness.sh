#!/bin/sh
set -eu
repository=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec "$repository/node_modules/.bin/tsx" "$repository/deploy/recovery-readiness.ts" "$@"
