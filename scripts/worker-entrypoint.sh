#!/bin/sh
set -eu

if [ -d /run/sandy-codex-seed ]; then
  mkdir -p /root/.codex
  cp -R /run/sandy-codex-seed/. /root/.codex
fi

exec bun dist/entrypoint-worker.js
