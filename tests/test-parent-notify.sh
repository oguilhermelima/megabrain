#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-nudge.XXXXXX")"
socket_name=megabrainnudge
# Short on purpose: TMUX_TMPDIR sits under a long mktemp path and the socket path
# has to stay inside the 104-byte Unix socket limit.
outside_socket=dnout
session_name=megabrain-nudge-test
no_context_session=megabrain-nudge-no-context
parent_id=parent-terminal
workspace_id=workspace-test
parent_pane=""
tmux_info=""
outside_state_dir=""

# Killing the sessions is not enough: TMUX_TMPDIR points inside the state
# directory, so a surviving server is stranded on a socket path that is about to
# be removed and can never be reached again.
cleanup() {
  tmux -L "$socket_name" kill-server >/dev/null 2>&1 || true
  tmux -L "$outside_socket" kill-server >/dev/null 2>&1 || true
  rm -rf "$state_dir"
  [ -n "$outside_state_dir" ] && rm -rf "$outside_state_dir"
  return 0
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
export TMUX_TMPDIR="$state_dir"
source "$root/lib/common.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-parent-notify.sh"

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

wait_for_pane_text() {
  local pane="$1" expected="$2" socket="${3:-$socket_name}" attempt=0 capture=""
  while [ "$attempt" -lt 200 ]; do
    capture="$(tmux -L "$socket" capture-pane -J -p -t "$pane" -S -20)"
    case "$capture" in
      *"$expected"*) return 0 ;;
    esac
    sleep 0.05
    attempt=$((attempt + 1))
  done
  fail "timed out waiting for '$expected' in pane $pane"
}

wait_for_pane_command() {
  local pane="$1" expected="$2" attempt=0 actual=""
  while [ "$attempt" -lt 200 ]; do
    actual="$(tmux_cmd display-message -p -t "$pane" '#{pane_current_command}')"
    [ "$actual" = "$expected" ] && return 0
    sleep 0.05
    attempt=$((attempt + 1))
  done
  fail "timed out waiting for pane $pane command '$expected' (got '$actual')"
}

tmux_cmd() {
  tmux -L "$socket_name" "$@"
}

create_meta() {
  local dispatch_id="$1" pane="$2" child_pane="$2" runtime="${3:-tmux}" host="${4:-superset}" parent_target="${5:-$parent_pane}" parent_session="${6:-$session_name}"
  [ "$child_pane" = "$parent_pane" ] && child_pane="%child-$dispatch_id"
  megabrain_dispatch_meta_write "$dispatch_id" "$parent_id" "$host" "$host" "$workspace_id" "$dispatch_id-child" "$root" main codex label running gpt-5 true codex "$session_name" "$child_pane" "$runtime" "$runtime" "$parent_session" "$parent_target" "$workspace_id" >/dev/null
}

append_message() {
  local dispatch_id="$1" text="$2"
  megabrain_dispatch_message_append "$dispatch_id" child ask "$text" "$dispatch_id-child" >/dev/null
}

single_pointer="$(megabrain_parent_notify_pointer dispatch-id)"
assert_equal "$single_pointer" 'mail: megabrain orchestrate watch dispatch-id'
many_pointer="$(megabrain_parent_notify_pointer_many 3 'dispatch-one, dispatch-two, dispatch-three')"
assert_equal "$many_pointer" '3 mails: run megabrain orchestrate list'
assert_not_contains "$many_pointer" dispatch-one
printf 'pointer format: one-line actionable text caps multi-dispatch detail by count\n'

tmux_cmd new-session -d -s "$session_name" -x 120 -y 30 bash
parent_pane="$(tmux_cmd display-message -p -t "$session_name" '#{pane_id}')"
tmux_info="$(tmux_cmd display-message -p -t "$parent_pane" '#{socket_path},#{pid},#{session_id}')"
tmux_cmd set-environment -t "$session_name" MEGABRAIN_STATE_DIR "$state_dir"
export TMUX="$tmux_info"
export TMUX_PANE="$parent_pane"
tmux_cmd send-keys -t "$parent_pane" -l "PS1='IDLE$ '; export PS1; printf 'parent-ready\\n'"
tmux_cmd send-keys -t "$parent_pane" Enter
wait_for_pane_text "$parent_pane" parent-ready

