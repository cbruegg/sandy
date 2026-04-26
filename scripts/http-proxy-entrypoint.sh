#!/bin/sh
set -eu

CONF_DIR="${MITMPROXY_CONFDIR:-/run/sandy-mitmproxy-conf}"

mkdir -p "$CONF_DIR"

exec python /app/http-proxy-supervisor.py
