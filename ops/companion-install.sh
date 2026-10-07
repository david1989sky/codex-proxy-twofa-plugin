#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
ROOT="${CPR_TWOFA_ROOT:-/opt/cpr-twofa}"
RELEASE_DIR="${CPR_TWOFA_RELEASE_DIR:-$ROOT/release/codex-proxy-twofa-worker}"
BACKUP_DIR="$ROOT/backup/twofa-worker"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:?PUBLIC_ORIGIN is required}"
WORKER_IMAGE="${WORKER_IMAGE:?WORKER_IMAGE must be an immutable GHCR image reference}"
RS_CONTAINER="${CPR_TWOFA_RS_CONTAINER:-codex-proxy-rs-v380-codex-proxy-rs-1}"
RS_NETWORK="${CPR_TWOFA_RS_NETWORK:-codex-proxy-rs-v380_default}"
WORKER_CONTAINER="${CPR_TWOFA_WORKER_CONTAINER:-cpr-twofa-worker}"

case "$WORKER_IMAGE" in *@sha256:* ) ;; *) printf '%s\n' 'WORKER_IMAGE must include @sha256.' >&2; exit 1 ;; esac

SOURCE_DIR="${WORKER_SOURCE_DIR:-}"
TEMP_DIR=""
STAGE_DIR=""
SNAPSHOT_DIR=""
OLD_MOVED=0
DEPLOY_STARTED=0
DEPLOY_SUCCEEDED=0
COMPLETE=0
HAD_RELEASE=0
OLD_CONTAINER_ID=""
TIMER_ENABLED=0
TIMER_ACTIVE=0
TIMER_CHANGED=0
OLD_PREVIOUS_IMAGE=""
HAD_PREVIOUS_IMAGE=0
if [[ -z "$SOURCE_DIR" && -n "${WORKER_BUNDLE:-}" ]]; then
  BUNDLE="$WORKER_BUNDLE"
  TEMP_DIR="$(mktemp -d)"
  if ! tar -xzf "$BUNDLE" -C "$TEMP_DIR"; then
    rm -rf "$TEMP_DIR"
    exit 1
  fi
  SOURCE_DIR="$TEMP_DIR/worker"
elif [[ -z "$SOURCE_DIR" ]]; then
  SOURCE_DIR="$SCRIPT_DIR/../worker"
fi

restore_previous_worker() {
  if [[ "$OLD_MOVED" -eq 1 ]]; then
    if [[ -d "$RELEASE_DIR" ]]; then
      local failed_dir
      failed_dir="$(mktemp -d "$BACKUP_DIR/failed-release.XXXXXX")"
      rmdir "$failed_dir"
      mv "$RELEASE_DIR" "$failed_dir"
    fi
    mv "$SNAPSHOT_DIR" "$RELEASE_DIR"
    OLD_MOVED=0
  fi
  printf '%s\n' "$OLD_IMAGE" > "$BACKUP_DIR/previous-image"
  PUBLIC_ORIGIN="$OLD_ORIGIN" CPR_TWOFA_COMPOSE="$RELEASE_DIR/ops/compose.yaml" \
    bash "$RELEASE_DIR/ops/rollback.sh" || return 1
  restore_previous_records
}

restore_previous_records() {
  printf '%s\n' "$OLD_IMAGE" > "$BACKUP_DIR/current-image"
  printf '%s\n' "$OLD_ORIGIN" > "$BACKUP_DIR/current-origin"
  if [[ "$HAD_PREVIOUS_IMAGE" -eq 1 ]]; then
    printf '%s\n' "$OLD_PREVIOUS_IMAGE" > "$BACKUP_DIR/previous-image"
  else
    rm -f "$BACKUP_DIR/previous-image"
  fi
  rm -f "$BACKUP_DIR/current-image.next" "$BACKUP_DIR/current-origin.next"
}

finish() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$COMPLETE" -eq 0 && "$DEPLOY_STARTED" -eq 1 && "$HAD_RELEASE" -eq 1 ]]; then
    local current_id="" current_running=""
    if [[ "$DEPLOY_SUCCEEDED" -eq 0 && -n "$OLD_CONTAINER_ID" ]]; then
      current_id="$(docker inspect -f '{{.Id}}' "$WORKER_CONTAINER" 2>/dev/null || true)"
      current_running="$(docker inspect -f '{{.State.Running}}' "$WORKER_CONTAINER" 2>/dev/null || true)"
    fi
    if [[ -n "$OLD_CONTAINER_ID" && "$current_id" == "$OLD_CONTAINER_ID" && "$current_running" == true ]]; then
      restore_previous_records
    elif ! restore_previous_worker; then
      printf '%s\n' 'Automatic Worker restoration failed; the prior release remains available.' >&2
    fi
  fi
  if [[ "$status" -ne 0 && "$TIMER_CHANGED" -eq 1 ]]; then
    if [[ "$TIMER_ENABLED" -eq 1 ]]; then
      if [[ "$TIMER_ACTIVE" -eq 1 ]]; then
        systemctl enable --now cpr-twofa-rebind-worker.timer || printf '%s\n' 'Could not restore the legacy rebind timer.' >&2
      else
        systemctl enable cpr-twofa-rebind-worker.timer || printf '%s\n' 'Could not restore the legacy rebind timer.' >&2
      fi
    elif [[ "$TIMER_ACTIVE" -eq 1 ]]; then
      systemctl start cpr-twofa-rebind-worker.timer || printf '%s\n' 'Could not restart the legacy rebind timer.' >&2
    fi
  fi
  [[ -z "$STAGE_DIR" || ! -d "$STAGE_DIR" ]] || rm -rf "$STAGE_DIR"
  [[ -z "$TEMP_DIR" || ! -d "$TEMP_DIR" ]] || rm -rf "$TEMP_DIR"
  exit "$status"
}
trap finish EXIT

