#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d /tmp/mbclose.XXXXXX)"
state_dir="$(cd -P "$state_dir" && pwd -P)"
unset TMUX TMUX_PANE
export TMUX_TMPDIR="$state_dir"
socket_name="megabrainclose-$$"
session_name="megabrain-close-parent-$$"
dedicated_session_name="megabrain-close-dedicated-$$"
parent_pane=""
parent_tmux=""
close_log="$state_dir/host-close.log"
default_tmux_dir="/tmp/tmux-$(id -u)"

cleanup() {
  local rc=$?
  tmux -L "$socket_name" kill-server >/dev/null 2>&1 || true
  rm -rf "$state_dir"
  return "$rc"
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
export MEGABRAIN_ROOT="$root"
outside_tmux_before="$(find "$default_tmux_dir" -mindepth 1 -maxdepth 1 -type s -print 2>/dev/null | sort || true)"

source "$root/tests/fixtures/a-dispatch-meta.sh"

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

assert_failure_contains() {
  local expected="$1" output
  shift
  if output="$("$@" 2>&1)"; then
    fail "expected command to fail: $*"
  fi
  printf '%s\n' "$output"
  assert_contains "$output" "$expected"
}

fake_bin="$state_dir/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/orca" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = terminal ] && [ "${2:-}" = close ]; then
  printf 'close:%s\n' "${4:-}" >>"${MB_CLOSE_LOG:?}"
  case "${MB_CLOSE_MODE:-success}" in
    absent)
      printf '%s\n' '{"error":{"code":"WORKSPACE_NOT_FOUND","message":"workspace not found"}}' >&2
      exit 1
      ;;
    failure)
      printf '%s\n' '{"error":{"code":"PERMISSION_DENIED","message":"terminal close denied by host"}}' >&2
      exit 1
      ;;
    *) printf '%s\n' '{"ok":true}' ; exit 0 ;;
  esac
fi
exit 1
EOF
cat >"$fake_bin/megabrain_superset" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = terminals ] && [ "${2:-}" = close ]; then
  case "${MB_CLOSE_MODE:-success}" in
    absent)
      printf '%s\n' '{"error":{"code":"WORKSPACE_NOT_FOUND","message":"workspace not found"}}' >&2
      exit 1
      ;;
    failure)
      printf '%s\n' '{"error":{"code":"PERMISSION_DENIED","message":"terminal close denied by host"}}' >&2
      exit 1
      ;;
    *) printf '%s\n' '{"ok":true}' ; exit 0 ;;
  esac
fi
exit 1
EOF
chmod +x "$fake_bin/orca" "$fake_bin/megabrain_superset"
cp "$fake_bin/megabrain_superset" "$fake_bin/superset"
chmod +x "$fake_bin/superset"
export PATH="$fake_bin:$PATH"
export MB_CLOSE_LOG="$close_log"

compiled_close() {
  "$root/.build/megabrain" orchestrate close "$@"
}

tmux_cmd() {
  tmux -L "$socket_name" "$@"
}

# WHY: neither shell function below is ever reached. compiled_close drives .build/megabrain as a
# real subprocess, which sees the real $fake_bin/orca and $fake_bin/superset executables written
# above, not these in-process shell functions (a subprocess cannot see an unexported bash
# function), so both were already dead weight before this rewrite.

# childHost=tmux (not orca/superset): executeSpawn's tmux branch never calls host.create() for a
# tmux dispatch (src/cli/commands/orchestrate-close.ts's own WHY comment on this exact point), so
# a real tmux dispatch's childHost is always "tmux" and getHost("tmux") is undefined -- there is
# never a separate host terminal for close to close.
create_meta() {
  local dispatch_id="$1" tmux_session="$2" tmux_pane="$3" parent_session="$4" parent_pane="$5"
  write_dispatch_meta "$state_dir" "$dispatch_id" \
    parentHost=orca childHost=tmux workspaceId=workspace-test terminalId="$dispatch_id-terminal" \
    worktreePath="$root" branch=fix/close-never-kills-caller \
    tmuxSession="$tmux_session" tmuxPane="$tmux_pane" runtime=tmux \
    parentTmuxSession="$parent_session" parentTmuxPane="$parent_pane" parentWorkspaceId=workspace-test >/dev/null
}

set_terminal_state() {
  local dispatch_id="$1" state="$2" path="$state_dir/dispatches/$1/meta.json" tmp
  tmp="$(mktemp "$state_dir/dispatches/$1/.terminal-state.XXXXXX")"
  jq --arg state "$state" '.terminalState = $state' "$path" >"$tmp"
  mv -f "$tmp" "$path"
}

set_dispatch_state() {
  local dispatch_id="$1" state="$2" path="$state_dir/dispatches/$1/meta.json" tmp
  tmp="$(mktemp "$state_dir/dispatches/$1/.state.XXXXXX")"
  jq --arg state "$state" '.state = $state' "$path" >"$tmp"
  mv -f "$tmp" "$path"
}

assert_pane_alive() {
  tmux_cmd display-message -p -t "$1" '#{pane_id}' >/dev/null 2>&1 || fail "pane is not alive: $1"
}

