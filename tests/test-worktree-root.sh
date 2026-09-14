#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-root.XXXXXX")"

cleanup() {
  rm -rf "$work_dir"
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

export HOME="$work_dir/home"
export MEGABRAIN_STATE_DIR="$work_dir/state"
source "$root/lib/common.sh"
source "$root/lib/module-worktree.sh"

fixture_host=unknown
superset_available=true
superset_root="$work_dir/superset-root"
superset_calls_file="$work_dir/superset-calls"

megabrain_context_detect() {
  printf '%s\n' "$fixture_host"
}

megabrain_superset_available() {
  [ "$superset_available" = true ]
}

megabrain_superset() {
  printf '%s\n' "$*" >>"$superset_calls_file"
  case "${1:-}:${2:-}" in
    settings:get)
      printf '%s\n' "$superset_root"
      ;;
    settings:set)
      printf '%s\n' "$2" >"$work_dir/superset-setting"
      ;;
    *)
      return 1
      ;;
  esac
}

reset_fixture() {
  rm -rf "$MEGABRAIN_STATE_DIR" "$work_dir/superset-setting"
  mkdir -p "$MEGABRAIN_STATE_DIR"
  fixture_host=unknown
  superset_available=true
  : >"$superset_calls_file"
}

scenario_superset_host_uses_configured_root() {
  local output
  reset_fixture
  fixture_host=superset
  output="$(megabrain_worktree_root --read-only)"
  assert_equal "$output" "$superset_root"
  assert_equal "$(wc -l <"$superset_calls_file" | tr -d ' ')" 1
  printf 'Superset host uses its configured root\n'
}

scenario_orca_host_uses_own_root_without_superset() {
  local output
  reset_fixture
  fixture_host=orca
  superset_available=false
  printf '%s\n' "$work_dir/orca-root" >"$MEGABRAIN_STATE_DIR/worktree-root"
  output="$(megabrain_worktree_root --read-only)"
  assert_equal "$output" "$work_dir/orca-root"
  assert_equal "$(wc -l <"$superset_calls_file" | tr -d ' ')" 0
  printf 'Orca host uses the persisted megabrain root without Superset\n'
}

scenario_unconfigured_host_names_itself() {
  local output
  reset_fixture
  fixture_host=tmux
  superset_available=false
  if output="$(megabrain_worktree_root --read-only 2>&1)"; then
    fail 'an unconfigured host unexpectedly resolved a root'
  fi
  assert_contains "$output" 'tmux'
  printf 'an unconfigured host gets an actionable host-specific error\n'
}

scenario_repeated_resolution_is_stable() {
  local first second
  reset_fixture
  fixture_host=orca
  superset_available=false
  printf '%s\n' "$work_dir/stable-root" >"$MEGABRAIN_STATE_DIR/worktree-root"
  first="$(megabrain_worktree_root --read-only)"
  second="$(megabrain_worktree_root --read-only)"
  assert_equal "$first" "$second"
  printf 'repeated root resolution is stable\n'
}

scenario_superset_host_uses_configured_root
scenario_orca_host_uses_own_root_without_superset
scenario_unconfigured_host_names_itself
scenario_repeated_resolution_is_stable
printf 'ok: worktree root resolution scenarios\n'
