#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
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
source "$root/lib/common.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-worktree.sh"

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
    *"$2"*) fail "did not expect '$1' to contain '$2'" ;;
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

create_tmux_meta() {
  local dispatch_id="$1" pane="$2"
  megabrain_dispatch_meta_write "$dispatch_id" "$parent_id" superset superset "$workspace_id" host-terminal "$root" main codex label running gpt-5 true codex "$session_name" "$pane" tmux >/dev/null
}

send_child_message() {
  local pane="$1" dispatch_id="$2" text="$3" output="$4" command_text
  command_text="MEGABRAIN_STATE_DIR=$(printf '%q' "$state_dir") SUPERSET_TERMINAL_ID=$(printf '%q' host-terminal) MEGABRAIN_DISPATCH_ID=$(printf '%q' "$dispatch_id") $(printf '%q' "$root/megabrain") ask $(printf '%q' "$text") >$(printf '%q' "$output") 2>&1"
  tmux_cmd send-keys -t "$pane" -l "$command_text"
  tmux_cmd send-keys -t "$pane" Enter
  wait_for_file "$output"
  wait_for_message "$dispatch_id"
}

send_child_message_without_host() {
  local pane="$1" dispatch_id="$2" text="$3" output="$4" command_text
  command_text="env -u SUPERSET_TERMINAL_ID MEGABRAIN_STATE_DIR=$(printf '%q' "$state_dir") MEGABRAIN_DISPATCH_ID=$(printf '%q' "$dispatch_id") $(printf '%q' "$root/megabrain") ask $(printf '%q' "$text") >$(printf '%q' "$output") 2>&1"
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

megabrain_dispatch_tmux_caller_session() {
  printf '%s\n' "$session_name"
}
export TMUX=tmux-parent-server
export TMUX_PANE="$tmux_pane_one"
unset SUPERSET_TERMINAL_ID ORCA_TERMINAL_HANDLE
megabrain_session_id >/dev/null
assert_equal "$MEGABRAIN_SESSION_HOST" tmux
assert_equal "$MEGABRAIN_SESSION_ID" "$session_name:$tmux_pane_one"
assert_equal "$(megabrain_context_detect)" tmux
tmux_parent_dispatch="dispatch-tmux-parent"
megabrain_dispatch_meta_write "$tmux_parent_dispatch" "$session_name:$tmux_pane_one" tmux superset "$workspace_id" host-terminal "$root" main codex label running gpt-5 true codex "" "" host >/dev/null
megabrain_dispatch_require_parent "$tmux_parent_dispatch" >/dev/null || fail 'tmux parent could not read its own dispatch'
export TMUX_PANE="$tmux_pane_two"
if megabrain_dispatch_require_parent "$tmux_parent_dispatch" >/dev/null 2>&1; then
  fail 'a different tmux pane was accepted as the parent'
fi
export TMUX_PANE="$tmux_pane_one"
export SUPERSET_TERMINAL_ID="$parent_id"

# A stale dispatch must not make the registry scan choose an arbitrary matching
# session. The caller's own registered main pane is the authoritative split target.
tmux_cmd new-session -d -s "$other_session" -x 80 -y 20 bash
test_tmux_info="$(tmux_cmd display-message -p -t "$tmux_pane_one" '#{socket_path},#{pid},#{session_id}')"
export TMUX="$test_tmux_info"
mkdir -p "$MEGABRAIN_TMUX_SESSION_DIR"
jq -n --arg session "$other_session" --arg path "$root" \
  '{tmuxSession: $session, agent: "claude", workingDirectory: $path, tmuxPane: "%other", role: "main", host: "tmux", createdAt: "2026-09-09T00:00:00Z"}' \
  >"$MEGABRAIN_TMUX_SESSION_DIR/megabrain-claude-12988.json"
jq -n --arg session "$session_name" --arg path "$root" --arg pane "$tmux_pane_one" \
  '{tmuxSession: $session, agent: "codex", workingDirectory: $path, tmuxPane: $pane, role: "main", host: "tmux", createdAt: "2026-09-09T00:00:01Z"}' \
  >"$MEGABRAIN_TMUX_SESSION_DIR/megabrain-claude-9505.json"
megabrain_dispatch_meta_write stale-session parent-terminal tmux tmux "$workspace_id" stale-terminal "$root" main codex label running gpt-5 true codex stale-session-gone %stale tmux >/dev/null
megabrain_tmux_existing_session_for_worktree "$root"
assert_equal "$MEGABRAIN_TMUX_EXISTING_SESSION" "$session_name"
printf 'session selection: registered caller session wins over stale metadata and glob order\n'

create_tmux_meta "$dispatch_one" "$tmux_pane_one"
create_tmux_meta "$dispatch_two" "$tmux_pane_two"

send_child_message "$tmux_pane_one" "$dispatch_one" child-one "$state_dir/child-one.out"
send_child_message "$tmux_pane_two" "$dispatch_two" child-two "$state_dir/child-two.out"
megabrain_dispatch_meta_write "$dispatch_orca" "$parent_id" orca orca "$workspace_id" host-terminal \
  "$root" main codex label running gpt-5 true codex "$session_name" "$tmux_pane_two" tmux >/dev/null
send_child_message_without_host "$tmux_pane_two" "$dispatch_orca" child-without-host "$state_dir/child-without-host.out"

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
if wrong_parent_output="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=other-parent "$root/megabrain" orchestrate watch "$dispatch_one" --timeout 0 --poll-interval 0 --json 2>&1)"; then
  fail "wrong parent read dispatch one"
fi
assert_contains "$wrong_parent_output" "owned by superset/$parent_id"
if wrong_parent_output="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=other-parent "$root/megabrain" orchestrate watch "$dispatch_two" --timeout 0 --poll-interval 0 --json 2>&1)"; then
  fail "wrong parent read dispatch two"
fi
assert_contains "$wrong_parent_output" "owned by superset/$parent_id"

delivery_one="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID="$parent_id" "$root/megabrain" orchestrate watch "$dispatch_one" --timeout 0 --poll-interval 0 --json)"
delivery_two="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID="$parent_id" "$root/megabrain" orchestrate watch "$dispatch_two" --timeout 0 --poll-interval 0 --json)"
delivery_id_one="$(jq -r '.deliveryId' <<<"$delivery_one")"
delivery_id_two="$(jq -r '.deliveryId' <<<"$delivery_two")"
[ "$delivery_id_one" != null ] || fail "dispatch one did not create a delivery"
[ "$delivery_id_two" != null ] || fail "dispatch two did not create a delivery"
assert_equal "$(jq -r '.messages[0].text' <<<"$delivery_one")" child-one
assert_equal "$(jq -r '.messages[0].text' <<<"$delivery_two")" child-two

env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID="$parent_id" "$root/megabrain" orchestrate ack "$dispatch_one" "$delivery_id_one" --json >/dev/null
assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_one/deliveries/$delivery_id_one.json")" acknowledged
assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_two/deliveries/$delivery_id_two.json")" outstanding

stale_pane="$tmux_pane_one"
tmux_cmd kill-pane -t "$stale_pane"
stale_output="$state_dir/stale.out"
stale_done="$state_dir/stale.done"
stale_command="MEGABRAIN_STATE_DIR=$(printf '%q' "$state_dir") SUPERSET_TERMINAL_ID=host-terminal MEGABRAIN_DISPATCH_ID=$(printf '%q' "$dispatch_one") TMUX_PANE=$(printf '%q' "$stale_pane") $(printf '%q' "$root/megabrain") ask stale-message >$(printf '%q' "$stale_output") 2>&1; printf 'done\n' >$(printf '%q' "$stale_done")"
tmux_cmd send-keys -t "$tmux_pane_two" -l "$stale_command"
tmux_cmd send-keys -t "$tmux_pane_two" Enter
wait_for_file "$stale_done"
assert_contains "$(cat "$stale_output")" "no managed dispatch belongs to tmux session unknown pane $stale_pane"
assert_equal "$(find "$state_dir/dispatches/$dispatch_one/messages" -name '*.json' | wc -l | tr -d ' ')" 1

tab_dispatch="dispatch-tab"
megabrain_dispatch_meta_write "$tab_dispatch" tab-parent superset superset "$workspace_id" tab-terminal "$root" main codex label running gpt-5 true codex "" "" host >/dev/null
env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=tab-terminal MEGABRAIN_DISPATCH_ID="$tab_dispatch" "$root/megabrain" ask tab-message >/dev/null
tab_message="$(find "$state_dir/dispatches/$tab_dispatch/messages" -name '*.json' -print -quit)"
assert_equal "$(jq -r '.text' "$tab_message")" tab-message

megabrain_runtime_enabled() { return 0; }
megabrain_tmux_available() { return 0; }
megabrain_superset_available() { return 0; }
megabrain_tmux_existing_session_for_worktree() { MEGABRAIN_TMUX_EXISTING_SESSION="$session_name"; return 0; }
megabrain_tmux_host_terminal_for_session() { return 0; }
megabrain_tmux_split_pane() { printf '%s\n' "$tmux_pane_two"; }
megabrain_tmux_apply_config() { return 0; }
megabrain_tmux_send_agent() { return 0; }
megabrain_dispatch_send_prompt_with_receipt() { return 0; }
megabrain_tmux_agent_output_clean() { return 0; }
megabrain_agent_command() { printf 'true\n'; }

success_launch_output="$state_dir/success-launch-output"
SUPERSET_TERMINAL_ID="$parent_id" megabrain_launch_agent "$root" "$workspace_id" codex gpt-5 medium prompt label >"$success_launch_output" 2>&1
assert_not_contains "$(cat "$success_launch_output")" 'prompt awaiting receipt; run megabrain orchestrate reconcile'
reused_dispatch="$MEGABRAIN_LAST_DISPATCH"
assert_equal "$(jq -r '.terminalId' "$state_dir/dispatches/$reused_dispatch/meta.json")" "$parent_id"
assert_equal "$(jq -r '.promptDelivered' "$state_dir/dispatches/$reused_dispatch/meta.json")" true
assert_equal "$(jq -r '.promptDelivery' "$state_dir/dispatches/$reused_dispatch/meta.json")" delivered

megabrain_require_command() { return 1; }
unset SUPERSET_TERMINAL_ID ORCA_TERMINAL_HANDLE
standalone_dispatch_expected_parent="$session_name:$tmux_pane_one"
megabrain_launch_agent "$root" "$workspace_id" codex gpt-5 medium prompt label >/dev/null
standalone_dispatch="$MEGABRAIN_LAST_DISPATCH"
assert_equal "$(jq -r '.parentHost' "$state_dir/dispatches/$standalone_dispatch/meta.json")" tmux
assert_equal "$(jq -r '.parentSessionId' "$state_dir/dispatches/$standalone_dispatch/meta.json")" "$standalone_dispatch_expected_parent"
assert_equal "$(jq -r '.childHost' "$state_dir/dispatches/$standalone_dispatch/meta.json")" tmux

printf 'ok: tmux child identity, ownership, stale pane, tab mode, and reused-session terminal identity\n'