for file in Dockerfile entrypoint.sh package.json package-lock.json \
  ops/compose.yaml ops/provision-vault.sh ops/deploy.sh ops/rollback.sh; do
  [[ -f "$SOURCE_DIR/$file" ]] || { printf 'Worker bundle is incomplete: %s\n' "$file" >&2; exit 1; }
done

mkdir -p "$(dirname -- "$RELEASE_DIR")" "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
exec 9>"$ROOT/backup/worker-rebind.lock"
flock -x 9

if [[ -d "$RELEASE_DIR" ]]; then
  HAD_RELEASE=1
  [[ -s "$BACKUP_DIR/current-image" && -s "$BACKUP_DIR/current-origin" \
    && -f "$RELEASE_DIR/ops/compose.yaml" && -f "$RELEASE_DIR/ops/rollback.sh" ]] || {
    printf '%s\n' 'Current release or rollback inputs are incomplete.' >&2
    exit 1
  }
  OLD_IMAGE="$(<"$BACKUP_DIR/current-image")"
  OLD_ORIGIN="$(<"$BACKUP_DIR/current-origin")"
  OLD_CONTAINER_ID="$(docker inspect -f '{{.Id}}' "$WORKER_CONTAINER" 2>/dev/null || true)"
  if [[ -f "$BACKUP_DIR/previous-image" ]]; then
    HAD_PREVIOUS_IMAGE=1
    OLD_PREVIOUS_IMAGE="$(<"$BACKUP_DIR/previous-image")"
  fi
fi

STAGE_DIR="$(mktemp -d "$(dirname -- "$RELEASE_DIR")/.worker-stage.XXXXXX")"
mkdir -p "$STAGE_DIR/ops"
cp -p "$SOURCE_DIR/Dockerfile" "$SOURCE_DIR/entrypoint.sh" "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$STAGE_DIR/"
cp -p "$SOURCE_DIR/ops/compose.yaml" "$SOURCE_DIR/ops/provision-vault.sh" "$SOURCE_DIR/ops/deploy.sh" "$SOURCE_DIR/ops/rollback.sh" "$STAGE_DIR/ops/"
chmod 0555 "$STAGE_DIR/entrypoint.sh" "$STAGE_DIR/ops/"*.sh

if [[ "$HAD_RELEASE" -eq 1 ]] && command -v systemctl >/dev/null 2>&1; then
  systemctl is-enabled --quiet cpr-twofa-rebind-worker.timer && TIMER_ENABLED=1 || true
  systemctl is-active --quiet cpr-twofa-rebind-worker.timer && TIMER_ACTIVE=1 || true
  if [[ "$TIMER_ENABLED" -eq 1 || "$TIMER_ACTIVE" -eq 1 ]]; then
    TIMER_CHANGED=1
    systemctl disable --now cpr-twofa-rebind-worker.timer
  fi
fi

export CPR_TWOFA_ROOT="$ROOT" CPR_TWOFA_COMPOSE="$STAGE_DIR/ops/compose.yaml" CPR_TWOFA_RS_CONTAINER="$RS_CONTAINER" CPR_TWOFA_RS_NETWORK="$RS_NETWORK"
export CPR_TWOFA_WORKER_CONTAINER="$WORKER_CONTAINER"
DEPLOY_STARTED=1
bash "$STAGE_DIR/ops/deploy.sh"
DEPLOY_SUCCEEDED=1

if [[ "$HAD_RELEASE" -eq 1 ]]; then
  SNAPSHOT_DIR="$(mktemp -d "$BACKUP_DIR/previous-release.XXXXXX")"
  rmdir "$SNAPSHOT_DIR"
  mv "$RELEASE_DIR" "$SNAPSHOT_DIR"
  OLD_MOVED=1
fi
mv "$STAGE_DIR" "$RELEASE_DIR"
STAGE_DIR=""
if [[ "$HAD_RELEASE" -eq 1 ]]; then
  printf '%s\n' "$OLD_IMAGE" > "$SNAPSHOT_DIR/.worker-image"
  printf '%s\n' "$OLD_ORIGIN" > "$SNAPSHOT_DIR/.public-origin"
  if [[ "$HAD_PREVIOUS_IMAGE" -eq 1 ]]; then
    printf '%s\n' "$OLD_PREVIOUS_IMAGE" > "$SNAPSHOT_DIR/.previous-image"
  fi
  if [[ "$TIMER_ENABLED" -eq 1 ]]; then
    : > "$SNAPSHOT_DIR/.legacy-timer-enabled"
  fi
  if [[ "$TIMER_ACTIVE" -eq 1 ]]; then
    : > "$SNAPSHOT_DIR/.legacy-timer-active"
  fi
  printf '%s\n' "$SNAPSHOT_DIR" > "$BACKUP_DIR/previous-release-path.next"
  mv "$BACKUP_DIR/previous-release-path.next" "$BACKUP_DIR/previous-release-path"
fi
COMPLETE=1
