#!/bin/sh
set -eu

SOURCE_DIR="${MITMPROXY_CONFDIR:-/run/sandy-mitmproxy-conf}"
WRITABLE_DIR="/tmp/sandy-mitmproxy-conf"

mkdir -p "$WRITABLE_DIR"
cp -r "$SOURCE_DIR"/. "$WRITABLE_DIR"

export MITMPROXY_CONFDIR="$WRITABLE_DIR"

exec python /app/http-proxy-supervisor.py
