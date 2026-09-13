#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
unset TMUX TMUX_PANE
state_dir=""
socket_name=megabrainloop
session_name=""
parent_pane=""
parent_tmux=""
child_pane=""
child_session=""
fake_send_mode=ok
fake_close=false
MEGABRAIN_TEST_RECEIPT_DELAY=0.2
timing_enabled=false
timing_start_ms=0
timing_last_ms=0

case "${MEGABRAIN_TEST_TIMING:-}" in
  1|true|yes) timing_enabled=true ;;
esac

timing_now_ms() {
  local value
  value="$(date +%s%N 2>/dev/null)"
  case "$value" in
    ''|*[!0-9]*) value="$(date +%s)000" ;;
    *) value=$((value / 1000000)) ;;
  esac
  printf '%s\n' "$value"
}

timing_begin() {
  [ "$timing_enabled" = true ] || return 0
  timing_start_ms="$(timing_now_ms)"
  timing_last_ms="$timing_start_ms"
}

timing_mark() {
  local phase="$1" now elapsed total
  [ "$timing_enabled" = true ] || return 0
  now="$(timing_now_ms)"
  elapsed=$((now - timing_last_ms))
  total=$((now - timing_start_ms))
  printf 'timing[%s] %s: +%sms (total %sms)\n' "$MEGABRAIN_TEST_RUNTIME" "$phase" "$elapsed" "$total"
  timing_last_ms="$now"
}

cleanup_tmux_server() {
  local directory="${1:-}"
  [ -n "$directory" ] || return 0
  TMUX_TMPDIR="$directory" env -u TMUX -u TMUX_PANE command tmux -L "$socket_name" kill-server >/dev/null 2>&1 || true
}

cleanup() {
  local rc=$?
  cleanup_tmux_server "$state_dir"
  [ -n "$state_dir" ] && rm -rf "$state_dir"
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
  local pane="$1" expected="$2" attempt=0 capture=""
  while [ "$attempt" -lt 200 ]; do
    capture="$(tmux_cmd capture-pane -p -J -t "$pane" -S -20)"
    case "$capture" in
      *"$expected"*) return 0 ;;
    esac
    sleep 0.05
    attempt=$((attempt + 1))
  done
  fail "timed out waiting for '$expected' in pane $pane"
}

tmux_cmd() {
  tmux -L "$socket_name" "$@"
}

set_state_dir() {
  cleanup_tmux_server "$state_dir"
  [ -n "$state_dir" ] && rm -rf "$state_dir"
  state_dir="$(cd -P "$1" && pwd -P)"
  export TMUX_TMPDIR="$state_dir"
  MEGABRAIN_STATE_DIR="$state_dir"
  MEGABRAIN_STATE_FILE="$state_dir/state.json"
  MEGABRAIN_CHAIN_FILE="$state_dir/chains.json"
  MEGABRAIN_DISPATCH_DIR="$state_dir/dispatches"
  MEGABRAIN_TMUX_SESSION_DIR="$state_dir/sessions"
  mkdir -p "$state_dir"
  mkdir -p "$state_dir/bin"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$state_dir/bin/codex"
  chmod +x "$state_dir/bin/codex"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "${1:-}" = terminals ] && [ "${2:-}" = list ]; then' \
    '  printf '\''{"sessions":[{"terminalId":"child-terminal","title":"megabrain-dispatch-%s"}]}\n'\'' "${MEGABRAIN_TEST_DISPATCH_ID:-}"' \
    'elif [ "${1:-}" = terminals ] && [ "${2:-}" = read ]; then' \
    '  printf '\''{"text":"READY"}\n'\''' \
    'else' \
    '  printf '\''{"ok":true}\n'\''' \
    'fi' >"$state_dir/bin/superset"
  chmod +x "$state_dir/bin/superset"
  export PATH="$state_dir/bin:$PATH"
  jq -n '{chains:{loop:{when:{parentAgent:"codex"},steps:[{agent:"codex",model:"gpt-5.6-luna",effort:"low"}]}},defaultSteps:[]}' >"$MEGABRAIN_CHAIN_FILE"
}

