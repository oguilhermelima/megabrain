#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/fixtures/a-dispatch-meta.sh"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-reply-nudge.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$state_root/.megabrain-test-state"
require_megabrain_test_state

state_root="$(cd -P "$state_root" && pwd -P)"
state_dir="$state_root/state"
socket_name=mbreply
session_name=megabrain-reply-nudge
parent_pane=""
child_pane=""

unset TMUX TMUX_PANE ORCA_TERMINAL_HANDLE SUPERSET_TERMINAL_ID
export TMUX_TMPDIR="$state_root"
export MEGABRAIN_STATE_DIR="$state_dir"

tmux_cmd() {
  tmux -L "$socket_name" "$@"
}

cleanup() {
  local rc=$?
  command tmux -L "$socket_name" kill-server >/dev/null 2>&1 || true
  rm -rf "$state_root"
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

tmux_cmd new-session -d -s "$session_name" -x 120 -y 30 bash
parent_pane="$(tmux_cmd display-message -p -t "$session_name" '#{pane_id}')"
tmux_info="$(tmux_cmd display-message -p -t "$parent_pane" '#{socket_path},#{pid},#{session_id}')"
case "${tmux_info%%,*}" in
  "$state_root"/*) ;;
  *) fail "refusing to run: the tmux server is outside $state_root" ;;
esac
export TMUX="$tmux_info"
export TMUX_PANE="$parent_pane"
parent_identity="$session_name:$parent_pane"
child_pane="$(tmux_cmd split-window -d -t "$session_name" -c "$root" -P -F '#{pane_id}' 'trap "" INT; sleep 60')"

# Fixture built directly with jq (tests/fixtures/a-dispatch-meta.sh): no lib/ sourcing, no
# megabrain_dispatch_meta_write.
create_meta() {
  local dispatch_id="$1" pane="$2" agent="${3:-codex}"
  write_dispatch_meta "$state_dir" "$dispatch_id" \
    parentSessionId="$parent_identity" parentHost=tmux childHost=tmux terminalId=child-terminal \
    worktreePath="$root" branch=main agent="$agent" agentId="$agent" label=label state=running \
    model=gpt-5 modelHonored=true tmuxSession="$session_name" tmuxPane="$pane" \
    runtime=tmux spawnRuntime=tmux parentTmuxSession="$session_name" parentTmuxPane="$parent_pane" >/dev/null
  MEGABRAIN_STATE_DIR="$state_dir" "$root/.build/megabrain" db import "$state_dir" --replace >/dev/null
}

# `orchestrate reply` writes the queue message durably before delivery. A process that never reads
# stdin exercises real pty backpressure; the command must return without typing into a busy pane.
# This case uses real tmux, while the idle-gated transport cases below use an explicit fake.
dispatch_id=bounded-reply
create_meta "$dispatch_id" "$child_pane"
answer="$(printf '%65536s' '' | tr ' ' x)"
done_file="$state_root/reply-done"
reply_output="$state_root/reply-output"
reply_error="$state_root/reply-error"
(
  if "$root/.build/megabrain" orchestrate reply "$dispatch_id" --text "$answer" --json >"$reply_output" 2>"$reply_error"; then
    printf '0\n' >"$done_file"
  else
    printf '1\n' >"$done_file"
  fi
) &
reply_pid=$!
started="$(date +%s)"
while [ ! -f "$done_file" ]; do
  now="$(date +%s)"
  [ $((now - started)) -lt 5 ] || break
  sleep 0.05
done
if [ ! -f "$done_file" ]; then
  kill "$reply_pid" >/dev/null 2>&1 || true
  wait "$reply_pid" 2>/dev/null || true
  fail 'reply remained blocked while the child pane did not read stdin'
fi
wait "$reply_pid"
assert_equal "$(jq -r '.status' "$reply_output")" queued
reply_message="$(MEGABRAIN_STATE_DIR="$state_dir" "$root/.build/megabrain" db show "$dispatch_id" --json | jq '.messages[0]')"
assert_equal "$(jq -r '.seq' <<<"$reply_message")" 1
assert_equal "$(jq -r '.text' <<<"$reply_message")" "$answer"
printf 'busy child: reply returns within the bound and keeps the full queue message\n'

tmux_cmd kill-pane -t "$child_pane"

# A fake "tmux" placed first on PATH records terminal keystrokes. The pane screen is not a known
# idle composer, so delivery must remain deferred and issue no send-keys calls.
fake_bin="$state_root/bin"
mkdir -p "$fake_bin"
send_log="$state_root/send.log"
cat >"$fake_bin/tmux" <<EOF
#!/usr/bin/env bash
case "\$1" in
  list-panes) printf '%s\\n' '%fake|\$1' ;;
  display-message) printf '%s\n' "$session_name" ;;
  send-keys) printf '%s\n' "\$*" >>"$send_log" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$fake_bin/tmux"

# Each agent stays on the deferred path when the screen cannot prove idle state and an empty
# composer. The full message remains in the durable queue regardless of that transport result.
scenario_agent_nudge() {
  local agent="$1"
  local dispatch_id="nudge-$agent"
  : >"$send_log"
  create_meta "$dispatch_id" '%fake' "$agent"
  local output message
  output="$(PATH="$fake_bin:$PATH" "$root/.build/megabrain" orchestrate reply "$dispatch_id" --text "answer for $agent" --json)"
  assert_equal "$(jq -r '.status' <<<"$output")" queued
  assert_equal "$(jq -r '.nudge' <<<"$output")" not-typed
  message="$(MEGABRAIN_STATE_DIR="$state_dir" "$root/.build/megabrain" db show "$dispatch_id" --json | jq '.messages[0]')"
  assert_equal "$(jq -r '.text' <<<"$message")" "answer for $agent"
  assert_contains "$(jq -r '.sessionId' <<<"$message")" ':'
  [ ! -s "$send_log" ] || fail "$agent: typed into an unverified composer: $(cat "$send_log")"
  printf '%s nudge: deferred without typing into an unverified composer\n' "$agent"
}

scenario_agent_nudge claude
scenario_agent_nudge codex
scenario_agent_nudge agy
scenario_agent_nudge ghost-unregistered-agent

printf 'ok: bounded reply nudge scenarios\n'
