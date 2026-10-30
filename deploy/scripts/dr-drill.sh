#!/bin/sh
# Separate trusted, no-target drill entrance. Node 24 and npm ci are required.
set -eu
DEPLOY_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd -- "$DEPLOY_ROOT"
exec node --import tsx deploy/dr-drill.ts "$@"
