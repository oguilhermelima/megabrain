#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-ack-receipt.XXXXXX")"
export MEGABRAIN_STATE_DIR="$state_dir"
export HOME="$state_dir/home"
mkdir -p "$HOME"
guard_db_state() {
  [ -n "${MEGABRAIN_STATE_DIR:-}" ] || { printf 'FAIL: MEGABRAIN_STATE_DIR is unset\n' >&2; exit 1; }
  case "$MEGABRAIN_STATE_DIR" in "$HOME/.megabrain"|"$HOME/.megabrain/"*) printf 'FAIL: refusing real HOME database\n' >&2; exit 1 ;; esac
}
guard_db_state
dispatch_id=ack-receipt
dispatch_dir="$state_dir/dispatches/$dispatch_id"

cleanup() {
  local rc=$?
  wait 2>/dev/null || true
  rm -rf "$state_dir"
  return "$rc"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Fixture built directly with jq/printf: no lib/ sourcing, no shell helper functions. Only the
# fields check/ack/orchestrate-watch/orchestrate-ack actually read (dispatchId, parentSessionId,
# parentHost, childHost, terminalId, state) need to be real; the rest documents a realistic
# spawn() record.
mkdir -p "$dispatch_dir/messages" "$dispatch_dir/deliveries"
jq -n --arg dispatchId "$dispatch_id" --arg worktreePath "$root" --arg now "$(now)" '{
  dispatchId: $dispatchId, parentSessionId: "parent-terminal", parentHost: "superset",
  parentWorkspaceId: "workspace-test", childHost: "superset", workspaceId: "workspace-test",
  terminalId: "child-terminal", worktreePath: $worktreePath, branch: "main", agent: "codex",
  agentId: "codex", model: "gpt-5", modelHonored: true, label: "label", state: "running",
  runtime: "host", spawnRuntime: "ide", createdAt: $now, updatedAt: $now
}' >"$dispatch_dir/meta.json"

"$root/.build/megabrain" db import "$state_dir" >/dev/null

# The reply is written by a delayed producer so the child really waits on the queue.
(
  sleep 1
  env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=parent-terminal \
    "$root/.build/megabrain" orchestrate reply "$dispatch_id" --text 'answer from coordinator' >/dev/null
) &

child_delivery="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" \
  SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" check --timeout 3 --poll-interval 1 --json)"
assert_equal "$(printf '%s' "$child_delivery" | jq -r '.messages[0].type')" reply
child_delivery_id="$(printf '%s' "$child_delivery" | jq -r '.deliveryId')"
[ -n "$child_delivery_id" ] || fail 'child did not receive a delivery id'

child_ack="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" \
  SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" ack "$child_delivery_id" --json)"
assert_equal "$(printf '%s' "$child_ack" | jq -r '.duplicate')" false
assert_equal "$(MEGABRAIN_STATE_DIR="$state_dir" "$root/.build/megabrain" db show "$dispatch_id" --json | jq '[.messages[] | select(.type == "ack")] | length')" 1

parent_delivery="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" \
  SUPERSET_TERMINAL_ID=parent-terminal "$root/.build/megabrain" orchestrate watch "$dispatch_id" \
  --timeout 1 --poll-interval 1 --wait-mode poll --full --json)"
assert_equal "$(printf '%s' "$parent_delivery" | jq -r '.messages[0].type')" ack
assert_equal "$(printf '%s' "$parent_delivery" | jq -r '.messages[0].text')" "$child_delivery_id"
parent_delivery_id="$(printf '%s' "$parent_delivery" | jq -r '.deliveryId')"

env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=parent-terminal \
  "$root/.build/megabrain" orchestrate ack "$dispatch_id" "$parent_delivery_id" --json >/dev/null

assert_equal "$(MEGABRAIN_STATE_DIR="$state_dir" "$root/.build/megabrain" db show "$dispatch_id" --json | jq '[.messages[] | select(.type == "ack")] | length')" 1
printf 'child reply acknowledgement reaches the coordinator queue without an ack loop\n'