fake_codex() {
  :
}

orca() {
  local command_text="" session
  if [ "${1:-}" = terminal ] && [ "${2:-}" = create ]; then
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --command ]; then
        command_text="${2:-}"
        shift 2
      else
        shift
      fi
    done
    session="${command_text##* -s }"
    tmux_cmd new-session -d -s "$session" "$(megabrain_agent_command)"
    printf '{"result":{"terminal":{"handle":"child-terminal"}}}\n'
  elif [ "${1:-}" = terminal ] && [ "${2:-}" = close ]; then
    fake_close=true
    printf '{"ok":true}\n'
  else
    return 1
  fi
}

source "$root/lib/common.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-parent-notify.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-model.sh"
source "$root/lib/module-model-validation.sh"
source "$root/lib/module-worktree.sh"
source "$root/lib/module-chain.sh"

megabrain_context_detect() {
  printf '%s\n' "$MEGABRAIN_TEST_CONTEXT"
}

megabrain_workspace_id_for_target() {
  printf 'workspace-test\n'
}

megabrain_agent_command() {
  printf '%s\n' "awk '{ print \"agent-response:\" \$0; print \"CHILD$\"; fflush() }'"
}

schedule_receipt() {
  local dispatch_id="$1"
  (
    sleep "$MEGABRAIN_TEST_RECEIPT_DELAY"
    megabrain_dispatch_message_append "$dispatch_id" child received 'prompt received' child-terminal >/dev/null
  ) &
}