# A pane with no dispatch or session record has no measured agent affordance. The
# notification path must run, prove that it skipped typing, and leave the pane unchanged
# while the durable queue remains authoritative.
megabrain_dispatch_meta_write unresolved-parent-pane "$parent_id" tmux tmux "" unresolved-child "$root" main codex label running gpt-5 true codex fake-child-session %fake-child tmux tmux "$session_name" "$parent_pane" "$workspace_id" >/dev/null
unresolved_meta="$(megabrain_dispatch_meta_read unresolved-parent-pane)"
unresolved_before="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -20)"
megabrain_parent_notify_dispatch "$unresolved_meta"
unresolved_after="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -20)"
assert_equal "$MEGABRAIN_TMUX_SEND_STATUS" not-typed
assert_equal "$unresolved_before" "$unresolved_after"
printf 'unknown parent pane: notification ran without typing\n'

# A worker pane is owned by its dispatch metadata even when it is not the tmux session
# registry's main pane. Resolve the recorded Codex agent from its dispatch metadata.
worker_pane="$(tmux_cmd split-window -d -t "$parent_pane" -P -F '#{pane_id}' bash)"
create_meta parent-codex-owner "$worker_pane"
create_meta child-codex-pane '%fake-child' tmux tmux "$worker_pane" "$session_name"
codex_parent_meta="$(megabrain_dispatch_meta_read child-codex-pane)"
assert_equal "$(megabrain_tmux_agent_for_pane "$worker_pane")" codex
printf 'recorded Codex worker parent: pane ownership resolves the agent\n'

# A top-level coordinator is represented by the session registry rather than a dispatch.
# Its recorded Claude affordance remains usable without any default or guess.
mkdir -p "$MEGABRAIN_TMUX_SESSION_DIR"
jq -n --arg session "$session_name" --arg pane "$parent_pane" --arg path "$root" \
  '{tmuxSession: $session, agent: "claude", workingDirectory: $path, tmuxPane: $pane, role: "main", host: "tmux", createdAt: "2026-09-09T00:00:00Z"}' \
  >"$MEGABRAIN_TMUX_SESSION_DIR/top-coordinator.json"
assert_equal "$(megabrain_tmux_agent_for_pane "$parent_pane")" claude
printf 'recorded Claude coordinator: session ownership resolves affordance\n'

create_meta tmux-idle "$parent_pane"
idle_meta="$(megabrain_dispatch_meta_read tmux-idle)"
append_message tmux-idle 'body must remain in queue'
megabrain_parent_notify_dispatch "$idle_meta"
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" queued
idle_capture="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -20)"
assert_contains "$idle_capture" 'mail: megabrain orchestrate watch tmux-idle'
assert_not_contains "$idle_capture" 'body must remain in queue'
printf 'tmux parent pointer: %s\n' "$(printf '%s\n' "$idle_capture" | grep -F 'mail: megabrain orchestrate watch tmux-idle' | tail -n 1)"

delivery="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID="$parent_id" "$root/megabrain" orchestrate watch tmux-idle --timeout 0 --poll-interval 0 --wait-mode poll --json)"
assert_equal "$(jq -r '.messages | length' <<<"$delivery")" 1
assert_equal "$(jq -r '.messages[0].text' <<<"$delivery")" 'body must remain in queue'
delivery_id="$(jq -r '.deliveryId' <<<"$delivery")"
env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID="$parent_id" "$root/megabrain" orchestrate ack tmux-idle "$delivery_id" --json >/dev/null
second_delivery="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID="$parent_id" "$root/megabrain" orchestrate watch tmux-idle --timeout 0 --poll-interval 0 --wait-mode poll --json)"
assert_equal "$(jq -r '.messages | length' <<<"$second_delivery")" 0
printf 'no double delivery: one message, then empty queue\n'

