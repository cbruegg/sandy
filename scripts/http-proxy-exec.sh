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

CA_BUNDLE_PATH="${SANDY_HTTP_PROXY_CA_BUNDLE:-/etc/ssl/ca-bundle.pem}"
if [ -f "$CA_BUNDLE_PATH" ]; then
  export CURL_CA_BUNDLE="$CA_BUNDLE_PATH"
  export GIT_SSL_CAINFO="$CA_BUNDLE_PATH"
  export NODE_EXTRA_CA_CERTS="$CA_BUNDLE_PATH"
  export REQUESTS_CA_BUNDLE="$CA_BUNDLE_PATH"
  export SSL_CERT_FILE="$CA_BUNDLE_PATH"
fi

SANDY_CA_PATH="/etc/pki/trust/anchors/sandy-ca.pem"
if [ -f "$SANDY_CA_PATH" ]; then
  HOMEBREW_CA_BUNDLE="/home/linuxbrew/.linuxbrew/etc/ca-certificates/cert.pem"
  if [ -f "$HOMEBREW_CA_BUNDLE" ] && ! grep -Fq 'Sandy Local HTTP Proxy CA' "$HOMEBREW_CA_BUNDLE"; then
    printf '\n%s\n' '# Sandy Local HTTP Proxy CA' >> "$HOMEBREW_CA_BUNDLE"
    cat "$SANDY_CA_PATH" >> "$HOMEBREW_CA_BUNDLE"
  fi
fi

exec "$@"
