#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

echo "=== Stopping running Sandy containers ==="
docker ps -q --filter name=^sandy | xargs -r docker stop

echo "=== Building Docker Worker ==="
docker build --provenance=false --target worker-runtime -t sandy-subagent:latest .

echo "=== Building Docker MCP Proxy ==="
docker build --provenance=false --target mcp-proxy-runtime -t sandy-mcp-proxy:latest .

echo "=== Building Docker NetGuard ==="
docker build --provenance=false --target network-guard-runtime -t sandy-network-guard:latest .

echo "=== Building Docker HTTP Proxy ==="
docker build --provenance=false --target http-proxy-runtime -t sandy-http-proxy:latest .

echo "=== Done ==="
