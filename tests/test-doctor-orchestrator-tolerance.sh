#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-doctor-tolerance.XXXXXX")"

cleanup() {
  rm -rf "$state_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$1' to contain '$2'" ;;
  esac
}

export MEGABRAIN_STATE_DIR="$state_dir"
source "$root/lib/common.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-install.sh"

fake_orca_available=false
fake_orca_healthy=false
fake_superset_available=false
fake_superset_healthy=false
fake_tmux_runtime=false

megabrain_dispatch_health_counts() {
  MODULE_UNCERTAIN_DISPATCHES=0
  MODULE_RETAINED_TERMINALS=0
  MODULE_LEAKED_DISPATCH_SESSIONS=0
  MODULE_PRUNABLE_DISPATCHES=0
  MODULE_UNCERTAIN_REASONS='[]'
  MODULE_RETAINED_REASONS='[]'
}

megabrain_require_command() {
  [ "$1" = orca ] && [ "$fake_orca_available" = true ]
}

orca() {
  [ "$fake_orca_healthy" = true ]
}

megabrain_superset_available() {
  [ "$fake_superset_available" = true ]
}

megabrain_superset() {
  [ "$fake_superset_healthy" = true ]
}

megabrain_runtime_enabled() {
  [ "$fake_tmux_runtime" = true ]
}

megabrain_tmux_available() {
  [ "$fake_tmux_runtime" = true ]
}

expect_doctor() {
  local name="$1" expected_rc="$2" expected_status="$3" expected_reason="$4" output_file output rc
  output_file="$state_dir/$name.out"
  if module_orchestration_doctor >"$output_file" 2>&1; then
    rc=0
  else
    rc=$?
  fi
  output="$(cat "$output_file")"
  [ "$rc" -eq "$expected_rc" ] || fail "$name returned $rc, expected $expected_rc: $output"
  assert_equal "$MODULE_STATUS" "$expected_status"
  assert_contains "$MODULE_REASON" "$expected_reason"
  printf '%s\n' "$name"
}

fake_superset_available=false
fake_tmux_runtime=true
expect_doctor 'absent superset with tmux fallback is optional' 0 ok optional

fake_superset_available=true
fake_superset_healthy=false
expect_doctor 'unusable superset with tmux fallback is optional' 0 ok optional

fake_tmux_runtime=false
expect_doctor 'unusable superset without fallback is misconfigured' 1 misconfigured failed

fake_orca_available=true
fake_orca_healthy=false
fake_superset_healthy=true
expect_doctor 'unusable orca with healthy superset is optional' 0 ok optional

printf 'ok: orchestration doctor tolerates an unusable alternate host\n'
