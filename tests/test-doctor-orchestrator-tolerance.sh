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

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "expected '$1' not to contain '$2'" ;;
    *) ;;
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

set_runtime_state() {
  local runtime="$1" state="$2"
  case "$runtime:$state" in
    orca:ok)
      fake_orca_available=true
      fake_orca_healthy=true
      ;;
    orca:misconfigured)
      fake_orca_available=true
      fake_orca_healthy=false
      ;;
    orca:missing)
      fake_orca_available=false
      fake_orca_healthy=false
      ;;
    superset:ok)
      fake_superset_available=true
      fake_superset_healthy=true
      ;;
    superset:misconfigured)
      fake_superset_available=true
      fake_superset_healthy=false
      ;;
    superset:missing)
      fake_superset_available=false
      fake_superset_healthy=false
      ;;
    tmux:ok)
      fake_tmux_runtime=true
      ;;
    tmux:missing)
      fake_tmux_runtime=false
      ;;
    *) fail "unknown runtime state: $runtime $state" ;;
  esac
}

runtime_is_usable() {
  [ "$2" = ok ]
}

assert_reason_matches_states() {
  local orca_state="$1" superset_state="$2" tmux_state="$3" runtime state
  for runtime in orca superset tmux; do
    case "$runtime" in
      orca) state="$orca_state" ;;
      superset) state="$superset_state" ;;
      tmux) state="$tmux_state" ;;
    esac
    if runtime_is_usable "$runtime" "$state"; then
      assert_contains "$MODULE_REASON" "$runtime"
      assert_not_contains "$MODULE_REASON" "$runtime CLI is not on PATH"
      assert_not_contains "$MODULE_REASON" "$runtime status --json failed"
      assert_not_contains "$MODULE_REASON" "$runtime workspaces list --json failed"
    fi
  done
}

expect_scenario() {
  local orca_state="$1" superset_state="$2" tmux_state="$3"
  local name expected_rc expected_status expected_reason runtime
  fake_orca_available=false
  fake_orca_healthy=false
  fake_superset_available=false
  fake_superset_healthy=false
  fake_tmux_runtime=false
  set_runtime_state orca "$orca_state"
  set_runtime_state superset "$superset_state"
  set_runtime_state tmux "$tmux_state"

  expected_rc=1
  expected_status=missing
  expected_reason=missing
  for runtime in orca superset tmux; do
    case "$runtime" in
      orca) state="$orca_state" ;;
      superset) state="$superset_state" ;;
      tmux) state="$tmux_state" ;;
    esac
    if runtime_is_usable "$runtime" "$state"; then
      expected_rc=0
      expected_status=ok
      expected_reason=optional
      break
    fi
    [ "$state" = misconfigured ] && expected_status=misconfigured && expected_reason=failed
  done

  name="orca-${orca_state}-superset-${superset_state}-tmux-${tmux_state}"
  expect_doctor "$name" "$expected_rc" "$expected_status" "$expected_reason"
  assert_reason_matches_states "$orca_state" "$superset_state" "$tmux_state"
}

for orca_state in ok misconfigured missing; do
  for superset_state in ok misconfigured missing; do
    for tmux_state in ok missing; do
      expect_scenario "$orca_state" "$superset_state" "$tmux_state"
    done
  done
done

printf 'ok: orchestration doctor tolerates an unusable alternate host\n'
