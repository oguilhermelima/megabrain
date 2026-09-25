#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/fixtures/a-dispatch-meta.sh"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-ident.XXXXXX")"
socket_name="megabrainident"
session_name="megabrain-ident-test"
other_session="megabrain-ident-other"
parent_id="parent-terminal"
workspace_id="workspace-test"
tmux_pane_one=""
tmux_pane_two=""
dispatch_one="dispatch-one"
dispatch_two="dispatch-two"
dispatch_orca="dispatch-orca-parent"

cleanup() {
  tmux -L "$socket_name" kill-session -t "$session_name" >/dev/null 2>&1 || true
  tmux -L "$socket_name" kill-session -t "$other_session" >/dev/null 2>&1 || true
  rm -rf "$state_dir"
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
export TMUX_TMPDIR="$state_dir"
unset TMUX TMUX_PANE

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

wait_for_file() {
  local path="$1" attempt
  for ((attempt = 1; attempt <= 100; attempt++)); do
    [ -f "$path" ] && return 0
    sleep 0.05
  done
  fail "timed out waiting for $path"
}

wait_for_message() {
  local dispatch_id="$1" attempt count
  for ((attempt = 1; attempt <= 100; attempt++)); do
    count="$(find "$state_dir/dispatches/$dispatch_id/messages" -name '*.json' -print 2>/dev/null | wc -l | tr -d ' ')"
    [ "$count" -ge 1 ] && return 0
    sleep 0.05
  done
  fail "timed out waiting for a message in $dispatch_id"
}

tmux_cmd() {
  tmux -f /dev/null -L "$socket_name" "$@"
}

# Fixture built directly with jq (tests/fixtures/a-dispatch-meta.sh): no lib/ sourcing, no
# megabrain_dispatch_meta_write.
create_tmux_meta() {
  local dispatch_id="$1" pane="$2"
  write_dispatch_meta "$state_dir" "$dispatch_id" \
    parentSessionId="$parent_id" parentHost=superset childHost=superset workspaceId="$workspace_id" \
    terminalId=host-terminal worktreePath="$root" branch=main agent=codex agentId=codex label=label \
    state=running model=gpt-5 modelHonored=true tmuxSession="$session_name" tmuxPane="$pane" runtime=tmux >/dev/null
}

# findChild (src/cli/commands/queue-write.ts) never matches a tmux-runtime dispatch by
# terminalId/childHost, only by the caller's exact tmuxSession+tmuxPane ("A tmux-runtime record
# is never matched by terminalId/childHost ... only a caller actually running in that exact
# tmuxSession/tmuxPane can ever be this dispatch's child") -- confirmed empirically: setting
# SUPERSET_TERMINAL_ID for a caller inside the child's own tmux pane now refuses with "no managed
# dispatch belongs to superset/...", because a tmux-runtime dispatch can only match via
# current.host === "tmux". So every send below carries no terminal-handle override at all; a real
# tmux pane's own inherited TMUX/TMUX_PANE is the only identity that still works, and
# MEGABRAIN_DISPATCH_ID keeps each call pinned to its intended dispatch even though dispatch_two
# and dispatch_orca below share the same pane.
send_child_message() {
  local pane="$1" dispatch_id="$2" text="$3" output="$4" command_text
  command_text="env -u SUPERSET_TERMINAL_ID -u ORCA_TERMINAL_HANDLE MEGABRAIN_STATE_DIR=$(printf '%q' "$state_dir") MEGABRAIN_DISPATCH_ID=$(printf '%q' "$dispatch_id") $(printf '%q' "$root/.build/megabrain") ask $(printf '%q' "$text") >$(printf '%q' "$output") 2>&1"
  tmux_cmd send-keys -t "$pane" -l "$command_text"
  tmux_cmd send-keys -t "$pane" Enter
  wait_for_file "$output"
  wait_for_message "$dispatch_id"
}

tmux_cmd new-session -d -s "$session_name" -x 120 -y 30 bash
tmux_pane_one="$(tmux_cmd split-window -h -P -F '#{pane_id}' -t "$session_name" bash)"
tmux_pane_two="$(tmux_cmd split-window -v -P -F '#{pane_id}' -t "$tmux_pane_one" bash)"
tmux_session_from_pane="$(tmux_cmd display-message -p -t "$tmux_pane_one" '#{session_name}')"
assert_equal "$tmux_session_from_pane" "$session_name"

# A real, correctly formatted $TMUX (socket_path,pid,session_id) is required for a plain "tmux"
# call (no -L) -- made by the compiled binary as a subprocess -- to resolve this alternate-socket
# server at all; a placeholder value leaves every probe unable to find the pane and falls through
# to whatever host probe answers next.
tmux_info_one="$(tmux_cmd display-message -p -t "$tmux_pane_one" '#{socket_path},#{pid},#{session_id}')"
export TMUX="$tmux_info_one"
export TMUX_PANE="$tmux_pane_one"
unset SUPERSET_TERMINAL_ID ORCA_TERMINAL_HANDLE
context_json="$("$root/.build/megabrain" context --json)"
assert_equal "$(jq -r '.host' <<<"$context_json")" tmux
assert_equal "$(jq -r '.terminalId' <<<"$context_json")" "$session_name:$tmux_pane_one"
assert_equal "$("$root/.build/megabrain" context)" tmux
printf 'tmux context: host and pane identity resolve through the real pane, not a caller override\n'

# megabrain_dispatch_require_parent (lib/module-orchestrate.sh) has no standalone equivalent, but
# the ownership check it wrapped (ownsDispatch, src/core/context.ts) is the same gate every
# parent-only verb runs. `orchestrate reply` is used here as that gate's real entry point
# (orchestrate-reply.ts's requireParent calls queue-write.ts's resolveCaller, which -- unlike
# orchestrate watch below -- does perform the tmux session probe).
tmux_parent_dispatch="dispatch-tmux-parent"
write_dispatch_meta "$state_dir" "$tmux_parent_dispatch" \
  parentSessionId="$session_name:$tmux_pane_one" parentHost=tmux childHost=superset workspaceId="$workspace_id" \
  terminalId=host-terminal worktreePath="$root" branch=main agent=codex agentId=codex label=label \
  state=running model=gpt-5 modelHonored=true runtime=host >/dev/null
"$root/.build/megabrain" orchestrate reply "$tmux_parent_dispatch" --text 'ownership probe' --json >/dev/null ||
  fail 'tmux parent could not read its own dispatch'
export TMUX_PANE="$tmux_pane_two"
if "$root/.build/megabrain" orchestrate reply "$tmux_parent_dispatch" --text 'should be refused' --json >/dev/null 2>&1; then
  fail 'a different tmux pane was accepted as the parent'
fi
export TMUX_PANE="$tmux_pane_one"
export SUPERSET_TERMINAL_ID="$parent_id"
printf 'tmux parent ownership: only the exact owning pane may act as the parent\n'

# megabrain_tmux_existing_session_for_worktree (lib/module-tmux-runtime.sh) has no TS port at
# all -- grep for "existingSession"/"ExistingSession" across src/ is empty. `orchestrate spawn`'s
# tmux path (src/cli/commands/orchestrate-spawn.ts) has no session-reuse-by-worktree-registry
# concept to race against stale metadata; each spawn resolves its own tmux target directly. The
# "a stale dispatch must not make the registry scan choose an arbitrary session" scenario tests
# a lookup mechanism that no longer exists anywhere in the binary. Dropped per rule 3.

create_tmux_meta "$dispatch_one" "$tmux_pane_one"
create_tmux_meta "$dispatch_two" "$tmux_pane_two"

send_child_message "$tmux_pane_one" "$dispatch_one" child-one "$state_dir/child-one.out"
send_child_message "$tmux_pane_two" "$dispatch_two" child-two "$state_dir/child-two.out"
write_dispatch_meta "$state_dir" "$dispatch_orca" \
  parentSessionId="$parent_id" parentHost=orca childHost=orca workspaceId="$workspace_id" \
  terminalId=host-terminal worktreePath="$root" branch=main agent=codex agentId=codex label=label \
  state=running model=gpt-5 modelHonored=true tmuxSession="$session_name" tmuxPane="$tmux_pane_two" runtime=tmux >/dev/null
send_child_message "$tmux_pane_two" "$dispatch_orca" child-without-host "$state_dir/child-without-host.out"

message_one="$(find "$state_dir/dispatches/$dispatch_one/messages" -name '*.json' -print -quit)"
message_two="$(find "$state_dir/dispatches/$dispatch_two/messages" -name '*.json' -print -quit)"
[ -n "$message_one" ] || fail "dispatch one has no message"
[ -n "$message_two" ] || fail "dispatch two has no message"
assert_equal "$(jq -r '.text' "$message_one")" child-one
assert_equal "$(jq -r '.text' "$message_two")" child-two
[ "$(find "$state_dir/dispatches/$dispatch_orca/messages" -name '*.json' | wc -l | tr -d ' ')" = 1 ] || fail "dispatch without host received no message"
message_without_host="$(find "$state_dir/dispatches/$dispatch_orca/messages" -name '*.json' -print -quit)"
assert_equal "$(jq -r '.text' "$message_without_host")" child-without-host
[ "$(find "$state_dir/dispatches/$dispatch_one/messages" -name '*.json' | wc -l | tr -d ' ')" = 1 ] || fail "dispatch one received an extra message"
[ "$(find "$state_dir/dispatches/$dispatch_two/messages" -name '*.json' | wc -l | tr -d ' ')" = 1 ] || fail "dispatch two received an extra message"

wrong_parent_output=""
if wrong_parent_output="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=other-parent "$root/.build/megabrain" orchestrate watch "$dispatch_one" --timeout 0 --poll-interval 0 --json 2>&1)"; then
  fail "wrong parent read dispatch one"
fi
assert_contains "$wrong_parent_output" "owned by superset/$parent_id"
if wrong_parent_output="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=other-parent "$root/.build/megabrain" orchestrate watch "$dispatch_two" --timeout 0 --poll-interval 0 --json 2>&1)"; then
  fail "wrong parent read dispatch two"
fi
assert_contains "$wrong_parent_output" "owned by superset/$parent_id"

delivery_one="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID="$parent_id" "$root/.build/megabrain" orchestrate watch "$dispatch_one" --timeout 0 --poll-interval 0 --json)"
delivery_two="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID="$parent_id" "$root/.build/megabrain" orchestrate watch "$dispatch_two" --timeout 0 --poll-interval 0 --json)"
delivery_id_one="$(jq -r '.deliveryId' <<<"$delivery_one")"
delivery_id_two="$(jq -r '.deliveryId' <<<"$delivery_two")"
[ "$delivery_id_one" != null ] || fail "dispatch one did not create a delivery"
[ "$delivery_id_two" != null ] || fail "dispatch two did not create a delivery"
assert_equal "$(jq -r '.messages[0].text' <<<"$delivery_one")" child-one
assert_equal "$(jq -r '.messages[0].text' <<<"$delivery_two")" child-two

env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID="$parent_id" "$root/.build/megabrain" orchestrate ack "$dispatch_one" "$delivery_id_one" --json >/dev/null
assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_one/deliveries/$delivery_id_one.json")" acknowledged
assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_two/deliveries/$delivery_id_two.json")" outstanding

stale_pane="$tmux_pane_one"
tmux_cmd kill-pane -t "$stale_pane"
stale_output="$state_dir/stale.out"
stale_done="$state_dir/stale.done"
# A caller identity is resolved once per call (queue-write.ts's session(), reused by findChild):
# setting a terminal-handle override short-circuits before the tmux fallback is ever attempted,
# so a stale TMUX_PANE can only be observed with no override present -- the caller then falls
# through every identity probe (tmux display-message on the now-dead pane, then the
# list-panes -a fallback) and is refused outright as unidentified, rather than reaching
# findChild's dispatch-specific "no managed dispatch belongs to tmux session ... pane ..."
# message, which requires a *resolved* tmux identity that simply finds no match -- confirmed
# empirically: with SUPERSET_TERMINAL_ID set (as the old assertion required), session() returns
# the superset identity before ever touching TMUX_PANE, and the refusal names a superset
# terminal, not a tmux pane. Adjusted to the message the current code actually produces for a
# truly stale pane, while keeping the property that matters: a dead pane reference is refused,
# and dispatch_one's message count does not grow.
stale_command="env -u SUPERSET_TERMINAL_ID -u ORCA_TERMINAL_HANDLE MEGABRAIN_STATE_DIR=$(printf '%q' "$state_dir") MEGABRAIN_DISPATCH_ID=$(printf '%q' "$dispatch_one") TMUX_PANE=$(printf '%q' "$stale_pane") $(printf '%q' "$root/.build/megabrain") ask stale-message >$(printf '%q' "$stale_output") 2>&1; printf 'done\n' >$(printf '%q' "$stale_done")"
tmux_cmd send-keys -t "$tmux_pane_two" -l "$stale_command"
tmux_cmd send-keys -t "$tmux_pane_two" Enter
wait_for_file "$stale_done"
assert_contains "$(cat "$stale_output")" 'this command requires a managed terminal identity'
assert_equal "$(find "$state_dir/dispatches/$dispatch_one/messages" -name '*.json' | wc -l | tr -d ' ')" 1

tab_dispatch="dispatch-tab"
write_dispatch_meta "$state_dir" "$tab_dispatch" \
  parentSessionId=tab-parent parentHost=superset childHost=superset workspaceId="$workspace_id" \
  terminalId=tab-terminal worktreePath="$root" branch=main agent=codex agentId=codex label=label \
  state=running model=gpt-5 modelHonored=true runtime=host >/dev/null
env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=tab-terminal MEGABRAIN_DISPATCH_ID="$tab_dispatch" "$root/.build/megabrain" ask tab-message >/dev/null
tab_message="$(find "$state_dir/dispatches/$tab_dispatch/messages" -name '*.json' -print -quit)"
assert_equal "$(jq -r '.text' "$tab_message")" tab-message

# megabrain_launch_agent (lib/module-worktree.sh) is gone: `orchestrate spawn` forwards
# unconditionally to executeSpawn (src/cli/commands/orchestrate-spawn.ts), which has a different
# call signature (repo/branch or --worktree, not "root workspaceId agent model effort prompt
# label"), a different tmux-session-reuse story (see the dropped stale-session scenario above),
# and its own terminal-identity/env-clearing rules. Faking its dozen internal shell collaborators
# (megabrain_tmux_split_pane, megabrain_agent_command, megabrain_dispatch_send_prompt_with_
# receipt, ...) would only prove the fakes call each other, not that the binary works. The
# properties this scenario checked -- a reused terminal keeps its own identity as parent, a
# standalone (non-managed) launch records its real tmux parent identity, and prompt delivery
# is confirmed without a stray "awaiting receipt" message -- are covered directly against
# executeSpawn in tests/unit/spawn.test.ts: "exports the created host terminal identity through
# its provider variable", "uses the Superset terminal identity variable for Superset children",
# "keeps tmux identity variables and adds the shared state directory", "from a structured Orca
# session (no terminal handle)", "from an Orca terminal", "from another tmux pane (splits the
# caller's own session)", and "returns success while receipt is pending and points to reconcile".
# Dropped per rule 2/3.

printf 'ok: tmux child identity, ownership, stale pane, tab mode\n'