tmux_cmd send-keys -t "$parent_pane" -l 'sleep 2'
tmux_cmd send-keys -t "$parent_pane" Enter
wait_for_pane_command "$parent_pane" sleep
create_meta tmux-busy "$parent_pane"
append_message tmux-busy 'busy body'
busy_before="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -20)"
busy_meta="$(megabrain_dispatch_meta_read tmux-busy)"
megabrain_parent_notify_dispatch "$busy_meta"
busy_after="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -20)"
assert_contains "$busy_after" 'mail: megabrain orchestrate watch tmux-busy'
assert_equal "$(find "$state_dir/dispatches/tmux-busy/messages" -name '*.json' | wc -l | tr -d ' ')" 1
assert_not_equal "$busy_before" "$busy_after"
printf 'tmux busy parent: pointer typed and queue retained\n'
sleep 2.1

create_meta tmux-unknown '%999' tmux superset '%999'
unknown_meta="$(megabrain_dispatch_meta_read tmux-unknown)"
megabrain_parent_notify_dispatch "$unknown_meta" || true
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" failed
assert_contains "$(cat "$state_dir/dispatches/tmux-unknown/nudge.log")" 'outcome=failed'
printf 'missing tmux pane: host fallback attempted and failure logged\n'

create_meta tmux-waiter "$parent_pane"
waiter_meta="$(megabrain_dispatch_meta_read tmux-waiter)"
megabrain_parent_notify_waiter_register tmux-waiter "$waiter_meta"
append_message tmux-waiter 'waiter body'
waiter_before="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -20)"
megabrain_parent_notify_dispatch "$waiter_meta"
waiter_after="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -20)"
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" suppressed
assert_equal "$waiter_before" "$waiter_after"
megabrain_parent_notify_waiter_unregister tmux-waiter
waiter_delivery="$(env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID="$parent_id" "$root/megabrain" orchestrate watch tmux-waiter --timeout 0 --poll-interval 0 --wait-mode poll --json)"
assert_equal "$(jq -r '.messages[0].text' <<<"$waiter_delivery")" 'waiter body'
printf 'active waiter: nudge suppressed and delivery remained readable\n'

create_meta tmux-broken "$parent_pane"
tmux_cmd send-keys -t "$parent_pane" -l "PS1='BUSY$ '; export PS1; printf 'busy-marker\\n'"
tmux_cmd send-keys -t "$parent_pane" Enter
wait_for_pane_text "$parent_pane" busy-marker
broken_meta="$(megabrain_dispatch_meta_read tmux-broken)"
broken_pointer="$(megabrain_parent_notify_pointer tmux-broken)"
broken_before="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -20)"
broken_parent_notify() {
  megabrain_parent_notify_tmux "$broken_meta" "$broken_pointer"
}
if broken_parent_notify; then
  broken_after="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -20)"
  if [ "$broken_before" = "$broken_after" ]; then
    fail 'deliberately broken busy-parent test did not detect a violation'
  fi
else
  fail 'deliberately broken busy-parent path did not type'
fi
printf 'direct busy-pane transport accepts the pointer\n'

create_meta tmux-failure "$parent_pane"
(
  unset TMUX TMUX_PANE
  export SUPERSET_TERMINAL_ID=tmux-failure-child
  unset ORCA_TERMINAL_HANDLE
  fake_bin="$state_dir/fake-bin"
  mkdir -p "$fake_bin"
  cat >"$fake_bin/tmux" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  has-session) exit 0 ;;
  list-panes) printf '%s\n' "${MEGABRAIN_TEST_PARENT_PANE:-}" ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$fake_bin/tmux"
  env -i HOME="$state_dir/home" PATH="$fake_bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state_dir" \
    MEGABRAIN_TEST_PARENT_PANE="$parent_pane" \
    MEGABRAIN_DISPATCH_ID=tmux-failure SUPERSET_TERMINAL_ID=tmux-failure-child \
    "$root/.build/megabrain" ask 'failure body retained'
) >/dev/null
assert_equal "$(find "$state_dir/dispatches/tmux-failure/messages" -name '*.json' | wc -l | tr -d ' ')" 1
assert_equal "$(jq -r '.text' "$state_dir/dispatches/tmux-failure/messages"/*.json)" 'failure body retained'
printf 'notify failure: child ask succeeded and queue retained\n'

