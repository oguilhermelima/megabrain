#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-parent-turn-end.XXXXXX")"
bin_dir="$state_dir/bin"
send_log="$state_dir/send.log"
mkdir -p "$bin_dir"

cleanup() {
  local rc=$?
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

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$1' to contain '$2'" ;;
  esac
}

printf '%s\n' '#!/bin/sh' 'printf "%s\\n" "$*" >>"$MEGABRAIN_TEST_SEND_LOG"' >"$bin_dir/superset"
chmod +x "$bin_dir/superset"
printf '%s\n' '#!/bin/sh' 'if [ "$1" = capture-pane ]; then cat "$MEGABRAIN_TEST_PANE_OUTPUT"; fi' >"$bin_dir/tmux"
chmod +x "$bin_dir/tmux"
: >"$send_log"

export MEGABRAIN_STATE_DIR="$state_dir/state"
export MEGABRAIN_DISPATCH_DIR="$MEGABRAIN_STATE_DIR/dispatches"
export MEGABRAIN_TEST_SEND_LOG="$send_log"
export MEGABRAIN_TEST_PANE_OUTPUT="$state_dir/pane.out"
export SUPERSET_TERMINAL_ID=parent-terminal
export PATH="$bin_dir:$PATH"
unset ORCA_TERMINAL_HANDLE TMUX TMUX_PANE

# megabrain_dispatch_meta_write and megabrain_dispatch_message_append (lib/module-orchestrate.sh)
# are gone: this hook's turn-end logic now lives entirely in the compiled binary
# (src/cli/commands/hook-turn-end.ts), and the shell versions of those two functions lost their
# last production caller. This test still drives hooks/megabrain-turn-end.sh as a black box
# (run_hook below); it just builds its dispatch fixtures directly with jq instead of through the
# deleted shell functions, matching the exact JSON shape megabrain_dispatch_meta_write used to
# produce (recorded from HEAD before its deletion) and the exact message shape
# megabrain_dispatch_message_append used to write.
write_dispatch_meta() {
  local dispatch_id="$1" child_host="$2" terminal_id="$3" state="$4" runtime="$5" tmux_session="$6" tmux_pane="$7"
  local dispatch_dir="$MEGABRAIN_DISPATCH_DIR/$dispatch_id"
  mkdir -p "$dispatch_dir/messages" "$dispatch_dir/deliveries"
  jq -n --arg dispatchId "$dispatch_id" --arg childHost "$child_host" --arg terminalId "$terminal_id" \
    --arg state "$state" --arg runtime "$runtime" \
    --arg tmuxSession "$tmux_session" --arg tmuxPane "$tmux_pane" --arg now "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    '{dispatchId: $dispatchId, parentSessionId: "parent-terminal", parentHost: "superset", parentWorkspaceId: null,
      parentTmuxSession: null, parentTmuxPane: null, childHost: $childHost, workspaceId: "workspace-test",
      terminalId: $terminalId, worktreePath: "/worktree", branch: "main", agent: "codex", agentId: "codex",
      model: "gpt-5", effort: null, modelHonored: true, modelSubstitution: null, runtime: $runtime,
      spawnRuntime: (if $runtime == "tmux" then "tmux" else "ide" end),
      tmuxSession: (if $tmuxSession == "" then null else $tmuxSession end),
      tmuxPane: (if $tmuxPane == "" then null else $tmuxPane end),
      label: "label", chain: null, state: $state, promptDelivered: false, promptDelivery: "pending",
      promptDeliveryReason: null, promptPublication: "pending", promptTransport: "pending",
      promptReceipt: "pending", promptState: "awaiting-publication",
      processState: (if $state == "running" then "running" else "starting" end),
      terminalState: "owned", terminalReason: null, failureCount: 0, stage: null, reason: null,
      reconcileOutcome: null, createdAt: $now, updatedAt: $now}' \
    >"$dispatch_dir/meta.json"
  jq -n '{lastReadSeq: 0}' >"$dispatch_dir/cursor.json"
}

create_dispatch() {
  local dispatch_id="$1" state="$2"
  write_dispatch_meta "$dispatch_id" superset "child-$dispatch_id" "$state" host "" ""
}

append_message() {
  local dispatch_id="$1" type="$2" text="$3"
  local dispatch_dir="$MEGABRAIN_DISPATCH_DIR/$dispatch_id" seq
  seq="$(find "$dispatch_dir/messages" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
  seq=$((seq + 1))
  jq -n --argjson seq "$seq" --arg type "$type" --arg text "$text" --arg sessionId "child-$dispatch_id" \
    --arg now "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    '{seq: $seq, from: "child", type: $type, text: $text, createdAt: $now, sessionId: $sessionId}' \
    >"$dispatch_dir/messages/$(printf '%04d' "$seq")-child-$type.json"
  # Only an actionable message (ask/done/stalled) notifies the parent — matches
  # megabrain_dispatch_mail_class's actionable-key list. Recorded directly in send_log rather than
  # through a real notify call: what this test checks is that run_hook does not add a SECOND send
  # on top of this one, not how the original send itself was delivered (that path is covered by
  # tests/unit/queue-write.test.ts and tests/unit/hook-turn-end.test.ts).
  case "$type" in
    ask|done|stalled) printf 'mail: megabrain orchestrate watch %s\n' "$dispatch_id" >>"$send_log" ;;
  esac
}

run_hook() {
  "$root/hooks/megabrain-turn-end.sh" '{}' >/dev/null
}

send_count() {
  wc -l <"$send_log" | tr -d ' '
}

create_dispatch event-hook running
append_message event-hook ask 'event-backed question'
assert_equal "$(send_count)" 1
run_hook
assert_equal "$(send_count)" 1
assert_equal "$(jq -r '.lastReadSeq' "$MEGABRAIN_DISPATCH_DIR/event-hook/cursor.json")" 0
printf 'event-backed child mail is not nudged again by the parent turn-end hook\n'

create_dispatch protocol-hook running
append_message protocol-hook received 'prompt received'
append_message protocol-hook ack 'delivery-id'
assert_equal "$(send_count)" 1
run_hook
assert_equal "$(send_count)" 1
printf 'received and ack do not nudge from append or the parent turn-end hook\n'

printf 'child branch: covered by tests/test-e2e-findings.sh\n'

write_dispatch_meta refused tmux refused-terminal running tmux refusal-session refusal-pane
printf '%s\n%s\n' \
  "You've hit your usage limit for this account." \
  'Switch to another model now,' >"$MEGABRAIN_TEST_PANE_OUTPUT"
run_hook
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/refused/meta.json")" failed
assert_equal "$(jq -r '.processState' "$MEGABRAIN_DISPATCH_DIR/refused/meta.json")" failed
assert_equal "$(jq -r '.stage' "$MEGABRAIN_DISPATCH_DIR/refused/meta.json")" limit-refused
assert_equal "$(jq -r '.reconcileOutcome' "$MEGABRAIN_DISPATCH_DIR/refused/meta.json")" limit-refused
assert_contains "$(jq -r '.reason' "$MEGABRAIN_DISPATCH_DIR/refused/meta.json")" 'usage limit'
printf 'parent hook: records a pane usage-limit refusal without waiting\n'
