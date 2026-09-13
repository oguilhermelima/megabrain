#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-queue-control.XXXXXX")"
pane_fixture="$state_dir/pane.transcript"
stop_send_status=queued
stop_send_calls=0

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

export MEGABRAIN_STATE_DIR="$state_dir"
export SUPERSET_TERMINAL_ID=parent-terminal
unset TMUX TMUX_PANE ORCA_TERMINAL_HANDLE

source "$root/lib/common.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-orchestrate.sh"

megabrain_dispatch_native_send() {
  MEGABRAIN_DISPATCH_NATIVE_SEND_STATUS=typed
}

megabrain_parent_notify_dispatch() {
  return 0
}

megabrain_dispatch_terminal_status() {
  MEGABRAIN_TERMINAL_STATUS=proven
}

megabrain_tmux_capture_pane() {
  cat "$pane_fixture"
}

megabrain_tmux_agent_for_pane() {
  printf 'codex\n'
}

megabrain_tmux_send_interrupt() {
  stop_send_calls=$((stop_send_calls + 1))
  MEGABRAIN_TMUX_INTERRUPT_STATUS="$stop_send_status"
  [ "$stop_send_status" = queued ]
}

create_dispatch() {
  local dispatch_id="$1" runtime="${2:-tmux}"
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal superset superset workspace-test \
    "$dispatch_id-child" "$root" main codex label running gpt-5 true codex session-% "$dispatch_id-pane" \
    "$runtime" "$runtime" >/dev/null
}

set_pane_fixture() {
  cp "$root/tests/fixtures/agent-liveness/$1.transcript" "$pane_fixture"
}

scenario_empty_report() {
  local json plain
  json="$(megabrain_dispatch_empty_delivery_report empty-report true)"
  assert_equal "$(jq -r '.status' <<<"$json")" empty
  plain="$(megabrain_dispatch_empty_delivery_report empty-report false)"
  assert_contains "$plain" 'status: empty'
  printf 'empty mailbox reports empty in JSON and plain output\n'
}

scenario_supersede_undelivered() {
  local result old_first old_second child_view full_view
  create_dispatch supersede-queued host
  megabrain_dispatch_reply supersede-queued --text 'old direction one' >/dev/null
  old_first="$MEGABRAIN_LAST_MESSAGE_SEQ"
  megabrain_dispatch_reply supersede-queued --text 'old direction two' >/dev/null
  old_second="$MEGABRAIN_LAST_MESSAGE_SEQ"
  result="$(megabrain_dispatch_reply supersede-queued --text 'new authoritative direction' --supersede --json)"
  assert_equal "$(jq -r '.supersededQueued' <<<"$result")" 2
  assert_equal "$(jq -r '.supersededDelivered' <<<"$result")" 0
  assert_equal "$(jq -r '.deliveredSequences | length' <<<"$result")" 0
  assert_equal "$(jq -r '.status' <<<"$result")" queued
  assert_equal "$(jq -r '.status' "$state_dir/dispatches/supersede-queued/deliveries"/*.json | sort | tr '\n' ' ')" 'superseded superseded outstanding '
  export SUPERSET_TERMINAL_ID=supersede-queued-child
  child_view="$(megabrain_dispatch_child_check --timeout 0 --poll-interval 0 --json)"
  assert_contains "$(jq -r '.text' <<<"$child_view")" 'new authoritative direction'
  assert_not_contains "$(jq -r '.text' <<<"$child_view")" 'old direction'
  megabrain_dispatch_child_ack "$(jq -r '.deliveryId' <<<"$child_view")" >/dev/null
  full_view="$(megabrain_dispatch_child_check --timeout 0 --poll-interval 0 --full --json)"
  assert_equal "$(jq -r '.messageSeqs | join(",")' <<<"$full_view")" "$old_first"
  assert_contains "$(jq -r '.text' <<<"$full_view")" 'old direction one'
  megabrain_dispatch_child_ack "$(jq -r '.deliveryId' <<<"$full_view")" >/dev/null
  full_view="$(megabrain_dispatch_child_check --timeout 0 --poll-interval 0 --full --json)"
  assert_equal "$(jq -r '.messageSeqs | join(",")' <<<"$full_view")" "$old_second"
  printf 'undelivered replies are superseded from the actionable stream and remain in full trace\n'
}

