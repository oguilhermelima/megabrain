#!/usr/bin/env bash

set -euo pipefail

root="${MEGABRAIN_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-agent-exit-report.XXXXXX")"
host_records_mode=missing

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

assert_not_equal() {
  [ "$1" != "$2" ] || fail "expected values to differ, both were '$1'"
}

export MEGABRAIN_STATE_DIR="$state_dir"
export SUPERSET_TERMINAL_ID=parent-terminal
unset TMUX TMUX_PANE ORCA_TERMINAL_HANDLE

source "$root/lib/common.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"

megabrain_require_command() {
  case "$1" in
    orca|tmux) return 0 ;;
    *) return 1 ;;
  esac
}

megabrain_superset_available() {
  return 0
}

megabrain_superset() {
  [ "${1:-}" = terminals ] && [ "${2:-}" = list ] || return 1
  if [ "$host_records_mode" = invalid ]; then
    printf '%s\n' 'not json'
  else
    printf '%s\n' '{"sessions":[]}'
  fi
}

orca() {
  [ "${1:-}" = terminal ] && [ "${2:-}" = list ] || return 1
  if [ "$host_records_mode" = invalid ]; then
    printf '%s\n' 'not json'
  else
    printf '%s\n' '{"result":{"terminals":[]}}'
  fi
}

create_dispatch() {
  local dispatch_id="$1" host="$2" runtime="$3" terminal_id="$4"
  local tmux_session='' tmux_pane=''
  if [ "$runtime" = tmux ]; then
    tmux_session="megabrain-agent-exit-report-missing-$$"
    tmux_pane='%missing'
  fi
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal "$host" "$host" workspace-test \
    "$terminal_id" "$root" main codex label running gpt-5 true codex "$tmux_session" \
    "$tmux_pane" "$runtime" "$runtime" >/dev/null
}

assert_exit_record() {
  local dispatch_id="$1" meta
  meta="$(cat "$MEGABRAIN_DISPATCH_DIR/$dispatch_id/meta.json")"
  assert_equal "$(jq -r '.state' <<<"$meta")" running
  assert_equal "$(jq -r '.processState' <<<"$meta")" exited
  assert_equal "$(jq -r '.terminalState' <<<"$meta")" missing
  assert_equal "$(jq -r '.stage' <<<"$meta")" agent-exit
  assert_equal "$(jq -r '.reason' <<<"$meta")" 'agent exited without reporting'
  assert_equal "$(jq -r '.reconcileOutcome' <<<"$meta")" agent-exited
  assert_equal "$(jq -r '.failureCount' <<<"$meta")" 0
}

scenario_missing_terminal_records_exit() {
  local dispatch_id="$1" host="$2" runtime="$3"
  create_dispatch "$dispatch_id" "$host" "$runtime" "$dispatch_id-terminal"
  megabrain_dispatch_reconcile_one "$dispatch_id"
  assert_exit_record "$dispatch_id"
  printf 'proven terminal death records an exit without reporting\n'
}

scenario_missing_terminal_is_idempotent() {
  create_dispatch duplicate tmux tmux duplicate-terminal
  megabrain_dispatch_reconcile_one duplicate
  first_meta="$(cat "$MEGABRAIN_DISPATCH_DIR/duplicate/meta.json")"
  megabrain_dispatch_reconcile_one duplicate
  second_meta="$(cat "$MEGABRAIN_DISPATCH_DIR/duplicate/meta.json")"
  assert_equal "$first_meta" "$second_meta"
  printf 'repeated terminal death observation is idempotent\n'
}

scenario_unproven_terminal_stays_unknown() {
  host_records_mode=invalid
  create_dispatch unproven superset host unproven-terminal
  megabrain_dispatch_reconcile_one unproven
  meta="$(cat "$MEGABRAIN_DISPATCH_DIR/unproven/meta.json")"
  assert_equal "$(jq -r '.state' <<<"$meta")" running
  assert_equal "$(jq -r '.processState' <<<"$meta")" running
  assert_equal "$(jq -r '.terminalState' <<<"$meta")" retained
  assert_not_equal "$(jq -r '.reconcileOutcome' <<<"$meta")" agent-exited
  assert_not_equal "$(jq -r '.reason' <<<"$meta")" 'agent exited without reporting'
  printf 'unproven terminal does not record an exit\n'
}

case "${1:-}" in
  '')
    for scenario in missing-tmux missing-superset missing-orca duplicate unproven; do
      bash "$0" "$scenario"
    done
    ;;
  missing-tmux) scenario_missing_terminal_records_exit missing-tmux tmux tmux ;;
  missing-superset) scenario_missing_terminal_records_exit missing-superset superset host ;;
  missing-orca) scenario_missing_terminal_records_exit missing-orca orca host ;;
  duplicate) scenario_missing_terminal_is_idempotent ;;
  unproven) scenario_unproven_terminal_stays_unknown ;;
  *)
    printf 'usage: %s {missing-tmux|missing-superset|missing-orca|duplicate|unproven}\n' "$0" >&2
    exit 2
    ;;
esac
