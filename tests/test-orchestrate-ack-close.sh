#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-ack-close.XXXXXX")"
fake_dir="$work_dir/bin"
mkdir -p "$fake_dir" "$work_dir/home"

cleanup() {
  local rc=$?
  if [ -n "${waiter_pid:-}" ]; then
    kill "$waiter_pid" 2>/dev/null || true
    wait "$waiter_pid" 2>/dev/null || true
  fi
  rm -rf "$work_dir"
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

cat >"$fake_dir/superset" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = terminals ] && [ "${2:-}" = close ]; then
  printf 'close:%s\n' "${6:-}" >>"$MEGABRAIN_TEST_HOST_LOG"
  if [ "${MEGABRAIN_TEST_CLOSE_MODE:-success}" = failure ]; then
    printf '%s\n' '{"error":{"message":"terminal close denied by host"}}' >&2
    exit 1
  fi
  printf '%s\n' '{"ok":true}'
  exit 0
fi
if [ "${1:-}" = terminals ] && [ "${2:-}" = send ]; then
  printf '%s\n' "$*" >>"$MEGABRAIN_TEST_SEND_LOG"
  printf '%s\n' '{"ok":true}'
  exit 0
fi
exit 1
EOF
cp "$fake_dir/superset" "$fake_dir/megabrain_superset"
chmod +x "$fake_dir/superset" "$fake_dir/megabrain_superset"

export PATH="$fake_dir:$PATH"
export HOME="$work_dir/home"
export MEGABRAIN_STATE_DIR="$work_dir/bootstrap"
export SUPERSET_TERMINAL_ID=parent-terminal
unset ORCA_TERMINAL_HANDLE TMUX TMUX_PANE

source "$root/lib/common.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"

make_dispatch() {
  local state_dir="$1" dispatch_id="$2" state="$3" delivery_id="$4"
  export MEGABRAIN_STATE_DIR="$state_dir"
  export MEGABRAIN_DISPATCH_DIR="$state_dir/dispatches"
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal superset superset workspace-test terminal-"$dispatch_id" \
    "$root" main codex label "$state" gpt-5 true codex '' '' host ide >/dev/null
  megabrain_dispatch_delivery_write "$dispatch_id" "$delivery_id" superset/parent-terminal 1 '[1]' >/dev/null
}

run_parent_ack() {
  local implementation="$1" state_dir="$2" dispatch_id="$3" delivery_id="$4" close="$5" mode="$6"
  local output rc
  export MEGABRAIN_STATE_DIR="$state_dir"
  export MEGABRAIN_ORCHESTRATE_ACK_IMPLEMENTATION="$implementation"
  export MEGABRAIN_TEST_CLOSE_MODE="$mode"
  set +e
  if [ "$close" = true ]; then
    output="$("$root/megabrain" orchestrate ack "$dispatch_id" "$delivery_id" --close --json 2>"$state_dir/error")"
  else
    output="$("$root/megabrain" orchestrate ack "$dispatch_id" "$delivery_id" --json 2>"$state_dir/error")"
  fi
  rc=$?
  set -e
  ACK_OUTPUT="$output"
  ACK_RC="$rc"
  ACK_ERROR="$(cat "$state_dir/error")"
}

run_child_ack() {
  local implementation="$1" state_dir="$2" delivery_id="$3"
  local output rc
  export MEGABRAIN_STATE_DIR="$state_dir"
  export MEGABRAIN_ORCHESTRATE_ACK_IMPLEMENTATION="$implementation"
  export SUPERSET_TERMINAL_ID=child-terminal
  set +e
  output="$("$root/megabrain" ack "$delivery_id" --close 2>"$state_dir/error")"
  rc=$?
  set -e
  CHILD_OUTPUT="$output"
  CHILD_RC="$rc"
  CHILD_ERROR="$(cat "$state_dir/error")"
  export SUPERSET_TERMINAL_ID=parent-terminal
}

