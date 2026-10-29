#!/bin/sh
. "$(dirname -- "$0")/common.sh"
[ "$#" -eq 0 ] || fail 'close-web.sh takes no arguments'
close_web
printf 'Compose Web containers confirmed stopped; database and Backend retained. External entrypoints are outside this control.\n'
