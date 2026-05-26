#!/usr/bin/env bash
# Integration test: verify that containers watching a Sandy heartbeat file
# self-terminate when the heartbeat stops being refreshed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CONTROL_ROOT="$(mktemp -d /tmp/sandy-hb-test-XXXXXX)"
CONTROL_DIR="${CONTROL_ROOT}/.sandy-control/bundle-hb-test"
HEARTBEAT_FILE="${CONTROL_DIR}/heartbeat"
CONTAINER_NAME="sandy-hb-test-$(date +%s)"
PASSED=0
FAILED=0

cleanup() {
  docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
  rm -rf "${CONTROL_ROOT}" 2>/dev/null || true
}
trap cleanup EXIT

pass()  { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail()  { echo "  FAIL: $1"; FAILED=$((FAILED + 1)); }

echo "=== Sandy Heartbeat Self-Exit Integration Test ==="
echo "Control root: ${CONTROL_ROOT}"

# ---- Setup ----
mkdir -p "${CONTROL_DIR}"
echo "$(date +%s)" > "${HEARTBEAT_FILE}"

echo ""
echo "--- Test 1: Worker container exits when heartbeat goes stale ---"

# Launch a worker container with the heartbeat mount
docker run -d --rm \
  --name "${CONTAINER_NAME}" \
  -v "${CONTROL_DIR}:/run/sandy-controller:ro" \
  -e "SANDY_CONTROLLER_HEARTBEAT_PATH=/run/sandy-controller/heartbeat" \
  -e "SANDY_CONTROLLER_HEARTBEAT_TIMEOUT_MS=15000" \
  alpine:latest \
  sh -c '
    HEARTBEAT_PATH="${SANDY_CONTROLLER_HEARTBEAT_PATH}"
    TIMEOUT_MS="${SANDY_CONTROLLER_HEARTBEAT_TIMEOUT_MS:-15000}"
    TIMEOUT_S=$(( (TIMEOUT_MS + 999) / 1000 ))
    POLL_INTERVAL=$(( TIMEOUT_S / 2 ))
    if [ "$POLL_INTERVAL" -lt 2 ]; then POLL_INTERVAL=2; fi
    while true; do
      sleep "$POLL_INTERVAL"
      if [ ! -f "$HEARTBEAT_PATH" ]; then
        echo "heartbeat_missing" >&2
        exit 1
      fi
      NOW=$(date +%s)
      MTIME=$(stat -c %Y "$HEARTBEAT_PATH" 2>/dev/null || echo 0)
      AGE=$(( NOW - MTIME ))
      if [ "$AGE" -gt "$TIMEOUT_S" ]; then
        echo "heartbeat_stale age=${AGE}s timeout=${TIMEOUT_S}s" >&2
        exit 1
      fi
    done
  '

# Verify container is running
sleep 2
if docker ps -q --filter "name=${CONTAINER_NAME}" | grep -q .; then
  pass "Container started and running"
else
  fail "Container failed to start"
  exit 1
fi

# Refresh heartbeat a few times (simulating controller alive)
for i in $(seq 1 3); do
  sleep 3
  echo "$(date +%s)" > "${HEARTBEAT_FILE}"
  echo "  Heartbeat refreshed (tick $i)"
done

# Verify container is still running after heartbeat refreshes
if docker ps -q --filter "name=${CONTAINER_NAME}" | grep -q .; then
  pass "Container still running while heartbeat is fresh"
else
  fail "Container exited prematurely while heartbeat was fresh"
  exit 1
fi

# Stop refreshing the heartbeat (simulating controller crash)
echo "  Stopping heartbeat refreshes (simulating controller crash)..."

# Now wait for the container to self-terminate. With 15s timeout and 7.5s poll
# interval, it should exit within ~23 seconds (worst case: poll starts right
# after a refresh, waits 7.5s, then detects 15s stale).
MAX_WAIT=40
START_WAIT=$(date +%s)
EXITED=0

while true; do
  ELAPSED=$(( $(date +%s) - START_WAIT ))
  if ! docker ps -q --filter "name=${CONTAINER_NAME}" | grep -q .; then
    EXITED=1
    echo "  Container self-terminated after ${ELAPSED}s"
    break
  fi
  if [ "$ELAPSED" -gt "$MAX_WAIT" ]; then
    break
  fi
  sleep 2
done

if [ "$EXITED" -eq 1 ]; then
  pass "Container self-terminated within ${MAX_WAIT}s after heartbeat stopped"
else
  fail "Container did NOT self-terminate within ${MAX_WAIT}s"
  docker logs "${CONTAINER_NAME}" 2>&1 || true
fi

echo ""
echo "--- Test 2: Worker container exits when heartbeat file is removed ---"

CONTROL_DIR2="${CONTROL_ROOT}/.sandy-control/bundle-hb-test2"
HEARTBEAT_FILE2="${CONTROL_DIR2}/heartbeat"
CONTAINER_NAME2="sandy-hb-test2-$(date +%s)"

mkdir -p "${CONTROL_DIR2}"
echo "$(date +%s)" > "${HEARTBEAT_FILE2}"

docker run -d --rm \
  --name "${CONTAINER_NAME2}" \
  -v "${CONTROL_DIR2}:/run/sandy-controller:ro" \
  -e "SANDY_CONTROLLER_HEARTBEAT_PATH=/run/sandy-controller/heartbeat" \
  -e "SANDY_CONTROLLER_HEARTBEAT_TIMEOUT_MS=10000" \
  alpine:latest \
  sh -c '
    HEARTBEAT_PATH="${SANDY_CONTROLLER_HEARTBEAT_PATH}"
    TIMEOUT_MS="${SANDY_CONTROLLER_HEARTBEAT_TIMEOUT_MS:-10000}"
    TIMEOUT_S=$(( (TIMEOUT_MS + 999) / 1000 ))
    POLL_INTERVAL=$(( TIMEOUT_S / 2 ))
    if [ "$POLL_INTERVAL" -lt 2 ]; then POLL_INTERVAL=2; fi
    while true; do
      sleep "$POLL_INTERVAL"
      if [ ! -f "$HEARTBEAT_PATH" ]; then
        echo "heartbeat_missing" >&2
        exit 1
      fi
      NOW=$(date +%s)
      MTIME=$(stat -c %Y "$HEARTBEAT_PATH" 2>/dev/null || echo 0)
      AGE=$(( NOW - MTIME ))
      if [ "$AGE" -gt "$TIMEOUT_S" ]; then
        echo "heartbeat_stale age=${AGE}s" >&2
        exit 1
      fi
    done
  '

sleep 2
if docker ps -q --filter "name=${CONTAINER_NAME2}" | grep -q .; then
  pass "Second container started and running"
else
  fail "Second container failed to start"
  exit 1
fi

# Remove the entire control directory (simulating what happens when Sandy
# cleans up and another container still needs the heartbeat check)
rm -rf "${CONTROL_DIR2}"

MAX_WAIT=25
START_WAIT=$(date +%s)
EXITED=0

while true; do
  ELAPSED=$(( $(date +%s) - START_WAIT ))
  if ! docker ps -q --filter "name=${CONTAINER_NAME2}" | grep -q .; then
    EXITED=1
    echo "  Container self-terminated after ${ELAPSED}s"
    break
  fi
  if [ "$ELAPSED" -gt "$MAX_WAIT" ]; then
    break
  fi
  sleep 2
done

if [ "$EXITED" -eq 1 ]; then
  pass "Container self-terminated within ${MAX_WAIT}s after control dir removed"
else
  fail "Container did NOT self-terminate within ${MAX_WAIT}s"
  docker logs "${CONTAINER_NAME2}" 2>&1 || true
fi

# Clean up second container
docker rm -f "${CONTAINER_NAME2}" 2>/dev/null || true

echo ""
echo "=== Results: ${PASSED} passed, ${FAILED} failed ==="
if [ "$FAILED" -gt 0 ]; then
  echo "FAIL"
  exit 1
fi
echo "PASS"
