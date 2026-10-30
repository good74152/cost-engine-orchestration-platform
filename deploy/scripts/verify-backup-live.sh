#!/bin/sh
# Reuse the exact Demo-05D-2 no-target isolation/ownership/cleanup boundary.
CONTROL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec sh "$CONTROL_DIR/verify-backup.sh" --operational "$@"