# WHY: the child's runtime and the parent's reachability are independent. This dispatch
# was launched in an IDE tab, host runtime, but its parent sits in a live tmux pane, and
# it must still be notified through that pane.
create_meta host-runtime-tmux-parent "$parent_pane" host superset
host_tmux_meta="$(megabrain_dispatch_meta_read host-runtime-tmux-parent)"
assert_equal "$(megabrain_parent_notify_channel "$host_tmux_meta")" tmux
append_message host-runtime-tmux-parent 'host runtime body'
megabrain_parent_notify_dispatch "$host_tmux_meta"
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" queued
host_tmux_capture="$(tmux_cmd capture-pane -p -J -t "$parent_pane" -S -20)"
assert_contains "$host_tmux_capture" 'mail: megabrain orchestrate watch host-runtime-tmux-parent'
assert_not_contains "$host_tmux_capture" 'host runtime body'
printf 'host runtime with a live tmux parent still notifies through the pane\n'

# The parent pane is deliberately one that does not exist, so this case exercises the
# host fallback selected by the channel.
create_meta ide-dispatch '%999' host superset '%999'
host_meta="$(megabrain_dispatch_meta_read ide-dispatch)"
assert_equal "$(megabrain_parent_notify_channel "$host_meta")" superset
superset_send_count=0
megabrain_superset_available() { return 0; }
megabrain_superset() {
  if [ "$1" = terminals ] && [ "$2" = send ]; then
    superset_send_count=$((superset_send_count + 1))
    printf '{"ok":true}\n'
  else
    return 1
  fi
}
megabrain_parent_notify_dispatch "$host_meta"
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" delivered
assert_equal "$superset_send_count" 1
megabrain_parent_notify_waiter_register ide-dispatch "$host_meta"
megabrain_parent_notify_dispatch "$host_meta"
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" suppressed
assert_equal "$superset_send_count" 1
megabrain_parent_notify_waiter_unregister ide-dispatch
printf 'Superset fallback: send submitted for missing pane, waiter suppressed\n'

nudged_id=nudge-watch
create_meta "$nudged_id" "$parent_pane"
watch_output="$state_dir/watch.json"
env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID="$parent_id" "$root/megabrain" orchestrate watch "$nudged_id" --timeout 3 --wait-mode nudge --json >"$watch_output" &
watch_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -f "$state_dir/dispatches/$nudged_id/waiter.json" ]; then
    break
  fi
  sleep 0.05
done
append_message "$nudged_id" 'nudge woke watcher'
nudge_meta="$(megabrain_dispatch_meta_read "$nudged_id")"
megabrain_parent_notify_dispatch "$nudge_meta"
wait "$watch_pid"
assert_equal "$(jq -r '.messages[0].text' "$watch_output")" 'nudge woke watcher'
# The follower never writes again after the wake line, so an unreaped one holds the
# watch process in wait4 forever and the command never returns.
assert_equal "$(pgrep -f "tail -n \+[0-9]* -f $state_dir/dispatches/$nudged_id/nudge.log" | wc -l | tr -d ' ')" 0
assert_equal "$(ls -d "${TMPDIR:-/tmp}"/megabrain-wake.* 2>/dev/null | wc -l | tr -d ' ')" 0
printf 'nudge mode: watch blocked, woke from pointer marker, and left no follower\n'

outside_state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-nudge-outside.XXXXXX")"
outside_session="out-$$"
env MEGABRAIN_STATE_DIR="$outside_state_dir" tmux -L "$outside_socket" new-session -d -s "$outside_session" bash
env MEGABRAIN_STATE_DIR="$outside_state_dir" tmux -L "$outside_socket" set-environment -t "$outside_session" MEGABRAIN_STATE_DIR "$outside_state_dir"
outside_pane="$(tmux -L "$outside_socket" display-message -p -t "$outside_session" '#{pane_id}')"
outside_tmux="$(tmux -L "$outside_socket" display-message -p -t "$outside_pane" '#{socket_path},#{pid},#{session_id}')"
env MEGABRAIN_STATE_DIR="$outside_state_dir" tmux -L "$outside_socket" send-keys -t "$outside_pane" -l "PS1='OUTSIDE$ '; export PS1; printf 'outside-ready\\n'"
env MEGABRAIN_STATE_DIR="$outside_state_dir" tmux -L "$outside_socket" send-keys -t "$outside_pane" Enter
wait_for_pane_text "$outside_pane" outside-ready "$outside_socket"
megabrain_dispatch_meta_write cross-context parent-terminal superset superset workspace-test cross-context-child "$root" main codex label running gpt-5 true codex "$outside_session" "$outside_pane" tmux tmux "$outside_session" "$outside_pane" "$workspace_id" >/dev/null
cross_context_meta="$(megabrain_dispatch_meta_read cross-context)"
export TMUX="$outside_tmux" TMUX_PANE="$outside_pane"
cross_context_before="$(env MEGABRAIN_STATE_DIR="$outside_state_dir" tmux -L "$outside_socket" capture-pane -J -p -t "$outside_pane" -S -20)"
megabrain_parent_notify_dispatch "$cross_context_meta"
cross_context_after="$(env MEGABRAIN_STATE_DIR="$outside_state_dir" tmux -L "$outside_socket" capture-pane -J -p -t "$outside_pane" -S -20)"
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" suppressed
assert_equal "$cross_context_before" "$cross_context_after"
assert_contains "$(cat "$state_dir/dispatches/cross-context/nudge.log")" 'outcome=suppressed reason=state-directory-mismatch'
printf 'cross-context parent notice is suppressed and logged\n'

