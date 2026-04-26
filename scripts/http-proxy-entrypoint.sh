#!/bin/sh
set -eu

CONF_DIR="${MITMPROXY_CONFDIR:-/run/sandy-mitmproxy-conf}"
AUTH_SOCKET="${SANDY_HTTP_PROXY_AUTH_SOCKET:-/run/sandy-proxy-auth.sock}"

mkdir -p "$CONF_DIR"

exec mitmdump \
  --mode regular \
  --listen-host 0.0.0.0 \
  --listen-port 8081 \
  --proxyauth any \
  --quiet \
  --set confdir="$CONF_DIR" \
  --set block_global=false \
  --set block_private=false \
  --set flow_detail=0 \
  -s /app/http-proxy-addon.py \
  --set sandy_auth_socket="$AUTH_SOCKET"