for implementation in shell binary; do
  state_dir="$work_dir/$implementation-done"
  dispatch_id="done-$implementation"
  delivery_id="delivery-$implementation"
  make_dispatch "$state_dir" "$dispatch_id" done "$delivery_id"
  : >"$work_dir/host.log"
  export MEGABRAIN_TEST_HOST_LOG="$work_dir/host.log"
  run_parent_ack "$implementation" "$state_dir" "$dispatch_id" "$delivery_id" true success
  assert_equal "$ACK_RC" 0
  assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_id/deliveries/$delivery_id.json")" acknowledged
  assert_equal "$(jq -r '.state' "$state_dir/dispatches/$dispatch_id/meta.json")" closed
  assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/$dispatch_id/meta.json")" released
  assert_equal "$(wc -l <"$work_dir/host.log" | tr -d ' ')" 1
  assert_equal "$(printf '%s' "$ACK_OUTPUT" | jq -r '.close.status')" closed
  assert_equal "$(printf '%s' "$ACK_OUTPUT" | jq -r '.duplicate')" false
  printf '%s: done ack closes and acknowledges\n' "$implementation"

  state_dir="$work_dir/$implementation-running"
  dispatch_id="running-$implementation"
  delivery_id="running-delivery-$implementation"
  make_dispatch "$state_dir" "$dispatch_id" running "$delivery_id"
  : >"$work_dir/host.log"
  run_parent_ack "$implementation" "$state_dir" "$dispatch_id" "$delivery_id" true success
  assert_equal "$ACK_RC" 1
  assert_contains "$ACK_ERROR" dispatch-not-done
  assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_id/deliveries/$delivery_id.json")" outstanding
  assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/$dispatch_id/meta.json")" owned
  assert_equal "$(wc -l <"$work_dir/host.log" | tr -d ' ')" 0
  printf '%s: running ack-close refuses without side effects\n' "$implementation"

  state_dir="$work_dir/$implementation-duplicate"
  dispatch_id="duplicate-$implementation"
  delivery_id="duplicate-delivery-$implementation"
  make_dispatch "$state_dir" "$dispatch_id" done "$delivery_id"
  : >"$work_dir/host.log"
  run_parent_ack "$implementation" "$state_dir" "$dispatch_id" "$delivery_id" true success
  run_parent_ack "$implementation" "$state_dir" "$dispatch_id" "$delivery_id" true success
  assert_equal "$ACK_RC" 0
  assert_equal "$(printf '%s' "$ACK_OUTPUT" | jq -r '.duplicate')" true
  assert_equal "$(printf '%s' "$ACK_OUTPUT" | jq -r '.close.duplicate')" true
  assert_equal "$(wc -l <"$work_dir/host.log" | tr -d ' ')" 1
  printf '%s: duplicate ack-close reports both duplicates\n' "$implementation"

  state_dir="$work_dir/$implementation-failure"
  dispatch_id="failure-$implementation"
  delivery_id="failure-delivery-$implementation"
  make_dispatch "$state_dir" "$dispatch_id" done "$delivery_id"
  run_parent_ack "$implementation" "$state_dir" "$dispatch_id" "$delivery_id" true failure
  assert_equal "$ACK_RC" 1
  assert_contains "$ACK_ERROR" acknowledged
  assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_id/deliveries/$delivery_id.json")" acknowledged
  assert_equal "$(jq -r '.state' "$state_dir/dispatches/$dispatch_id/meta.json")" done
  assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/$dispatch_id/meta.json")" owned
  printf '%s: close failure preserves durable acknowledgement\n' "$implementation"

  state_dir="$work_dir/$implementation-plain"
  dispatch_id="plain-$implementation"
  delivery_id="plain-delivery-$implementation"
  make_dispatch "$state_dir" "$dispatch_id" done "$delivery_id"
  run_parent_ack "$implementation" "$state_dir" "$dispatch_id" "$delivery_id" false success
  assert_equal "$ACK_RC" 0
  assert_equal "$(printf '%s' "$ACK_OUTPUT" | jq -r 'has("close")')" false
  assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_id/deliveries/$delivery_id.json")" acknowledged
  assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/$dispatch_id/meta.json")" owned
  printf '%s: ack without close keeps its JSON shape\n' "$implementation"

  state_dir="$work_dir/$implementation-child"
  dispatch_id="child-$implementation"
  delivery_id="child-delivery-$implementation"
  make_dispatch "$state_dir" "$dispatch_id" done "$delivery_id"
  jq '.terminalId = "child-terminal"' "$state_dir/dispatches/$dispatch_id/meta.json" >"$state_dir/meta.tmp"
  mv "$state_dir/meta.tmp" "$state_dir/dispatches/$dispatch_id/meta.json"
  run_child_ack "$implementation" "$state_dir" "$delivery_id"
  assert_equal "$CHILD_RC" 2
  assert_contains "$CHILD_ERROR" 'unknown orchestrate ack option: --close'
  assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_id/deliveries/$delivery_id.json")" outstanding
  printf '%s: child ack rejects close as a usage error\n' "$implementation"
done

export SUPERSET_TERMINAL_ID=parent-terminal
export MEGABRAIN_TEST_SEND_LOG="$work_dir/send.log"
: >"$MEGABRAIN_TEST_SEND_LOG"
hook_state="$work_dir/hook-state"
make_dispatch "$hook_state" hook-owned done hook-delivery
"$root/hooks/megabrain-turn-end.sh" '{}' >/dev/null
assert_equal "$(wc -l <"$MEGABRAIN_TEST_SEND_LOG" | tr -d ' ')" 1
assert_contains "$(cat "$MEGABRAIN_TEST_SEND_LOG")" 'orchestrate close hook-owned'
printf 'turn-end hook notices an owned done dispatch with a retained terminal\n'

: >"$MEGABRAIN_TEST_SEND_LOG"
waiter_state="$work_dir/hook-waiter"
make_dispatch "$waiter_state" hook-waiter done waiter-delivery
sleep 30 &
waiter_pid=$!
printf '%s\n' "{\"pid\":$waiter_pid}" >"$waiter_state/dispatches/hook-waiter/waiter.json"
"$root/hooks/megabrain-turn-end.sh" '{}' >/dev/null
assert_equal "$(wc -l <"$MEGABRAIN_TEST_SEND_LOG" | tr -d ' ')" 0
kill "$waiter_pid" 2>/dev/null || true
wait "$waiter_pid" 2>/dev/null || true
unset waiter_pid
printf 'turn-end hook suppresses a done dispatch with an active watch\n'

: >"$MEGABRAIN_TEST_SEND_LOG"
foreign_state="$work_dir/hook-foreign"
make_dispatch "$foreign_state" hook-foreign done foreign-delivery
jq '.parentSessionId = "other-parent"' "$foreign_state/dispatches/hook-foreign/meta.json" >"$foreign_state/meta.tmp"
mv "$foreign_state/meta.tmp" "$foreign_state/dispatches/hook-foreign/meta.json"
"$root/hooks/megabrain-turn-end.sh" '{}' >/dev/null
assert_equal "$(wc -l <"$MEGABRAIN_TEST_SEND_LOG" | tr -d ' ')" 0
printf 'turn-end hook suppresses a done dispatch owned by another session\n'

printf 'ok: orchestrate ack-close and finished-dispatch notice\n'