export TMUX="$tmux_info" TMUX_PANE="$parent_pane"
create_meta same-context "$parent_pane"
same_context_meta="$(megabrain_dispatch_meta_read same-context)"
megabrain_parent_notify_dispatch "$same_context_meta"
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" queued
same_context_capture="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -20)"
assert_contains "$same_context_capture" 'mail: megabrain orchestrate watch same-context'
printf 'same-context parent notice still delivers\n'

tmux_cmd set-environment -gu MEGABRAIN_STATE_DIR >/dev/null 2>&1 || true
tmux_cmd new-session -d -s "$no_context_session" -x 120 -y 30 bash
no_context_pane="$(tmux_cmd display-message -p -t "$no_context_session" '#{pane_id}')"
tmux_cmd set-environment -u -t "$no_context_session" MEGABRAIN_STATE_DIR >/dev/null 2>&1 || true
tmux_cmd send-keys -t "$no_context_pane" -l "PS1='NO-CONTEXT$ '; export PS1; printf 'no-context-ready\\n'"
tmux_cmd send-keys -t "$no_context_pane" Enter
wait_for_pane_text "$no_context_pane" no-context-ready
create_meta no-context "$no_context_pane" tmux superset "$no_context_pane" "$no_context_session"
no_context_meta="$(megabrain_dispatch_meta_read no-context)"
megabrain_parent_notify_dispatch "$no_context_meta"
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" not-typed
assert_contains "$(cat "$state_dir/dispatches/no-context/nudge.log")" 'outcome=not-typed reason=parent-notified'
printf 'tmux without state context delivers from the dispatch location\n'

rename_home="$state_dir/rename-home"
mkdir -p "$rename_home"
saved_home="$HOME"
saved_state_dir="$MEGABRAIN_STATE_DIR"
saved_dispatch_dir="$MEGABRAIN_DISPATCH_DIR"
HOME="$rename_home"
rename_old_state="$HOME/.megabrain"
rename_new_state="$HOME/.third-state"
MEGABRAIN_STATE_DIR="$rename_old_state"
MEGABRAIN_DISPATCH_DIR="$rename_old_state/dispatches"
create_meta renamed-context "$no_context_pane" tmux superset "$no_context_pane" "$no_context_session"
mv "$rename_old_state" "$rename_new_state"
MEGABRAIN_STATE_DIR="$rename_new_state"
MEGABRAIN_DISPATCH_DIR="$rename_new_state/dispatches"
renamed_meta="$(megabrain_dispatch_meta_read renamed-context)"
megabrain_parent_notify_dispatch "$renamed_meta"
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" not-typed
assert_contains "$(cat "$rename_new_state/dispatches/renamed-context/nudge.log")" 'outcome=not-typed reason=parent-notified'
HOME="$saved_home"
MEGABRAIN_STATE_DIR="$saved_state_dir"
MEGABRAIN_DISPATCH_DIR="$saved_dispatch_dir"
printf 'renamed state directory still delivers without a fixed path\n'

final_capture="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -20)"
printf '%s\n' "$final_capture" >/dev/null
trap - EXIT
cleanup
printf 'ok: parent notify tmux, IDE, suppression, queue safety, and wake behavior\n'
