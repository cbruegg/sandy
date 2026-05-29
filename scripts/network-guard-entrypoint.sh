#!/bin/bash
set -euo pipefail

guard_mode="${SANDY_NETWORK_GUARD_MODE:-public_internet_only}"
allow_local_cidrs="${SANDY_NETWORK_GUARD_ALLOWED_LOCAL_CIDRS:-}"
allow_hosts="${SANDY_NETWORK_GUARD_ALLOWED_HOSTS:-}"

readonly ipv4_blocklist=(
  "10.0.0.0/8"
  "100.64.0.0/10"
  "127.0.0.0/8"
  "169.254.0.0/16"
  "172.16.0.0/12"
  "192.168.0.0/16"
  "198.18.0.0/15"
)
readonly ipv6_blocklist=(
  "::1/128"
  "fc00::/7"
  "fe80::/10"
)

trap 'exit 0' TERM INT

split_csv() {
  local raw="$1"
  local -n target_ref="$2"
  target_ref=()
  if [[ -z "${raw}" ]]; then
    return
  fi

  IFS=',' read -r -a target_ref <<< "${raw}"
}

append_unique() {
  local value="$1"
  local -n target_ref="$2"
  local existing
  for existing in "${target_ref[@]}"; do
    if [[ "${existing}" == "${value}" ]]; then
      return
    fi
  done
  target_ref+=("${value}")
}

collect_nameservers() {
  local -n ipv4_ref="$1"
  local -n ipv6_ref="$2"
  local address
  while read -r _ address _; do
    if [[ -z "${address}" ]]; then
      continue
    fi
    if [[ "${address}" == *:* ]]; then
      append_unique "${address}" ipv6_ref
    else
      append_unique "${address}" ipv4_ref
    fi
  done < <(grep '^nameserver[[:space:]]' /etc/resolv.conf || true)
}

resolve_allowed_hosts() {
  local -n ipv4_ref="$1"
  local -n ipv6_ref="$2"
  local raw_hosts=()
  local host
  local resolved

  split_csv "${allow_hosts}" raw_hosts
  for host in "${raw_hosts[@]}"; do
    host="${host//[[:space:]]/}"
    if [[ -z "${host}" ]]; then
      continue
    fi
    while read -r resolved; do
      if [[ -z "${resolved}" ]]; then
        continue
      fi
      if [[ "${resolved}" == *:* ]]; then
        append_unique "${resolved}" ipv6_ref
      else
        append_unique "${resolved}" ipv4_ref
      fi
    done < <(getent hosts "${host}" | awk '{print $1}' || true)
  done
}

collect_allowed_local_cidrs() {
  local -n ipv4_ref="$1"
  local -n ipv6_ref="$2"
  local raw_cidrs=()
  local cidr

  split_csv "${allow_local_cidrs}" raw_cidrs
  for cidr in "${raw_cidrs[@]}"; do
    cidr="${cidr//[[:space:]]/}"
    if [[ -z "${cidr}" ]]; then
      continue
    fi
    if [[ "${cidr}" == *:* ]]; then
      append_unique "${cidr}" ipv6_ref
    else
      append_unique "${cidr}" ipv4_ref
    fi
  done
}

install_family_rules() {
  local cmd="$1"
  shift
  local chain="SANDY-EGRESS"
  local allow_ref_name="$1"
  shift
  local block_ref_name="$1"
  shift
  local -n allow_ref="${allow_ref_name}"
  local -n block_ref="${block_ref_name}"
  local cidr

  "${cmd}" -w -N "${chain}"
  "${cmd}" -w -I OUTPUT 1 -j "${chain}"
  "${cmd}" -w -A "${chain}" -o lo -j ACCEPT

  for cidr in "${allow_ref[@]}"; do
    "${cmd}" -w -A "${chain}" -d "${cidr}" -j ACCEPT
  done

  for cidr in "${block_ref[@]}"; do
    "${cmd}" -w -A "${chain}" -d "${cidr}" -j REJECT
  done

  "${cmd}" -w -A "${chain}" -j RETURN
}

if [[ "${guard_mode}" == "public_internet_only" ]]; then
  ipv4_allow=()
  ipv6_allow=()
  collect_nameservers ipv4_allow ipv6_allow
  resolve_allowed_hosts ipv4_allow ipv6_allow
  collect_allowed_local_cidrs ipv4_allow ipv6_allow
  install_family_rules iptables-nft ipv4_allow ipv4_blocklist
  install_family_rules ip6tables-nft ipv6_allow ipv6_blocklist
fi

echo "ready"

# If a controller heartbeat file is configured, poll it instead of sleeping
# forever. When the file stops being refreshed (host process died), the guard
# exits, which terminates all containers sharing its network namespace.
HEARTBEAT_PATH="${SANDY_CONTROLLER_HEARTBEAT_PATH:-}"
HEARTBEAT_TIMEOUT_MS="${SANDY_CONTROLLER_HEARTBEAT_TIMEOUT_MS:-30000}"

# Convert timeout from ms to seconds (ceiling division).
HEARTBEAT_TIMEOUT_S=$(( (HEARTBEAT_TIMEOUT_MS + 999) / 1000 ))
# Poll at half the timeout, at least every 2 seconds.
POLL_INTERVAL=$(( HEARTBEAT_TIMEOUT_S / 2 ))
if [ "$POLL_INTERVAL" -lt 2 ]; then
  POLL_INTERVAL=2
fi

check_heartbeat() {
  if [ ! -f "$HEARTBEAT_PATH" ]; then
    echo "heartbeat file missing, exiting" >&2
    exit 1
  fi
  # Uses the POSIX-compatible approach: [ file -nt reference ]
  # Create a temp reference file with an mtime of (now - timeout).
  REF_FILE="$(mktemp)"
  touch -d "${HEARTBEAT_TIMEOUT_S} seconds ago" "$REF_FILE" 2>/dev/null || touch -t "$(date -d "${HEARTBEAT_TIMEOUT_S} seconds ago" +%Y%m%d%H%M.%S 2>/dev/null || date -v-${HEARTBEAT_TIMEOUT_S}S +%Y%m%d%H%M.%S)" "$REF_FILE"
  if [ "$HEARTBEAT_PATH" -nt "$REF_FILE" ]; then
    rm -f "$REF_FILE"
    return 0
  fi
  rm -f "$REF_FILE"
  echo "heartbeat stale, exiting" >&2
  return 1
}

if [ -n "$HEARTBEAT_PATH" ]; then
  while true; do
    sleep "$POLL_INTERVAL"
    if ! check_heartbeat; then
      exit 1
    fi
  done
else
  while true; do
    sleep 86400 &
    wait $!
  done
fi
