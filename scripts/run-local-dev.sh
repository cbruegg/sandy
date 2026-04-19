#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODE="${1:-local_test}"

cd "${REPO_ROOT}"

# provenance=false is required to avoid a new container SHA being generated on every build, which would result in
# Worker images being rebuilt with preinstalled tools on every run, even if there were no changes to the Worker code.
docker build --provenance=false --target worker-runtime -t sandy-subagent:latest .
docker build --provenance=false --target mcp-proxy-runtime -t sandy-mcp-proxy:latest .
docker build --provenance=false --target network-guard-runtime -t sandy-network-guard:latest .

if [[ "${MODE}" == "--channel" ]]; then
  MODE="${2:-local_test}"
fi

if [[ "${MODE}" == "telegram" || "${MODE}" == "matrix" ]]; then
  exec env SANDY_CONFIG_FILE=config/config.toml bun start
fi

if [[ "${MODE}" != "local_test" ]]; then
  echo "Unsupported run-local-dev mode: ${MODE}" >&2
  exit 1
fi

RUNTIME_ROOT="$(mktemp -d /tmp/sandy-local-test-XXXXXX)"
SPOOL_ROOT="${RUNTIME_ROOT}/spool"
RUNTIME_CONFIG_PATH="${RUNTIME_ROOT}/config.toml"
DERIVED_CONFIG_PATH="${RUNTIME_ROOT}/config.local-test.toml"

cp -R config/. "${RUNTIME_ROOT}/"
mkdir -p "${SPOOL_ROOT}/inbox" "${SPOOL_ROOT}/inbox-processed" "${SPOOL_ROOT}/outbox"
bun ./scripts/render-local-test-config.mjs "${RUNTIME_CONFIG_PATH}" "${DERIVED_CONFIG_PATH}" "${SPOOL_ROOT}"

echo "Sandy local-test runtime root: ${RUNTIME_ROOT}"
echo "Derived config: ${DERIVED_CONFIG_PATH}"
echo "Inbox: ${SPOOL_ROOT}/inbox"
echo "Outbox: ${SPOOL_ROOT}/outbox"
echo "Local-test chat id: local-test"
echo "Helper CLI example: bun run start:local-test -- send --spool-root ${SPOOL_ROOT} --text \"hello\""

exec env SANDY_CONFIG_FILE="${DERIVED_CONFIG_PATH}" bun start