assert_session_alive() {
  tmux_cmd has-session -t "$1" >/dev/null 2>&1 || fail "session is not alive: $1"
}

assert_file() {
  [ -f "$1" ] || fail "expected file to exist: $1"
}

tmux_cmd new-session -d -s "$session_name" bash
parent_pane="$(tmux_cmd display-message -p -t "$session_name" '#{pane_id}')"
parent_tmux="$(tmux_cmd display-message -p -t "$parent_pane" '#{socket_path},#{pid},#{session_id}')"
export TMUX="$parent_tmux" TMUX_PANE="$parent_pane" ORCA_TERMINAL_HANDLE=parent-terminal
unset SUPERSET_TERMINAL_ID

create_meta self-close "$session_name" "$parent_pane" "$session_name" "$parent_pane"
assert_failure_contains 'refusing to close dispatch self-close' compiled_close self-close --json
assert_pane_alive "$parent_pane"
assert_session_alive "$session_name"
printf 'caller pane is protected from normal close\n'

create_meta force-self-close "$session_name" "$parent_pane" "$session_name" "$parent_pane"
set_terminal_state force-self-close retained
assert_failure_contains 'refusing to close dispatch force-self-close' compiled_close force-self-close --force-release --json
assert_pane_alive "$parent_pane"
assert_session_alive "$session_name"
printf 'caller pane protection cannot be bypassed by force-release\n'

shared_pane="$(tmux_cmd split-window -v -t "$parent_pane" -P -F '#{pane_id}' bash)"
create_meta shared-child "$session_name" "$shared_pane" "$session_name" "$parent_pane"
before_panes="$(tmux_cmd list-panes -t "$session_name" | wc -l | tr -d ' ')"
shared_close_output="$(compiled_close shared-child --json)"
assert_contains "$shared_close_output" 'shared tmux session'
after_panes="$(tmux_cmd list-panes -t "$session_name" | wc -l | tr -d ' ')"
assert_equal "$before_panes" 2
assert_equal "$after_panes" 1
assert_pane_alive "$parent_pane"
assert_session_alive "$session_name"
[ ! -s "$close_log" ] || fail 'shared close attempted to close the host terminal'
assert_equal "$(jq -r '.state' "$state_dir/dispatches/shared-child/meta.json")" closed
printf 'shared-session child close removes only the child pane\n'

tmux_cmd new-session -d -s "$dedicated_session_name" bash
dedicated_pane="$(tmux_cmd display-message -p -t "$dedicated_session_name" '#{pane_id}')"
create_meta dedicated-child "$dedicated_session_name" "$dedicated_pane" "$session_name" "$parent_pane"
dedicated_close_output="$(compiled_close dedicated-child --json)"
assert_contains "$dedicated_close_output" 'exclusive tmux session'
if tmux_cmd has-session -t "$dedicated_session_name" >/dev/null 2>&1; then
  fail 'dedicated dispatch session is still alive'
fi
assert_pane_alive "$parent_pane"
assert_session_alive "$session_name"
# A real tmux dispatch's childHost is "tmux" (see the WHY comment on create_meta above), so close
# never has a separate host terminal to call orca/superset for -- unlike the old shell fixture
# (childHost=orca), which only ever worked by an identity accident the compiled binary's own
# comment documents as fixed. Dropped the close_log assertion; kept the session-teardown proof.
[ ! -s "$close_log" ] || fail 'dedicated close unexpectedly attempted a host terminal close'
assert_equal "$(jq -r '.state' "$state_dir/dispatches/dedicated-child/meta.json")" closed
printf 'dedicated-session child close tears down its exclusive tmux session\n'

automatic_session_name="megabrain-close-automatic-$$"
automatic_dispatch_id="automatic-release"
tmux_cmd new-session -d -s "$automatic_session_name" bash
automatic_pane="$(tmux_cmd display-message -p -t "$automatic_session_name" '#{pane_id}')"
automatic_transcript="$state_dir/dispatches/$automatic_dispatch_id/transcript"
mkdir -p "$(dirname "$automatic_transcript")"
printf '%s\n' 'automatic release transcript' >"$automatic_transcript"
tmux_cmd send-keys -t "$automatic_pane" -l \
  "export MEGABRAIN_DISPATCH_ID=$automatic_dispatch_id; (exec -a MEGABRAIN_DISPATCH_ID=$automatic_dispatch_id sleep 60)"
tmux_cmd send-keys -t "$automatic_pane" Enter
automatic_child_pid=""
automatic_pane_pid="$(tmux_cmd display-message -p -t "$automatic_pane" '#{pane_pid}')"
for attempt in $(seq 1 100); do
  automatic_child_pid="$(pgrep -P "$automatic_pane_pid" 2>/dev/null | head -n 1 || true)"
  [ -n "$automatic_child_pid" ] && break
  sleep 0.05
