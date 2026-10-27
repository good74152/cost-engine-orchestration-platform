#!/bin/sh
set -eu
export DEMO_PROXY_SECRET="$(cat /run/secrets/proxy_secret)"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