scenario_supersede_delivered() {
  local result old_seq child_view withdrawal_path
  create_dispatch supersede-delivered host
  megabrain_dispatch_reply supersede-delivered --text 'old delivered direction' >/dev/null
  old_seq="$MEGABRAIN_LAST_MESSAGE_SEQ"
  export SUPERSET_TERMINAL_ID=supersede-delivered-child
  child_view="$(megabrain_dispatch_child_check --timeout 0 --poll-interval 0 --json)"
  assert_equal "$(jq -r '.messageSeqs | join(",")' <<<"$child_view")" "$old_seq"
  export SUPERSET_TERMINAL_ID=parent-terminal
  result="$(megabrain_dispatch_reply supersede-delivered --text 'new direction' --supersede --json)"
  assert_equal "$(jq -r '.supersededQueued' <<<"$result")" 0
  assert_equal "$(jq -r '.supersededDelivered' <<<"$result")" 1
  assert_equal "$(jq -r '.deliveredSequences | join(",")' <<<"$result")" "$old_seq"
  withdrawal_path="$state_dir/dispatches/supersede-delivered/messages"/*-parent-withdrawal.json
  assert_equal "$(jq -r '.type' $withdrawal_path)" withdrawal
  assert_equal "$(jq -r '.supersedes | join(",")' $withdrawal_path)" "$old_seq"
  assert_contains "$(jq -r '.text' $withdrawal_path)" "$old_seq"
  export SUPERSET_TERMINAL_ID=supersede-delivered-child
  child_view="$(megabrain_dispatch_child_check --timeout 0 --poll-interval 0 --json)"
  assert_equal "$(jq -r '.messages[0].type' <<<"$child_view")" withdrawal
  assert_contains "$(jq -r '.text' <<<"$child_view")" "$old_seq"
  printf 'delivered replies produce a withdrawal naming their sequence\n'
}

scenario_stop_pending_check() {
  local result
  create_dispatch stop-pending
  set_pane_fixture pending-check
  stop_send_calls=0
  if result="$(megabrain_dispatch_stop stop-pending --json 2>&1)"; then
    fail 'pending-check frame was not refused'
  fi
  assert_contains "$result" 'pending check'
  assert_equal "$stop_send_calls" 0
  assert_equal "$(find "$state_dir/dispatches/stop-pending/messages" -name '*.json' -type f | wc -l | tr -d ' ')" 0
  printf 'pending-check transcript refuses stop before sending Escape\n'
}

scenario_stop_working() {
  local result message_types
  create_dispatch stop-working
  set_pane_fixture working
  stop_send_status=queued
  stop_send_calls=0
  result="$(megabrain_dispatch_stop stop-working --json)"
  assert_equal "$(jq -r '.status' <<<"$result")" interrupted
  assert_equal "$stop_send_calls" 1
  message_types="$(jq -r '.type' "$state_dir/dispatches/stop-working/messages"/*.json | tr '\n' ' ')"
  assert_equal "$message_types" 'interrupt interrupt-result '
  printf 'working transcript records the interrupt before and after Escape\n'
}

scenario_stop_host() {
  local result
  create_dispatch stop-host host
  if result="$(megabrain_dispatch_stop stop-host --json 2>&1)"; then
    fail 'host runtime accepted an Escape interrupt'
  fi
  assert_contains "$result" 'host runtime has no Escape'
  printf 'host runtime refuses an unsupported interrupt affordance\n'
}

scenario_change_on_refusal() {
  local result child_view
  create_dispatch change-refused
  megabrain_dispatch_reply change-refused --text 'obsolete direction' >/dev/null
  set_pane_fixture pending-check
  result="$(megabrain_dispatch_change change-refused --text 'authoritative replacement' --json 2>&1)" || true
  assert_equal "$(jq -r '.queueChanged' <<<"$result")" true
  assert_equal "$(jq -r '.interrupted' <<<"$result")" false
  assert_contains "$result" 'not interrupted'
  export SUPERSET_TERMINAL_ID=change-refused-child
  child_view="$(megabrain_dispatch_child_check --timeout 0 --poll-interval 0 --json)"
  assert_contains "$(jq -r '.text' <<<"$child_view")" 'authoritative replacement'
  printf 'change keeps the queue update when the interrupt guard refuses\n'
}

case "${1:-all}" in
  empty) scenario_empty_report ;;
  undelivered) scenario_supersede_undelivered ;;
  delivered) scenario_supersede_delivered ;;
  pending) scenario_stop_pending_check ;;
  working) scenario_stop_working ;;
  host) scenario_stop_host ;;
  change) scenario_change_on_refusal ;;
  all)
    scenario_empty_report
    scenario_supersede_undelivered
    scenario_supersede_delivered
    scenario_stop_pending_check
    scenario_stop_working
    scenario_stop_host
    scenario_change_on_refusal
    ;;
  *) fail "unknown scenario: $1" ;;
esac

printf 'ok: queue supersession and interrupt guards\n'
