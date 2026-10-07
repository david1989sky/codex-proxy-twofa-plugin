#!/usr/bin/env bash
set -euo pipefail

ROOT="${CPR_TWOFA_ROOT:-/opt/cpr-twofa}"
WORKER_CONTAINER="${CPR_TWOFA_WORKER_CONTAINER:-cpr-twofa-worker}"
RS_CONTAINER="${CPR_TWOFA_RS_CONTAINER:-codex-proxy-rs-v380-codex-proxy-rs-1}"
COMPOSE_FILE="${CPR_TWOFA_COMPOSE:-$ROOT/release/codex-proxy-twofa-worker/ops/compose.yaml}"
COMPOSE_DIR="$(dirname -- "$COMPOSE_FILE")"
LOCK_FILE="$ROOT/backup/worker-rebind.lock"
IMAGE_FILE="$ROOT/backup/twofa-worker/current-image"
ORIGIN_FILE="$ROOT/backup/twofa-worker/current-origin"

mkdir -p "$(dirname -- "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

container_pid() {
  docker inspect -f '{{.State.Pid}}' "$1" 2>/dev/null || true
}

network_namespace() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  readlink "/proc/$pid/ns/net"
}

worker_network_mode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$WORKER_CONTAINER" 2>/dev/null || true)"
if [[ -n "$worker_network_mode" && "$worker_network_mode" != container:* ]]; then
  if [[ "${1:-}" == "--check" ]]; then
    printf 'worker_network_mode=%s\n' "$worker_network_mode"
    printf '%s\n' 'worker_network_binding=stable'
  fi
  exit 0
fi

worker_pid="$(container_pid "$WORKER_CONTAINER")"
rs_pid="$(container_pid "$RS_CONTAINER")"
worker_ns="$(network_namespace "$worker_pid" 2>/dev/null || true)"
rs_ns="$(network_namespace "$rs_pid" 2>/dev/null || true)"

if [[ "${1:-}" == "--check" ]]; then
  printf 'worker_namespace=%s\nrs_namespace=%s\n' "${worker_ns:-unavailable}" "${rs_ns:-unavailable}"
  [[ -n "$worker_ns" && "$worker_ns" == "$rs_ns" ]]
  printf '%s\n' 'worker_network_namespace=match'
  exit 0
fi

[[ -n "$worker_ns" && -n "$rs_ns" ]] || exit 0
[[ "$worker_ns" == "$rs_ns" ]] && exit 0
[[ -s "$IMAGE_FILE" && -s "$ORIGIN_FILE" && -s "$COMPOSE_FILE" ]] || {
  printf '%s\n' 'Worker rebind skipped: deployment inputs are unavailable.' >&2
  exit 1
}

image="$(<"$IMAGE_FILE")"
origin="$(<"$ORIGIN_FILE")"
[[ "$image" =~ @sha256:[a-f0-9]{64}$ ]] || {
  printf '%s\n' 'Worker rebind skipped: current image is not digest-pinned.' >&2
  exit 1
}

printf 'Worker network namespace changed (%s -> %s); recreating Worker.\n' "$worker_ns" "$rs_ns"
WORKER_IMAGE="$image" PUBLIC_ORIGIN="$origin" CPR_TWOFA_ROOT="$ROOT" \
  CPR_TWOFA_RS_CONTAINER="$RS_CONTAINER" \
  bash "$COMPOSE_DIR/deploy.sh"
