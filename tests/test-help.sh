#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-help.XXXXXX")"

cleanup() {
  local rc=$?
  rm -rf "$state_dir"
  return "$rc"
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir/state"

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

mkdir -p "$MEGABRAIN_STATE_DIR/dispatches/finished/messages"
printf '%s\n' '{"type":"done","text":"finished"}' >"$MEGABRAIN_STATE_DIR/dispatches/finished/messages/0001.json"

installer_fixture="$state_dir/install.sh"
cp "$root/install.sh" "$installer_fixture"
before="$(find "$state_dir" -type f -exec shasum {} \; | sort)"

run_help() {
  local output status
  if output="$($root/megabrain "$@" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  assert_equal "$status" 0
  assert_contains "$output" 'Usage: megabrain'
  printf '%s\n' "$*"
  printf '%s\n' "$output"
}

run_help --help
run_help install --help
run_help doctor --help
run_help context --help
run_help worktree --help
run_help worktree create --help
run_help worktree finish --help
run_help worktree list --help
run_help worktree adopt --help
run_help terminal --help
run_help terminal create --help
run_help orchestrate --help
run_help orchestrate spawn --help
run_help orchestrate list --help
run_help orchestrate reconcile --help
run_help orchestrate watch --help
run_help orchestrate read --help
run_help orchestrate ack --help
run_help orchestrate reply --help
run_help orchestrate close --help
run_help ask --help
run_help done --help
run_help received --help
run_help check --help
run_help ack --help
run_help chain --help
run_help chain list --help
run_help chain limits --help
run_help chain add --help
run_help chain edit --help
run_help chain delete --help
run_help chain repair --help
run_help chain run --help
run_help model --help
run_help model list --help
run_help model add --help
run_help model refresh --help
run_help fact --help
run_help fact list --help
run_help fact add --help
run_help fact edit --help
run_help fact remove --help
run_help native --help
run_help native appium --help
run_help native appium start --help
run_help native appium stop --help
run_help native appium status --help
run_help native sim --help
run_help native sim list --help
run_help native sim ensure --help
run_help native app --help
run_help native app reload --help
run_help native build --help
run_help tv --help
run_help tv connect --help
run_help tv disconnect --help
run_help tmux --help
run_help tmux tune --help
run_help tmux wrapper --help

install_output="$("$installer_fixture" --help 2>&1)"
assert_contains "$install_output" 'Usage:'
assert_equal "$(find "$state_dir" -type f -exec shasum {} \; | sort)" "$before"
printf 'help exits successfully without changing dispatch state\n'

printf 'ok: every documented command and subcommand has side-effect-free help\n'
