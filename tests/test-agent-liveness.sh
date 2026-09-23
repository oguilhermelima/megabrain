#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-agent-liveness.XXXXXX")"
dispatch_dir="$state_dir/state/dispatches"

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

export MEGABRAIN_STATE_DIR="$state_dir/state"
export MEGABRAIN_ROOT="$root"
export SUPERSET_TERMINAL_ID=parent-terminal

# Scenario "retired states in old records normalise to running" is dropped (rule 3): it called
# megabrain_dispatch_meta_read (lib/module-orchestrate.sh) directly, which no longer exists —
# deleted in 7c44a2c "chore(orchestrate): delete shell code orphaned by the hook" while two of its
# callers were left behind uncalled. The behaviour itself is real in the binary, just reachable
# differently: normalizeMetadata (src/cli/commands/orchestrate-prune.ts) normalises a stored
# "stalled"/"timeout" state to "running" on every `orchestrate prune`, including --dry-run, and is
# exercised black-box by the existing tests/test-orchestrate-prune-cli.sh (not touched by this
# lane) — "legacy timeout is normalized to an open state".

# Fixture built directly with jq: no lib/ sourcing.
create_dispatch() {
  local dispatch_id="$1" dir="$dispatch_dir/$1"
  mkdir -p "$dir/messages" "$dir/deliveries"
  jq -n --arg dispatchId "$dispatch_id" --arg worktreePath "$root" '{
    dispatchId: $dispatchId, parentSessionId: "parent-terminal", parentHost: "superset",
    childHost: "superset", workspaceId: "workspace", terminalId: "child-terminal",
    worktreePath: $worktreePath, branch: "main", agent: "codex", agentId: "codex",
    model: "gpt-5", modelHonored: true, label: "label", state: "running",
    runtime: "tmux", spawnRuntime: "tmux", tmuxSession: "session", tmuxPane: "pane",
    createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z"
  }' >"$dir/meta.json"
}

append_child_message() {
  local dispatch_id="$1" seq="$2" type="$3" text="$4" dir="$dispatch_dir/$1"
  jq -n --argjson seq "$seq" --arg type "$type" --arg text "$text" \
    '{seq: $seq, from: "child", type: $type, text: $text, createdAt: "2020-01-01T00:00:00Z", sessionId: "child-terminal"}' \
    >"$dir/messages/$(printf '%04d' "$seq")-child-$type.json"
}

run_watch() {
  "$root/.build/megabrain" orchestrate watch protocol-view --timeout 0 --poll-interval 0 --wait-mode poll "$@"
}

# classifyMail (src/core/queue-write.ts, mirrored in src/core/check.ts) still treats child:received
# and child:ack as protocol mail, hidden from the default view and only surfaced with --full — the
# same distinction megabrain_dispatch_watch's shell body used to draw. Rewritten as black box
# against `orchestrate watch`/`orchestrate ack`.
create_dispatch protocol-view
append_child_message protocol-view 1 received 'prompt received'
append_child_message protocol-view 2 ack 'delivery-id'
append_child_message protocol-view 3 ask 'needs a decision'
default_view="$(run_watch --json)"
assert_equal "$(jq -r '.messages | length' <<<"$default_view")" 1
assert_equal "$(jq -r '.messages[0].type' <<<"$default_view")" ask
full_view="$(run_watch --full --consumer protocol-trace --json)"
assert_equal "$(jq -r '.messages | length' <<<"$full_view")" 1
assert_equal "$(jq -r '.messages[0].type' <<<"$full_view")" received
full_delivery_id="$(jq -r '.deliveryId' <<<"$full_view")"
"$root/.build/megabrain" orchestrate ack protocol-view "$full_delivery_id" --consumer protocol-trace --generation 1 --json >/dev/null
full_view="$(run_watch --full --consumer protocol-trace --json)"
assert_equal "$(jq -r '.messages | length' <<<"$full_view")" 1
assert_equal "$(jq -r '.messages[0].type' <<<"$full_view")" ack
printf 'default view hides protocol evidence and full trace reveals it\n'

printf 'ok: agent liveness, retired state migration, and protocol view\n'
