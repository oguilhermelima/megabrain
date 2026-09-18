#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d /tmp/mbnotify.XXXXXX)"
state_dir="$(cd -P "$state_dir" && pwd -P)"
unset TMUX TMUX_PANE
export TMUX_TMPDIR="$state_dir"
socket_name="megabrainnotify-$$"
parent_session="megabrain-notify-parent-$$"
unknown_session="megabrain-notify-unknown-$$"
failed_session="megabrain-notify-failed-$$"
dedicated_session="megabrain-notify-dedicated-$$"
parent_pane=""
parent_tmux=""

cleanup() {
  local rc=$?
  tmux -L "$socket_name" kill-server >/dev/null 2>&1 || true
  rm -rf "$state_dir"
  return "$rc"
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
export ORCA_TERMINAL_HANDLE=parent-terminal
unset SUPERSET_TERMINAL_ID

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

tmux_cmd() {
  tmux -L "$socket_name" "$@"
}

create_meta() {
  local dispatch_id="$1" session="$2" pane="$3" child_pane="$3" parent_session_arg parent_pane_arg agent="${6:-codex}"
  parent_session_arg="${4:-$session}"
  parent_pane_arg="${5:-$pane}"
  [ "$child_pane" = "$parent_pane" ] && child_pane="%child-$dispatch_id"
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal orca orca "" "$dispatch_id-terminal" \
    "$root" main "$agent" label running gpt-5 true "$agent" "$session" "$child_pane" tmux tmux \
    "$parent_session_arg" "$parent_pane_arg" "" >/dev/null
}

register_parent() {
  local session="$1" agent="$2"
  mkdir -p "$state_dir/sessions"
  jq -n --arg session "$session" --arg agent "$agent" --arg pane "$parent_pane" \
    '{tmuxSession: $session, agent: $agent, workingDirectory: "/tmp", tmuxPane: $pane, role: "main"}' \
    >"$state_dir/sessions/$session.json"
}

tmux_cmd new-session -d -s "$parent_session" "printf '%s' 'Working · esc to interrupt'; sleep 5"
parent_pane="$(tmux_cmd display-message -p -t "$parent_session" '#{pane_id}')"
parent_tmux="$(tmux_cmd display-message -p -t "$parent_pane" '#{socket_path},#{pid},#{session_id}')"
export TMUX="$parent_tmux" TMUX_PANE="$parent_pane"
register_parent "$parent_session" claude
create_meta queueing-parent "$parent_session" "$parent_pane"
queueing_meta="$(megabrain_dispatch_meta_read queueing-parent)"
megabrain_parent_notify_dispatch "$queueing_meta"
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" queued
queueing_capture="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -20)"
assert_contains "$queueing_capture" 'mail: megabrain orchestrate watch queueing-parent'
assert_contains "$(cat "$state_dir/dispatches/queueing-parent/nudge.log")" 'outcome=queued reason=parent-notified'
assert_equal "$(wc -l <"$state_dir/dispatches/queueing-parent/nudge.log" | tr -d ' ')" 1
printf 'busy parent receives a notice without liveness probing\n'

tmux_cmd new-session -d -s "$unknown_session" "printf '%s' 'Working · esc to interrupt'; sleep 5"
unknown_pane="$(tmux_cmd display-message -p -t "$unknown_session" '#{pane_id}')"
create_meta unrecognised-parent "$unknown_session" "$unknown_pane" "$unknown_session" "$unknown_pane" agy
unknown_meta="$(megabrain_dispatch_meta_read unrecognised-parent)"
unknown_before="$(tmux_cmd capture-pane -J -p -t "$unknown_pane" -S -20)"
megabrain_parent_notify_dispatch "$unknown_meta"
unknown_after="$(tmux_cmd capture-pane -J -p -t "$unknown_pane" -S -20)"
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" not-typed
assert_equal "$MEGABRAIN_TMUX_SEND_STATUS" not-typed
assert_equal "$unknown_before" "$unknown_after"
assert_contains "$(cat "$state_dir/dispatches/unrecognised-parent/nudge.log")" 'outcome=not-typed reason=parent-notified'
assert_equal "$(wc -l <"$state_dir/dispatches/unrecognised-parent/nudge.log" | tr -d ' ')" 1
printf 'unrecognised busy parent keeps notice in the durable queue\n'

tmux_cmd new-session -d -s "$failed_session" "printf '%s' 'Working · esc to interrupt'; sleep 5"
failed_pane="$(tmux_cmd display-message -p -t "$failed_session" '#{pane_id}')"
register_parent "$failed_session" claude
create_meta failed-notice "$failed_session" "$failed_pane"
failed_meta="$(megabrain_dispatch_meta_read failed-notice)"
megabrain_parent_notify() {
  printf 'simulated send failure\n' >&2
  return 1
}
megabrain_parent_notify_dispatch "$failed_meta" || true
assert_equal "$MEGABRAIN_PARENT_NOTIFY_RESULT" failed
failed_log="$(cat "$state_dir/dispatches/failed-notice/nudge.log")"
assert_contains "$failed_log" 'outcome=failed reason=simulated send failure'
assert_equal "$(printf '%s\n' "$failed_log" | wc -l | tr -d ' ')" 1
printf 'notify log records delivered and failed outcomes\n'

megabrain_parent_notify_dispatch() {
  return 1
}
export ORCA_TERMINAL_HANDLE=child-terminal
unset TMUX TMUX_PANE
megabrain_dispatch_meta_write queue-safety parent-terminal orca orca "" child-terminal "$root" main codex label running gpt-5 true codex "" "" host ide >/dev/null
notify_bin="$state_dir/notify-bin"
mkdir -p "$notify_bin"
cat >"$notify_bin/orca" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$notify_bin/orca"
if ! child_output="$(env -i HOME="$state_dir/home" PATH="$notify_bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state_dir" \
  MEGABRAIN_DISPATCH_ID=queue-safety ORCA_TERMINAL_HANDLE=child-terminal \
  "$root/.build/megabrain" ask 'queue survives notify failure')"; then
  fail 'child message failed when notify failed'
fi
assert_contains "$child_output" 'ask sent: queue-safety'
queue_message="$(find "$state_dir/dispatches/queue-safety/messages" -name '*.json' -print -quit)"
assert_equal "$(jq -r '.text' "$queue_message")" 'queue survives notify failure'
printf 'queue remains the source of truth when notify fails\n'

export ORCA_TERMINAL_HANDLE=parent-terminal
tmux_cmd split-window -v -t "$parent_pane" -P -F '#{pane_id}' bash >/dev/null
shared_pane="$(tmux_cmd list-panes -t "$parent_session" -F '#{pane_id}' | tail -n 1)"
create_meta shared-close "$parent_session" "$shared_pane"
shared_close="$(megabrain_dispatch_close shared-close --json)"
assert_equal "$(printf '%s' "$shared_close" | jq -r '.message')" \
  'tmux pane removed; the shared tmux session and host terminal tab were kept.'
printf 'shared close reports that session and host tab were kept\n'

tmux_cmd new-session -d -s "$dedicated_session" bash
dedicated_pane="$(tmux_cmd display-message -p -t "$dedicated_session" '#{pane_id}')"
create_meta exclusive-close "$dedicated_session" "$dedicated_pane" "$parent_session" "$parent_pane"
orca() {
  if [ "${1:-}" = terminal ] && [ "${2:-}" = close ]; then
    printf '{"ok":true}\n'
    return 0
  fi
  return 1
}
exclusive_close="$(megabrain_dispatch_close exclusive-close --json)"
assert_equal "$(printf '%s' "$exclusive_close" | jq -r '.message')" \
  'last tmux pane removed; the exclusive tmux session and host terminal tab were closed.'
printf 'exclusive close reports that session and host tab were closed\n'

printf 'ok: notice delivery, outcome logging, queue safety, and close reporting\n'
