#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-prompt-state.XXXXXX")"
dispatch_dir="$state_dir/dispatches"

cleanup() {
  rm -rf "$state_dir"
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
export MEGABRAIN_ROOT="$root"

failures=0

fail_test() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

assert_equal() {
  if [ "$1" != "$2" ]; then
    fail_test "expected '$2', got '$1'"
  fi
}

# megabrain_launch_agent (lib/module-worktree.sh) no longer exists anywhere in lib/*.sh — Phase 6/7
# of the spawn migration (issue 45) replaced it outright with executeSpawn
# (src/cli/commands/orchestrate-spawn.ts), reachable only through `orchestrate spawn`. The
# scenarios this file used to drive through megabrain_launch_agent directly (a successful launch
# publishing/transporting a prompt while receipt is pending, a transcript-pipe failure, a genuine
# prompt-transport failure that cleans up the pane) are dropped, rule 3: they exercised a deleted
# shell function with fakes for tmux/superset that a compiled binary spawn would never see (Bun
# subprocess calls don't see bash function overrides). The same behaviour is covered in
# TypeScript by tests/unit/spawn.test.ts — "returns success while receipt is pending and points to
# reconcile", "reports the host call and detail when prompt transport fails without leaking the
# prompt", "reports cleanup failure alongside the primary host command failure", and the tmux
# readiness/pipe tests under describe("executeSpawn").

# Fixture built directly with jq: no lib/ sourcing, no shell helper functions.
create_host_dispatch() {
  local dispatch_id="$1" state="$2" dir="$dispatch_dir/$1"
  mkdir -p "$dir/messages" "$dir/deliveries"
  jq -n --arg dispatchId "$dispatch_id" --arg worktreePath "$root" --arg state "$state" '{
    dispatchId: $dispatchId, parentSessionId: "parent-terminal", parentHost: "superset",
    childHost: "orca", workspaceId: "workspace-test", terminalId: "child-terminal",
    worktreePath: $worktreePath, branch: "main", agent: "codex", agentId: "codex",
    model: "gpt-5", modelHonored: true, label: "label", state: $state,
    runtime: "host", spawnRuntime: "ide",
    createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z"
  }' >"$dir/meta.json"
}

append_child_message() {
  local dispatch_id="$1" type="$2" text="$3" dir="$dispatch_dir/$1"
  jq -n --arg type "$type" --arg text "$text" '{seq: 1, from: "child", type: $type, text: $text, createdAt: "2020-01-01T00:00:00Z", sessionId: "child-terminal"}' \
    >"$dir/messages/0001-child-$type.json"
}

run_child_message() (
  local dispatch_id="$1" type="$2" text="$3"
  export ORCA_TERMINAL_HANDLE=child-terminal
  unset SUPERSET_TERMINAL_ID TMUX TMUX_PANE
  export MEGABRAIN_DISPATCH_ID="$dispatch_id"
  if [ "$type" = received ]; then
    "$root/.build/megabrain" "$type"
  else
    "$root/.build/megabrain" "$type" "$text"
  fi
)

# `orchestrate reconcile` still carries syncPromptReceipt (src/cli/commands/orchestrate-stop-
# reconcile.ts): a child "received" message promotes promptReceipt/promptState/promptDelivery
# regardless of dispatch state. megabrain_dispatch_reconcile_one (the shell equivalent) has no
# production caller left (orchestrate reconcile execs the binary unconditionally), so this drives
# the binary instead.
create_host_dispatch reconcile-receipt spawning
append_child_message reconcile-receipt received 'prompt received'
reconcile_result="$(MEGABRAIN_STATE_DIR="$state_dir" "$root/.build/megabrain" orchestrate reconcile reconcile-receipt --json)"
assert_equal "$(printf '%s' "$reconcile_result" | jq -r '.promptReceipt')" received
assert_equal "$(printf '%s' "$reconcile_result" | jq -r '.promptState')" confirmed
assert_equal "$(printf '%s' "$reconcile_result" | jq -r '.promptDelivery')" delivered
assert_equal "$(printf '%s' "$reconcile_result" | jq -r '.promptDelivered')" true
printf 'reconcile records a later child receipt\n'

late_dispatch=late-receipt
create_host_dispatch "$late_dispatch" spawning
late_output="$(run_child_message "$late_dispatch" received 'prompt received')" || fail_test 'late receipt was rejected'
assert_equal "$late_output" "received sent: $late_dispatch"
assert_equal "$(jq -r '.promptReceipt' "$dispatch_dir/$late_dispatch/meta.json")" received
assert_equal "$(jq -r '.promptState' "$dispatch_dir/$late_dispatch/meta.json")" confirmed
assert_equal "$(jq -r '.state' "$dispatch_dir/$late_dispatch/meta.json")" running
printf 'late child receipt is honored and advances spawning\n'

done_output="$(run_child_message "$late_dispatch" done 'late completion')" || fail_test 'done after a late receipt was rejected'
assert_equal "$done_output" "done sent: $late_dispatch"
assert_equal "$(jq -r '.state' "$dispatch_dir/$late_dispatch/meta.json")" done
printf 'done after a late receipt follows the transition table\n'

closed_dispatch=closed-receipt
create_host_dispatch "$closed_dispatch" closed
closed_output="$(run_child_message "$closed_dispatch" received 'receipt after close')" || fail_test 'receipt for a closed dispatch crashed'
assert_equal "$closed_output" "received sent: $closed_dispatch"
assert_equal "$(jq -r '.promptReceipt' "$dispatch_dir/$closed_dispatch/meta.json")" received
assert_equal "$(jq -r '.state' "$dispatch_dir/$closed_dispatch/meta.json")" closed
printf 'receipt after close is recorded without reopening the dispatch\n'

failed_dispatch=failed-receipt
create_host_dispatch "$failed_dispatch" failed
failed_output="$(run_child_message "$failed_dispatch" received 'receipt after failure')" || fail_test 'receipt for a failed dispatch crashed'
assert_equal "$failed_output" "received sent: $failed_dispatch"
assert_equal "$(jq -r '.promptReceipt' "$dispatch_dir/$failed_dispatch/meta.json")" received
assert_equal "$(jq -r '.state' "$dispatch_dir/$failed_dispatch/meta.json")" failed
printf 'receipt after failure is recorded without reopening the dispatch\n'

if [ "$failures" -gt 0 ]; then
  printf '%s prompt-state assertions failed\n' "$failures" >&2
  exit 1
fi
printf 'ok: prompt receipt reconciliation and post-terminal-state handling\n'
