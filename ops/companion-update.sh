#!/usr/bin/env bash
set -euo pipefail

ROOT="${CPR_TWOFA_ROOT:-/opt/cpr-twofa}"
RELEASE_DIR="${CPR_TWOFA_RELEASE_DIR:-$ROOT/release/codex-proxy-twofa-worker}"
BACKUP_DIR="$ROOT/backup/twofa-worker"
export CPR_TWOFA_ROOT="$ROOT" CPR_TWOFA_COMPOSE="$RELEASE_DIR/ops/compose.yaml"
if [[ "${1:-}" == "--rollback" ]]; then
  exec 9>"$ROOT/backup/worker-rebind.lock"
  flock -x 9
  [[ -s "$BACKUP_DIR/previous-release-path" ]] || { printf '%s\n' 'No previous release snapshot recorded.' >&2; exit 1; }
  SNAPSHOT_DIR="$(<"$BACKUP_DIR/previous-release-path")"
  case "$SNAPSHOT_DIR" in "$BACKUP_DIR"/previous-release.*) ;; *) printf '%s\n' 'Invalid previous release path.' >&2; exit 1 ;; esac
  [[ -s "$SNAPSHOT_DIR/ops/compose.yaml" && -f "$SNAPSHOT_DIR/ops/rollback.sh" \
    && -s "$SNAPSHOT_DIR/.worker-image" && -s "$SNAPSHOT_DIR/.public-origin" \
    && -s "$BACKUP_DIR/current-image" && -s "$BACKUP_DIR/current-origin" ]] || {
    printf '%s\n' 'Previous release or current deployment inputs are incomplete.' >&2
    exit 1
  }
  OLD_IMAGE="$(<"$SNAPSHOT_DIR/.worker-image")"
  OLD_ORIGIN="$(<"$SNAPSHOT_DIR/.public-origin")"
  NEW_IMAGE="$(<"$BACKUP_DIR/current-image")"
  NEW_ORIGIN="$(<"$BACKUP_DIR/current-origin")"
  HAD_PREVIOUS_IMAGE=0
  if [[ -f "$BACKUP_DIR/previous-image" ]]; then
    HAD_PREVIOUS_IMAGE=1
    PREVIOUS_IMAGE="$(<"$BACKUP_DIR/previous-image")"
  fi
  restore_previous_image_record() {
    if [[ "$HAD_PREVIOUS_IMAGE" -eq 1 ]]; then
      printf '%s\n' "$PREVIOUS_IMAGE" > "$BACKUP_DIR/previous-image"
    else
      rm -f "$BACKUP_DIR/previous-image"
    fi
  }
  restore_current_worker() {
    WORKER_IMAGE="$NEW_IMAGE" PUBLIC_ORIGIN="$NEW_ORIGIN" CPR_TWOFA_COMPOSE="$RELEASE_DIR/ops/compose.yaml" \
      bash "$RELEASE_DIR/ops/deploy.sh" || return 1
    restore_previous_image_record
  }
  FAILED_RELEASE="$(mktemp -d "$BACKUP_DIR/rolled-back-release.XXXXXX")"
  rmdir "$FAILED_RELEASE"
  printf '%s\n' "$OLD_IMAGE" > "$BACKUP_DIR/previous-image"
  if ! PUBLIC_ORIGIN="$OLD_ORIGIN" CPR_TWOFA_COMPOSE="$SNAPSHOT_DIR/ops/compose.yaml" \
    bash "$SNAPSHOT_DIR/ops/rollback.sh"; then
    printf '%s\n' 'Previous release did not become ready; restoring current Worker.' >&2
    if ! restore_current_worker; then
      printf '%s\n' 'Current Worker restoration also failed.' >&2
    fi
    exit 1
  fi
  if ! mv "$RELEASE_DIR" "$FAILED_RELEASE"; then
    if ! restore_current_worker; then
      printf '%s\n' 'Current Worker restoration failed after release promotion error.' >&2
    fi
    exit 1
  fi
  if ! mv "$SNAPSHOT_DIR" "$RELEASE_DIR"; then
    mv "$FAILED_RELEASE" "$RELEASE_DIR"
    if ! restore_current_worker; then
      printf '%s\n' 'Current Worker restoration failed after release promotion error.' >&2
    fi
    exit 1
  fi
  printf '%s\n' "$OLD_IMAGE" > "$BACKUP_DIR/current-image"
  printf '%s\n' "$OLD_ORIGIN" > "$BACKUP_DIR/current-origin"
  if [[ -f "$RELEASE_DIR/.previous-image" ]]; then
    cp "$RELEASE_DIR/.previous-image" "$BACKUP_DIR/previous-image"
  else
    rm -f "$BACKUP_DIR/previous-image"
  fi
  rm -f "$BACKUP_DIR/previous-release-path"
  if command -v systemctl >/dev/null 2>&1; then
    if [[ -f "$RELEASE_DIR/.legacy-timer-enabled" ]]; then
      if [[ -f "$RELEASE_DIR/.legacy-timer-active" ]]; then
        systemctl enable --now cpr-twofa-rebind-worker.timer
      else
        systemctl enable cpr-twofa-rebind-worker.timer
      fi
    elif [[ -f "$RELEASE_DIR/.legacy-timer-active" ]]; then
      systemctl start cpr-twofa-rebind-worker.timer
    fi
  fi
  printf '%s\n' 'Companion Worker and release rolled back.'
else
  WORKER_IMAGE="${WORKER_IMAGE:?WORKER_IMAGE must be an immutable GHCR image reference}"
  PUBLIC_ORIGIN="${PUBLIC_ORIGIN:?PUBLIC_ORIGIN is required}"
  export WORKER_IMAGE PUBLIC_ORIGIN
  bash "$(dirname -- "$0")/companion-install.sh"
fi
