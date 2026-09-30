#!/usr/bin/env bash
set -euo pipefail

ROOT="${CPR_TWOFA_ROOT:-/opt/cpr-twofa}"
COMPOSE_FILE="${CPR_TWOFA_COMPOSE:-$ROOT/release/codex-proxy-twofa-worker/ops/compose.yaml}"
COMPOSE_DIR="$(dirname -- "$COMPOSE_FILE")"
BACKUP_DIR="$ROOT/backup/twofa-worker"
IMAGE="${WORKER_IMAGE:?WORKER_IMAGE must be an immutable GHCR image reference}"
ORIGIN="${PUBLIC_ORIGIN:?PUBLIC_ORIGIN is required}"
WORKER_CONTAINER="${CPR_TWOFA_WORKER_CONTAINER:-cpr-twofa-worker}"

case "$IMAGE" in
  *@sha256:* ) ;;
  *) printf '%s\n' 'WORKER_IMAGE must include an immutable @sha256 digest.' >&2; exit 1 ;;
esac
[[ -f "$COMPOSE_FILE" ]] || { printf 'Compose file not found: %s\n' "$COMPOSE_FILE" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

if [[ ! -f "$BACKUP_DIR/compose.yaml" ]]; then
  cp -p "$COMPOSE_FILE" "$BACKUP_DIR/compose.yaml"
fi
if [[ -f "$BACKUP_DIR/current-image" ]]; then
  cp -p "$BACKUP_DIR/current-image" "$BACKUP_DIR/previous-image"
fi
printf '%s\n' "$IMAGE" > "$BACKUP_DIR/current-image.next"
printf '%s\n' "$ORIGIN" > "$BACKUP_DIR/current-origin.next"

export WORKER_IMAGE="$IMAGE"
export PUBLIC_ORIGIN="$ORIGIN"
export CPR_TWOFA_ROOT="$ROOT"

docker pull "$IMAGE"
bash "$COMPOSE_DIR/provision-vault.sh"

# Recreate explicitly so container-network workers bind to the current RS namespace.
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

ready=0
for _ in $(seq 1 45); do
  if worker_ready; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" -ne 1 ]]; then
  printf '%s\n' 'Worker did not become ready; leaving the previous image available for rollback.' >&2
  exit 1
fi

mv "$BACKUP_DIR/current-image.next" "$BACKUP_DIR/current-image"
mv "$BACKUP_DIR/current-origin.next" "$BACKUP_DIR/current-origin"
printf '%s\n' 'Companion Worker is ready.'
