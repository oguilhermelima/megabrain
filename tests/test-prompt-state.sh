#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-prompt-state.XXXXXX")"

cleanup() {
  rm -rf "$state_dir"
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
export SUPERSET_TERMINAL_ID=parent-terminal
unset TMUX TMUX_PANE

source "$root/lib/common.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-worktree.sh"

failures=0
pane_exists=false
cleanup_called=false
send_mode=success
prompt_transport_attempts=0
pipe_start_mode=success
pipe_start_calls=0

fail_test() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

assert_equal() {
  if [ "$1" != "$2" ]; then
    fail_test "expected '$2', got '$1'"
  fi
}

assert_true() {
  if [ "$1" != true ]; then
    fail_test "expected true, got '$1'"
  fi
}

assert_false() {
  if [ "$1" != false ]; then
    fail_test "expected false, got '$1'"
  fi
}

reset_fixture() {
  rm -rf "$state_dir"
  mkdir -p "$state_dir"
  pane_exists=true
  cleanup_called=false
  send_mode=success
  prompt_transport_attempts=0
  pipe_start_mode=success
  pipe_start_calls=0
  export MEGABRAIN_PROMPT_RECEIPT_ATTEMPTS=1
  export MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS=0
  export MEGABRAIN_PROMPT_RECEIPT_POLL_INTERVAL=0.01
}

# The launch path is exercised with transport and pane fakes; no agent process is started.
megabrain_dispatch_preamble() { printf 'test preamble\n'; }
megabrain_resolve_spawn_runtime() {
  MEGABRAIN_SPAWN_RUNTIME=tmux
  MEGABRAIN_SPAWN_CONTEXT=superset
}
megabrain_superset_available() { return 0; }
megabrain_tmux_existing_session_for_worktree() { MEGABRAIN_TMUX_EXISTING_SESSION=test-session; }
megabrain_tmux_host_terminal_for_session() { printf 'parent-terminal\n'; }
megabrain_tmux_split_pane() { printf 'test-pane\n'; }
megabrain_tmux_apply_config() { return 0; }
megabrain_tmux_wait_for_session() { return 0; }
megabrain_tmux_set_state_dir() { return 0; }
megabrain_tmux_pipe_pane_start() {
  pipe_start_calls=$((pipe_start_calls + 1))
  [ "$pipe_start_mode" = success ]
}
megabrain_tmux_pipe_pane_stop() { return 0; }
megabrain_agent_command() { printf 'true\n'; }
megabrain_tmux_model_substitution_report() { return 0; }
megabrain_tmux_agent_output_clean() { return 0; }
megabrain_tmux_send_agent() {
  local role="${3:-command}"
  if [ "$role" = prompt ]; then
    prompt_transport_attempts=$((prompt_transport_attempts + 1))
    [ "$send_mode" = success ] || return 1
  fi
  return 0
}
megabrain_tmux_cleanup_launch() {
  cleanup_called=true
  pane_exists=false
  return 0
}

dispatch_path() {
  find "$MEGABRAIN_DISPATCH_DIR" -mindepth 1 -maxdepth 1 -type d -print | head -n 1
}

create_host_dispatch() {
  local dispatch_id="$1" state="$2"
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal superset orca workspace-test child-terminal \
    "$root" main codex label "$state" gpt-5 true codex '' '' host ide >/dev/null
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

reset_fixture
if megabrain_launch_agent "$root" workspace-test codex gpt-5 medium slow-prompt test-label >/dev/null 2>&1; then
  launch_status=0
else
  launch_status=$?
fi
dispatch_dir="$(dispatch_path)"
dispatch_id="${dispatch_dir##*/}"
assert_equal "$launch_status" 0
assert_true "$pane_exists"
assert_false "$cleanup_called"
assert_equal "$pipe_start_calls" 1
assert_equal "$prompt_transport_attempts" 1
assert_equal "$(jq -r '.state' "$dispatch_dir/meta.json")" spawning
assert_equal "$(jq -r '.promptPublication' "$dispatch_dir/meta.json")" published
assert_equal "$(jq -r '.promptTransport' "$dispatch_dir/meta.json")" transported
assert_equal "$(jq -r '.promptReceipt' "$dispatch_dir/meta.json")" pending
assert_equal "$(jq -r '.promptState' "$dispatch_dir/meta.json")" awaiting-receipt
assert_equal "$(jq -r '.promptDelivery' "$dispatch_dir/meta.json")" pending
assert_equal "$(jq -r '.promptDelivered' "$dispatch_dir/meta.json")" false
[ -f "$dispatch_dir/messages/0001-parent-prompt.json" ] || fail_test 'published prompt was not persisted'
printf 'missing receipt leaves pane and dispatch intact\n'

megabrain_dispatch_message_append "$dispatch_id" child received 'prompt received' child-terminal >/dev/null
megabrain_dispatch_terminal_status() { MEGABRAIN_TERMINAL_STATUS=proven; }
megabrain_dispatch_parent_status() { MEGABRAIN_PARENT_STATUS=alive; }
megabrain_dispatch_reconcile_one "$dispatch_id" >/dev/null
assert_equal "$(jq -r '.promptReceipt' "$dispatch_dir/meta.json")" received
assert_equal "$(jq -r '.promptState' "$dispatch_dir/meta.json")" confirmed
assert_equal "$(jq -r '.promptDelivery' "$dispatch_dir/meta.json")" delivered
assert_equal "$(jq -r '.promptDelivered' "$dispatch_dir/meta.json")" true
printf 'reconcile records a later child receipt\n'

late_dispatch=late-receipt
create_host_dispatch "$late_dispatch" spawning
megabrain_dispatch_meta_update_prompt_layers "$late_dispatch" published transported pending awaiting-receipt __clear__
late_output="$(run_child_message "$late_dispatch" received 'prompt received')" || fail_test 'late receipt was rejected'
assert_equal "$late_output" "received sent: $late_dispatch"
assert_equal "$(jq -r '.promptReceipt' "$MEGABRAIN_DISPATCH_DIR/$late_dispatch/meta.json")" received
assert_equal "$(jq -r '.promptState' "$MEGABRAIN_DISPATCH_DIR/$late_dispatch/meta.json")" confirmed
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/$late_dispatch/meta.json")" running
printf 'late child receipt is honored and advances spawning\n'

done_output="$(run_child_message "$late_dispatch" done 'late completion')" || fail_test 'done after a late receipt was rejected'
assert_equal "$done_output" "done sent: $late_dispatch"
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/$late_dispatch/meta.json")" done
printf 'done after a late receipt follows the transition table\n'

closed_dispatch=closed-receipt
create_host_dispatch "$closed_dispatch" closed
closed_output="$(run_child_message "$closed_dispatch" received 'receipt after close')" || fail_test 'receipt for a closed dispatch crashed'
assert_equal "$closed_output" "received sent: $closed_dispatch"
assert_equal "$(jq -r '.promptReceipt' "$MEGABRAIN_DISPATCH_DIR/$closed_dispatch/meta.json")" received
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/$closed_dispatch/meta.json")" closed
printf 'receipt after close is recorded without reopening the dispatch\n'

failed_dispatch=failed-receipt
create_host_dispatch "$failed_dispatch" failed
megabrain_spawn_mark_prompt_failed "$failed_dispatch" prompt-send-failed
failed_output="$(run_child_message "$failed_dispatch" received 'receipt after failure')" || fail_test 'receipt for a failed dispatch crashed'
assert_equal "$failed_output" "received sent: $failed_dispatch"
assert_equal "$(jq -r '.promptReceipt' "$MEGABRAIN_DISPATCH_DIR/$failed_dispatch/meta.json")" received
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/$failed_dispatch/meta.json")" failed
printf 'receipt after failure is recorded without reopening the dispatch\n'

reset_fixture
pipe_start_mode=failure
if megabrain_launch_agent "$root" workspace-test codex gpt-5 medium no-transcript test-label >/dev/null 2>&1; then
  launch_status=0
else
  launch_status=$?
fi
dispatch_dir="$(dispatch_path)"
assert_equal "$launch_status" 1
assert_false "$pane_exists"
assert_equal "$(jq -r '.state' "$dispatch_dir/meta.json")" failed
assert_equal "$(jq -r '.promptState' "$dispatch_dir/meta.json")" failed
printf 'transcript pipe failure is loud and records a failed dispatch\n'

reset_fixture
send_mode=failure
if megabrain_launch_agent "$root" workspace-test codex gpt-5 medium disappeared-pane test-label >/dev/null 2>&1; then
  launch_status=0
else
  launch_status=$?
fi
dispatch_dir="$(dispatch_path)"
assert_equal "$launch_status" 1
assert_false "$pane_exists"
assert_true "$cleanup_called"
assert_equal "$(jq -r '.state' "$dispatch_dir/meta.json")" failed
assert_equal "$(jq -r '.promptState' "$dispatch_dir/meta.json")" failed
printf 'genuine transport failure still fails and cleans up\n'

if [ "$failures" -gt 0 ]; then
  printf '%s prompt-state assertions failed\n' "$failures" >&2
  exit 1
fi
printf 'ok: prompt publication, transport, receipt, and timeout safety\n'
