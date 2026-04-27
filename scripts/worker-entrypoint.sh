#!/bin/sh
set -eu

if [ -d /run/sandy-codex-seed ]; then
  mkdir -p /root/.codex
  cp -R /run/sandy-codex-seed/. /root/.codex
fi

if [ -f /etc/pki/trust/anchors/sandy-ca.pem ]; then
  update-ca-certificates -f

  # Homebrew maintains its own CA bundle; certifi and other Homebrew tools use it.
  # Append the Sandy CA so Homebrew Python tools (yt-dlp, vid2text, …) trust the proxy.
  HOMEBREW_CA_BUNDLE="/home/linuxbrew/.linuxbrew/etc/ca-certificates/cert.pem"
  if [ -f "$HOMEBREW_CA_BUNDLE" ] && ! grep -Fq 'Sandy Local HTTP Proxy CA' "$HOMEBREW_CA_BUNDLE"; then
    printf '\n%s\n' '# Sandy Local HTTP Proxy CA' >> "$HOMEBREW_CA_BUNDLE"
    cat /etc/pki/trust/anchors/sandy-ca.pem >> "$HOMEBREW_CA_BUNDLE"
  fi
fi

exec bun dist/entrypoint-worker.js