done
[ -n "$automatic_child_pid" ] || fail 'timed out waiting for automatic-release process'
write_dispatch_meta "$state_dir" "$automatic_dispatch_id" \
  parentHost=orca childHost=tmux workspaceId=workspace-test terminalId=automatic-terminal \
  worktreePath="$root" branch=fix/dispatch-process-lifetime \
  tmuxSession="$automatic_session_name" tmuxPane="$automatic_pane" runtime=tmux \
  parentTmuxSession="$session_name" parentTmuxPane="$parent_pane" parentWorkspaceId=workspace-test >/dev/null
set_dispatch_state "$automatic_dispatch_id" done
# RULE-3, not rewritten as a live assertion: reaching "done" no longer tears its own tmux session
# down by itself. queue-write.ts's updateMeta (the real production path behind `megabrain done`)
# only ever updates state/processState -- read in full, it never calls killSession/killPane or
# touches terminalState. The old shell's cascade (state=done -> megabrain_dispatch_release_
# terminal_process) had no caller left even before this rewrite (megabrain_dispatch_meta_update_
# state's only caller was the dead megabrain_dispatch_reply), consistent with the newer explicit
# orchestrate-close-owns-teardown model (see AGENTS.md's worker lifecycle: worker-stop/
# worker-release/terminal close are the lead's own explicit steps, not automatic). Killing the
# session directly here, to isolate and keep the read-fallback proof this scenario still has.
tmux_cmd kill-session -t "$automatic_session_name"
assert_file "$automatic_transcript"
assert_contains "$(cat "$automatic_transcript")" 'automatic release transcript'
automatic_read="$("$root/.build/megabrain" orchestrate read "$automatic_dispatch_id" --json)"
assert_equal "$(printf '%s' "$automatic_read" | jq -r '.source')" file
assert_equal "$(printf '%s' "$automatic_read" | jq -r '.text')" 'automatic release transcript'
printf 'a gone tmux dispatch keeps its transcript and orchestrate read falls back to it\n'

unproven_session_name="megabrain-close-unproven-$$"
unproven_dispatch_id="unproven-release"
tmux_cmd new-session -d -s "$unproven_session_name" bash
unproven_pane="$(tmux_cmd display-message -p -t "$unproven_session_name" '#{pane_id}')"
unproven_transcript="$state_dir/dispatches/$unproven_dispatch_id/transcript"
mkdir -p "$(dirname "$unproven_transcript")"
touch "$unproven_transcript"
write_dispatch_meta "$state_dir" "$unproven_dispatch_id" \
  parentHost=orca childHost=tmux workspaceId=workspace-test terminalId=unproven-terminal \
  worktreePath="$root" branch=fix/dispatch-process-lifetime \
  tmuxSession="$unproven_session_name" tmuxPane="$unproven_pane" runtime=tmux \
  parentTmuxSession="$session_name" parentTmuxPane="$parent_pane" parentWorkspaceId=workspace-test >/dev/null
# See the RULE-3 note above the "automatic-release" scenario: reaching "done" never auto-releases
# a tmux session anymore, proven or not, so this scenario's original proven/unproven distinction
# (does automatic release skip an unproven terminal) is now moot on both sides -- keeping it only
# to show a still-alive session survives a state change untouched, without claiming the release
# semantics it used to distinguish.
set_dispatch_state "$unproven_dispatch_id" done
assert_session_alive "$unproven_session_name"
tmux_cmd kill-session -t "$unproven_session_name"
printf 'a bare state change does not touch the tmux session either way\n'

unset TMUX TMUX_PANE ORCA_TERMINAL_HANDLE
export SUPERSET_TERMINAL_ID=parent-terminal

create_host_meta() {
  local dispatch_id="$1"
  write_dispatch_meta "$state_dir" "$dispatch_id" \
    childHost=superset workspaceId=workspace-test terminalId="$dispatch_id-terminal" \
    worktreePath="$root" state=running >/dev/null
}

host_close_mode=absent
create_host_meta host-terminal-absent
if absent_output="$(MB_CLOSE_MODE=absent compiled_close host-terminal-absent --json 2>&1)"; then
  :
else
  fail "a missing host terminal was treated as a close failure: $absent_output"
fi
assert_equal "$(jq -r '.state' "$state_dir/dispatches/host-terminal-absent/meta.json")" closed
assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/host-terminal-absent/meta.json")" released
printf 'host terminal already absent is an idempotent close\n'

host_close_mode=failure
create_host_meta host-terminal-failure
if failure_output="$(MB_CLOSE_MODE=failure compiled_close host-terminal-failure --json 2>&1)"; then
  fail 'a genuine host close failure unexpectedly succeeded'
fi
assert_contains "$failure_output" 'terminal close denied by host'
assert_equal "$(jq -r '.state' "$state_dir/dispatches/host-terminal-failure/meta.json")" running
printf 'genuine host close failure preserves its reason\n'

trap - EXIT
cleanup
outside_tmux_after="$(find "$default_tmux_dir" -mindepth 1 -maxdepth 1 -type s -print 2>/dev/null | sort || true)"
assert_equal "$outside_tmux_after" "$outside_tmux_before"
printf 'tmux socket isolation: no socket escaped the temporary directory\n'

printf 'ok: close self-protection and shared-session safety\n'
