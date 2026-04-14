#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

# provenance=false is required to avoid a new container SHA being generated on every build, which would result in
# Worker images being rebuilt with preinstalled tools on every run, even if there were no changes to the Worker code.
docker build --provenance=false --target worker-runtime -t sandy-subagent:latest .
docker build --provenance=false --target mcp-proxy-runtime -t sandy-mcp-proxy:latest .

exec env SANDY_CONFIG_FILE=config/config.toml bun start
