#!/usr/bin/env bash
set -euo pipefail

ROOT="${CPR_TWOFA_ROOT:-/opt/cpr-twofa}"
COMPOSE_FILE="${CPR_TWOFA_COMPOSE:-$ROOT/release/codex-proxy-twofa-worker/ops/compose.yaml}"
COMPOSE_DIR="$(dirname -- "$COMPOSE_FILE")"
BACKUP_DIR="$ROOT/backup/twofa-worker"
IMAGE_FILE="$BACKUP_DIR/previous-image"
ORIGIN_FILE="$BACKUP_DIR/current-origin"
WORKER_CONTAINER="${CPR_TWOFA_WORKER_CONTAINER:-cpr-twofa-worker}"
RS_CONTAINER="${CPR_TWOFA_RS_CONTAINER:-codex-proxy-rs-v380-codex-proxy-rs-1}"

if [[ "${1:-}" == "--check" ]]; then
  [[ -s "$COMPOSE_FILE" && -s "$IMAGE_FILE" && -s "$ORIGIN_FILE" ]]
  bash -n "$ROOT/release/codex-proxy-twofa-worker/ops/deploy.sh"
  bash -n "$COMPOSE_DIR/provision-vault.sh"
  printf '%s\n' 'Rollback inputs verified.'
  exit 0
fi

[[ -s "$IMAGE_FILE" ]] || { printf '%s\n' 'No previous Worker image recorded.' >&2; exit 1; }
IMAGE="$(<"$IMAGE_FILE")"
ORIGIN="${PUBLIC_ORIGIN:-$(<"$ORIGIN_FILE")}"
case "$IMAGE" in
  *@sha256:* ) ;;
  *) printf '%s\n' 'Previous Worker image is not digest-pinned.' >&2; exit 1 ;;
esac
export WORKER_IMAGE="$IMAGE"
export PUBLIC_ORIGIN="$ORIGIN"
export CPR_TWOFA_ROOT="$ROOT"
export CPR_TWOFA_RS_CONTAINER="$RS_CONTAINER"
docker pull "$IMAGE"

if docker inspect "$WORKER_CONTAINER" >/dev/null 2>&1; then
  docker rm -f "$WORKER_CONTAINER" >/dev/null
fi
docker compose -p cpr-twofa -f "$COMPOSE_FILE" up -d --no-build --force-recreate worker

worker_ready() {
  docker exec "$WORKER_CONTAINER" node -e 'fetch("http://127.0.0.1:28082/health").then(async response => { const body = await response.text(); if (!response.ok || !body.includes(`"ready":true`)) process.exit(1) }).catch(() => process.exit(1))'

  local network_mode target worker_pid target_pid worker_ns target_ns
  network_mode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$WORKER_CONTAINER")"
  case "$network_mode" in
    container:*)
      target="${network_mode#container:}"
      worker_pid="$(docker inspect -f '{{.State.Pid}}' "$WORKER_CONTAINER")"
      target_pid="$(docker inspect -f '{{.State.Pid}}' "$target")"
      worker_ns="$(readlink "/proc/$worker_pid/ns/net")"
      target_ns="$(readlink "/proc/$target_pid/ns/net")"
      [[ -n "$worker_ns" && "$worker_ns" == "$target_ns" ]]
      ;;
  esac
}

for _ in $(seq 1 45); do
  if worker_ready; then
    cp -p "$BACKUP_DIR/current-image" "$BACKUP_DIR/failed-image" 2>/dev/null || true
    printf '%s\n' "$IMAGE" > "$BACKUP_DIR/current-image"
    printf '%s\n' 'Companion Worker rolled back.'
    exit 0
  fi
  sleep 2
done
printf '%s\n' 'Rollback Worker did not become ready.' >&2
exit 1