eval "$(declare -f megabrain_tmux_send_agent | sed 's/^megabrain_tmux_send_agent /megabrain_test_tmux_send_agent /')"
megabrain_tmux_send_agent() {
  local pane="$1" mode="${3:-command}" dispatch_id meta_path meta
  megabrain_test_tmux_send_agent "$@" || return $?
  if [ "$mode" = prompt ]; then
    for meta_path in "$MEGABRAIN_DISPATCH_DIR"/*/meta.json; do
      [ -f "$meta_path" ] || continue
      meta="$(cat "$meta_path")"
      dispatch_id="$(printf '%s' "$meta" | jq -r --arg pane "$pane" 'select(.state == "spawning" and .runtime == "tmux" and .tmuxPane == $pane) | .dispatchId // empty')"
      if [ -n "$dispatch_id" ]; then
        schedule_receipt "$dispatch_id"
        return 0
      fi
    done
  fi
  return 0
}

eval "$(declare -f megabrain_dispatch_native_send | sed 's/^megabrain_dispatch_native_send /megabrain_test_native_send /')"
megabrain_dispatch_native_send() {
  local meta="$1" text="$2" dispatch_id
  megabrain_test_native_send "$@" || return $?
  case "$text" in
    '[megabrain dispatch:'*)
      dispatch_id="$(printf '%s' "$meta" | jq -r '.dispatchId // empty')"
      [ -n "$dispatch_id" ] && schedule_receipt "$dispatch_id"
      ;;
  esac
  return 0
}

megabrain_superset_available() {
  return 0
}

megabrain_superset() {
  if [ "${1:-}" = terminals ] && [ "${2:-}" = create ]; then
    printf '{"terminalId":"child-terminal"}\n'
  elif [ "${1:-}" = terminals ] && [ "${2:-}" = read ]; then
    printf '{"text":"READY"}\n'
  elif [ "${1:-}" = terminals ] && [ "${2:-}" = list ]; then
    printf '{"sessions":[{"terminalId":"child-terminal","title":"megabrain-dispatch-%s"}]}\n' "${MEGABRAIN_TEST_DISPATCH_ID:-}"
  elif [ "${1:-}" = terminals ] && [ "${2:-}" = send ]; then
    [ "$fake_send_mode" = fail ] && return 1
    printf '%s\n' "${8:-}" >>"$state_dir/fake-sends.log"
    printf '{"ok":true}\n'
  elif [ "${1:-}" = terminals ] && [ "${2:-}" = close ]; then
    fake_close=true
    printf '{"ok":true}\n'
  else
    return 1
  fi
}

megabrain_tmux_available() {
  return 0
}

prepare_tmux_parent() {
  session_name="megabrain-loop-parent-$$"
  tmux_cmd new-session -d -s "$session_name" bash
  parent_pane="$(tmux_cmd display-message -p -t "$session_name" '#{pane_id}')"
  parent_tmux="$(tmux_cmd display-message -p -t "$parent_pane" '#{socket_path},#{pid},#{session_id}')"
  tmux_cmd set-environment -t "$session_name" MEGABRAIN_STATE_DIR "$state_dir"
  mkdir -p "$MEGABRAIN_TMUX_SESSION_DIR"
  jq -n --arg session "$session_name" --arg pane "$parent_pane" --arg path "/tmp" \
    '{tmuxSession: $session, agent: "claude", workingDirectory: $path, tmuxPane: $pane, role: "main", host: "tmux", createdAt: "2026-09-09T00:00:00Z"}' \
    >"$MEGABRAIN_TMUX_SESSION_DIR/top-coordinator.json"
  export TMUX="$parent_tmux" TMUX_PANE="$parent_pane"
  tmux_cmd send-keys -t "$parent_pane" -l "PS1='PARENT$ '; export PS1; printf 'parent-ready\\n'"
  tmux_cmd send-keys -t "$parent_pane" Enter
  wait_for_pane_text "$parent_pane" parent-ready
}

child_command() {
  local verb="$1" text="${2:-}"
  if [ "$MEGABRAIN_TEST_RUNTIME" = tmux ]; then
    if [ "$verb" = received ]; then
      env -u SUPERSET_TERMINAL_ID MEGABRAIN_STATE_DIR="$state_dir" ORCA_TERMINAL_HANDLE=parent-terminal TMUX="$child_tmux" TMUX_PANE="$child_pane" "$root/megabrain" "$verb"
    else
      env -u SUPERSET_TERMINAL_ID MEGABRAIN_STATE_DIR="$state_dir" ORCA_TERMINAL_HANDLE=parent-terminal TMUX="$child_tmux" TMUX_PANE="$child_pane" "$root/megabrain" "$verb" "$text"
    fi
  else
    if [ "$verb" = received ]; then
      env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" "$verb"
    else
      env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" "$verb" "$text"
    fi
  fi
}

child_check() {
  if [ "$MEGABRAIN_TEST_RUNTIME" = tmux ]; then
    env -u SUPERSET_TERMINAL_ID MEGABRAIN_STATE_DIR="$state_dir" ORCA_TERMINAL_HANDLE=parent-terminal TMUX="$child_tmux" TMUX_PANE="$child_pane" "$root/megabrain" check --timeout 0 --json
  else
    env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" check --timeout 0 --json
  fi
}

child_ack() {
  if [ "$MEGABRAIN_TEST_RUNTIME" = tmux ]; then
    env -u SUPERSET_TERMINAL_ID MEGABRAIN_STATE_DIR="$state_dir" ORCA_TERMINAL_HANDLE=parent-terminal TMUX="$child_tmux" TMUX_PANE="$child_pane" "$root/megabrain" ack "$1" --json
  else
    env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" ack "$1" --json
  fi
}

parent_watch() {
  local timeout="${1:-0}"
  megabrain_dispatch_watch "$dispatch_id" --timeout "$timeout" --poll-interval 0 --wait-mode poll --full --json
}

parent_ack() {
  megabrain_dispatch_ack "$dispatch_id" "$1" --json
}

assert_parent_receipt() {
  local delivery="$1"
  assert_equal "$(jq -r '.status' <<<"$delivery")" received
  assert_equal "$(jq -r '.messages[0].type' <<<"$delivery")" received
  assert_equal "$(jq -r '.messages[0].text' <<<"$delivery")" 'prompt received'
}

parent_watch_actionable() {
  local delivery delivery_type delivery_id
  while :; do
    delivery="$(parent_watch 10)"
    delivery_type="$(jq -r '.messages[0].type // empty' <<<"$delivery")"
    case "$delivery_type" in
      received)
        assert_parent_receipt "$delivery"
        delivery_id="$(jq -r '.deliveryId' <<<"$delivery")"
        parent_ack "$delivery_id" >/dev/null
        ;;
      ask|done|stalled|usage)
        printf '%s\n' "$delivery"
        return 0
        ;;
      *)
        fail "unexpected parent mail type: ${delivery_type:-none}"
        ;;
    esac
  done
}

run_flow() {
  local runtime="$1" chain_output dispatch_meta dispatch_id delivery replay delivery_id reply_result push_check push_ack push_receipt push_receipt_id
  local question_delivery question_delivery_id pull_result pull_delivery_id pull_receipt pull_receipt_id done_delivery done_delivery_id
  local busy_pane busy_before receipt_before receipt_after ask_capture ask_pointer reply_capture reply_send_log
  MEGABRAIN_TEST_RUNTIME="$runtime"
  timing_begin
  fake_send_mode=ok
  export MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS=1
  export MEGABRAIN_PROMPT_RECEIPT_POLL_INTERVAL=0.05
  fake_close=false
  set_state_dir "$(mktemp -d "/tmp/mblp-$runtime.XXXXXX")"
  export MEGABRAIN_TEST_CONTEXT
  if [ "$runtime" = tmux ]; then
    MEGABRAIN_TEST_CONTEXT=orca
    export ORCA_TERMINAL_HANDLE=parent-terminal
    unset SUPERSET_TERMINAL_ID
    prepare_tmux_parent
    spawn_choice=true
  else
    MEGABRAIN_TEST_CONTEXT=superset
    export SUPERSET_TERMINAL_ID=parent-terminal
    unset ORCA_TERMINAL_HANDLE TMUX TMUX_PANE
    spawn_choice=false
  fi
  timing_mark 'setup'
  chain_output="$(command_chain_run loop --parent-agent codex --worktree "$root" --prompt chain-launch --tmux "$spawn_choice" --json)"
  assert_equal "$(printf '%s' "$chain_output" | jq -r '.step')" 1
  assert_equal "$(printf '%s' "$chain_output" | jq -r '.agent')" codex
  dispatch_id="$(printf '%s' "$chain_output" | jq -r '.dispatch.dispatch // empty')"
  [ -n "$dispatch_id" ] || fail "$runtime chain did not launch a dispatch"
  export MEGABRAIN_TEST_DISPATCH_ID="$dispatch_id"
  if [ "$runtime" = tmux ]; then
    assert_equal "$(tmux_cmd show-environment -t "$session_name" MEGABRAIN_STATE_DIR)" "MEGABRAIN_STATE_DIR=$state_dir"
  fi
  dispatch_meta="$(megabrain_dispatch_meta_read "$dispatch_id")"
  assert_equal "$(printf '%s' "$dispatch_meta" | jq -r '.promptDelivered')" true
  if [ "$runtime" = tmux ]; then
    child_session="$(printf '%s' "$dispatch_meta" | jq -r '.tmuxSession')"
    child_pane="$(printf '%s' "$dispatch_meta" | jq -r '.tmuxPane')"
    child_tmux="$(tmux_cmd display-message -p -t "$child_pane" '#{socket_path},#{pid},#{session_id}')"
    assert_contains "$(tmux_cmd capture-pane -p -t "$child_pane" -S -30)" 'agent-response:chain-launch'
  else
    assert_contains "$(cat "$state_dir/fake-sends.log")" chain-launch
    assert_not_equal "$dispatch_id" "$(printf '%s' "$dispatch_meta" | jq -r '.terminalId')"
    assert_contains "$(cat "$state_dir/fake-sends.log")" "SUPERSET_TERMINAL_ID=child-terminal"
    assert_contains "$(cat "$state_dir/fake-sends.log")" "MEGABRAIN_DISPATCH_ID=$dispatch_id"
    assert_contains "$(cat "$state_dir/fake-sends.log")" "MEGABRAIN_STATE_DIR=$state_dir"
  fi
  timing_mark 'spawn and prompt'
  receipt_delivery="$(parent_watch 10)"
  assert_parent_receipt "$receipt_delivery"
  receipt_delivery_id="$(jq -r '.deliveryId' <<<"$receipt_delivery")"
  parent_ack "$receipt_delivery_id" >/dev/null
  timing_mark 'initial receipt'
  child_command ask "$runtime-question" >/dev/null
  if [ "$runtime" = tmux ]; then
    ask_capture="$(tmux_cmd capture-pane -J -p -t "$parent_pane" -S -30)"
    ask_pointer="$(megabrain_tmux_nudge_text_for_pane "$parent_pane" "mail: megabrain orchestrate watch $dispatch_id")"
    assert_contains "$ask_capture" "$ask_pointer"
  fi
  delivery="$(parent_watch_actionable)"
  replay="$(parent_watch)"
  delivery_id="$(jq -r '.deliveryId' <<<"$delivery")"
  assert_equal "$(jq -r '.messages[0].text' <<<"$delivery")" "$runtime-question"
  assert_equal "$(jq -r '.replayed' <<<"$replay")" true
  assert_equal "$(jq -r '.deliveryId' <<<"$replay")" "$delivery_id"
  parent_ack "$delivery_id" >/dev/null
  timing_mark 'ask and replay'
  reply_result="$(megabrain_dispatch_reply "$dispatch_id" --text "printf $runtime-push-received" --json)"
  assert_equal "$(jq -r '.status' <<<"$reply_result")" queued
  if [ "$runtime" = tmux ]; then
    reply_capture="$(tmux_cmd capture-pane -p -t "$child_pane" -S -30)"
    assert_contains "$reply_capture" "megabrain check"
    assert_not_contains "$reply_capture" "printf $runtime-push-received"
  else
    reply_send_log="$(cat "$state_dir/fake-sends.log")"
    assert_contains "$reply_send_log" 'megabrain check'
    assert_not_contains "$reply_send_log" "printf $runtime-push-received"
  fi
  push_check="$(child_check)"
  assert_contains "$(jq -r '.text' <<<"$push_check")" "$runtime-push-received"
  push_delivery="$(jq -r '.deliveryId' <<<"$push_check")"
  push_ack="$(child_ack "$push_delivery")"
  assert_equal "$(jq -r '.duplicate' <<<"$push_ack")" false
  push_receipt="$(parent_watch)"
  assert_equal "$(jq -r '.messages[0].type' <<<"$push_receipt")" ack
  assert_equal "$(jq -r '.messages[0].text' <<<"$push_receipt")" "$push_delivery"
  push_receipt_id="$(jq -r '.deliveryId' <<<"$push_receipt")"
  parent_ack "$push_receipt_id" >/dev/null
  timing_mark 'push reply'
  child_command ask "$runtime-pull-question" >/dev/null
  question_delivery="$(parent_watch)"
  question_delivery_id="$(jq -r '.deliveryId' <<<"$question_delivery")"
  parent_ack "$question_delivery_id" >/dev/null
  if [ "$runtime" = tmux ]; then
    busy_pane="$(tmux_cmd split-window -v -t "$child_session" -P -F '#{pane_id}' "printf '%s' 'Working · esc to interrupt'; exec tail -f /dev/null")"
    wait_for_pane_text "$busy_pane" 'Working · esc to interrupt'
    busy_before="$(tmux_cmd capture-pane -p -t "$busy_pane" -S -10)"
    jq --arg pane "$busy_pane" '.tmuxPane = $pane' "$state_dir/dispatches/$dispatch_id/meta.json" >"$state_dir/meta.tmp"
    mv -f "$state_dir/meta.tmp" "$state_dir/dispatches/$dispatch_id/meta.json"
    child_pane="$busy_pane"
  else
    fake_send_mode=fail
  fi
  pull_result="$(megabrain_dispatch_reply "$dispatch_id" --text "printf $runtime-pull-received" --json)"
  if [ "$runtime" = tmux ]; then
    case "$(jq -r '.status' <<<"$pull_result")" in
      queued|replied) ;;
      *) fail "unexpected tmux pull status: $pull_result" ;;
    esac
    assert_contains "$busy_before" 'Working · esc to interrupt'
  else
    assert_equal "$(jq -r '.status' <<<"$pull_result")" queued
    assert_not_contains "$(cat "$state_dir/fake-sends.log")" "$runtime-pull-received"
  fi
  pull_result="$(child_check)"
  assert_contains "$(jq -r '.text' <<<"$pull_result")" "$runtime-pull-received"
  pull_delivery_id="$(jq -r '.deliveryId' <<<"$pull_result")"
  child_ack "$pull_delivery_id" >/dev/null
  pull_receipt="$(parent_watch)"
  assert_equal "$(jq -r '.messages[0].type' <<<"$pull_receipt")" ack
  assert_equal "$(jq -r '.messages[0].text' <<<"$pull_receipt")" "$pull_delivery_id"
  pull_receipt_id="$(jq -r '.deliveryId' <<<"$pull_receipt")"
  parent_ack "$pull_receipt_id" >/dev/null
  timing_mark 'pull reply'
  child_command done "$runtime-complete" >/dev/null
  done_delivery="$(parent_watch)"
  assert_equal "$(jq -r '.messages[0].text' <<<"$done_delivery")" "$runtime-complete"
  done_delivery_id="$(jq -r '.deliveryId' <<<"$done_delivery")"
  parent_ack "$done_delivery_id" >/dev/null
  assert_equal "$(jq -r '.duplicate' <<<"$(parent_ack "$done_delivery_id")")" true
  queue_types="$(find "$state_dir/dispatches/$dispatch_id/messages" -name '*.json' -exec jq -r '[.from, .type] | join("/")' {} \; | sort)"
  assert_contains "$queue_types" 'child/received'
  assert_contains "$queue_types" 'child/ask'
  assert_contains "$queue_types" 'parent/reply'
  assert_contains "$queue_types" 'child/ack'
  assert_contains "$queue_types" 'child/done'
  if [ "$runtime" = tmux ]; then
    tmux_cmd kill-pane -t "$(printf '%s' "$dispatch_meta" | jq -r '.tmuxPane')"
    megabrain_dispatch_close "$dispatch_id" --json >/dev/null
    assert_equal "$(tmux_cmd has-session -t "$child_session" >/dev/null 2>&1; printf '%s' "$?")" 1
  else
    megabrain_dispatch_close "$dispatch_id" --json >/dev/null
  fi
  timing_mark 'done and close'
  assert_equal "$(jq -r '.state' "$state_dir/dispatches/$dispatch_id/meta.json")" closed
  assert_equal "$(find "$state_dir/dispatches/$dispatch_id/deliveries" -name '*.json' -exec jq -r 'select(.status == "outstanding") | .id' {} \; | wc -l | tr -d ' ')" 0
  printf '%s end-to-end: chain, queue, replay, push, busy reply, pull, done, duplicate ack, and close\n' "$runtime"
}
