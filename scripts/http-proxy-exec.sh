#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  printf '%s\n' "Usage: sandy-http-proxy-exec <command> [args...]" >&2
  exit 64
fi

if [ -z "${SANDY_HTTP_PROXY_URL:-}" ]; then
  printf '%s\n' "SANDY_HTTP_PROXY_URL is required." >&2
  exit 78
fi

export HTTP_PROXY="$SANDY_HTTP_PROXY_URL"
export http_proxy="$SANDY_HTTP_PROXY_URL"
export HTTPS_PROXY="$SANDY_HTTP_PROXY_URL"
export https_proxy="$SANDY_HTTP_PROXY_URL"
export NO_PROXY="sandy-mcp-proxy"
export no_proxy="sandy-mcp-proxy"

exec "$@"
