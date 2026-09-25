#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled child ack binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

source "$root/tests/fixtures/entrypoint-routing.sh"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-child-ack.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

routing_fixture="$work_dir/routing-fixture"
routing_state="$work_dir/routing-state"
make_entrypoint_routing_fixture "$root" "$routing_fixture" 73
mkdir -p "$routing_state"
set +e
env -i HOME="$work_dir/home" PATH="$PATH" MEGABRAIN_STATE_DIR="$routing_state" \
  SUPERSET_TERMINAL_ID=child-terminal "$routing_fixture/.build/megabrain" ack delivery-fixed --json \
  >"$routing_state.stdout" 2>"$routing_state.stderr"
routing_status=$?
set -e
assert_equal "$routing_status" 73
printf 'child mailbox route reaches the compiled binary\n'

make_dispatch() {
  local state="$1" dispatch="$2"
  mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
  printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"parentSessionId\":\"parent-terminal\",\"parentHost\":\"superset\",\"childHost\":\"superset\",\"terminalId\":\"child-terminal\",\"runtime\":\"host\",\"state\":\"running\",\"terminalState\":\"owned\"}" >"$state/dispatches/$dispatch/meta.json"
  printf '%s\n' '{"seq":1,"from":"parent","type":"reply","text":"answer"}' >"$state/dispatches/$dispatch/messages/0001-parent-reply.json"
  printf '%s\n' "{\"id\":\"delivery-fixed\",\"dispatchId\":\"$dispatch\",\"recipient\":\"child\",\"consumer\":\"child/superset/child-terminal\",\"consumerGeneration\":1,\"messageSeqs\":[1],\"status\":\"outstanding\"}" >"$state/dispatches/$dispatch/deliveries/delivery-fixed.json"
}

run_shell() {
  local state="$1" args="$2"
  set +e
  output="$(env -i HOME="$work_dir/home" PATH="$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_ORCHESTRATE_ACK_IMPLEMENTATION=shell SUPERSET_TERMINAL_ID=child-terminal \
    "$root/.build/megabrain" ack $args 2>"$state.stderr")"
  status=$?
  set -e
  error="$(cat "$state.stderr")"
}

run_binary() {
  local state="$1" args="$2"
  set +e
  output="$(env -i HOME="$work_dir/home" PATH="$PATH" MEGABRAIN_STATE_DIR="$state" \
    SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" ack $args 2>"$state.stderr")"
  status=$?
  set -e
  error="$(cat "$state.stderr")"
}

compare() {
  local label="$1" args="$2" shell_state binary_state
  shell_state="$work_dir/$label-shell"
  binary_state="$work_dir/$label-binary"
  make_dispatch "$shell_state" "$label"
  make_dispatch "$binary_state" "$label"
  run_shell "$shell_state" "$args"
  shell_output="$output"; shell_status="$status"; shell_error="$error"
  run_binary "$binary_state" "$args"
  binary_output="$output"; binary_status="$status"; binary_error="$error"
  assert_equal "$shell_output" "$binary_output"
  assert_equal "$shell_error" "$binary_error"
  assert_equal "$shell_status" "$binary_status"
  printf '%s agrees between shell and binary\n' "$label"
}

compare first-ack 'delivery-fixed --json'
assert_equal "$(jq -r '.status' "$work_dir/first-ack-shell/dispatches/first-ack/deliveries/delivery-fixed.json")" acknowledged
assert_equal "$(jq -r '.status' "$work_dir/first-ack-binary/dispatches/first-ack/deliveries/delivery-fixed.json")" acknowledged

for implementation in shell binary; do
  state="$work_dir/duplicate-$implementation"
  make_dispatch "$state" duplicate-$implementation
  if [ "$implementation" = shell ]; then
    run_shell "$state" 'delivery-fixed --json'
  else
    run_binary "$state" 'delivery-fixed --json'
  fi
  assert_equal "$status" 0
  first_output="$output"
  if [ "$implementation" = shell ]; then
    run_shell "$state" 'delivery-fixed --json'
  else
    run_binary "$state" 'delivery-fixed --json'
  fi
  assert_equal "$status" 0
  assert_equal "$(printf '%s' "$output" | jq -r '.duplicate')" true
  assert_equal "$(jq -r '.status' "$state/dispatches/duplicate-$implementation/deliveries/delivery-fixed.json")" acknowledged
  printf '%s reports duplicate and preserves delivery state\n' "$implementation"
done

for implementation in shell binary; do
  state="$work_dir/unknown-$implementation"
  make_dispatch "$state" unknown-$implementation
  if [ "$implementation" = shell ]; then
    run_shell "$state" 'missing-delivery --json'
  else
    run_binary "$state" 'missing-delivery --json'
  fi
  assert_equal "$status" 1
  assert_equal "$output" ''
  assert_equal "$error" 'megabrain: delivery missing-delivery refused: delivery is unknown'
  printf '%s refuses an unknown delivery\n' "$implementation"
done

for implementation in shell binary; do
  state="$work_dir/close-$implementation"
  make_dispatch "$state" close-$implementation
  if [ "$implementation" = shell ]; then
    run_shell "$state" 'delivery-fixed --close'
  else
    run_binary "$state" 'delivery-fixed --close'
  fi
  assert_equal "$status" 2
  assert_equal "$output" ''
  assert_equal "$error" 'megabrain: unknown orchestrate ack option: --close'
  printf '%s refuses child --close as a usage error\n' "$implementation"
done

for implementation in shell binary; do
  state="$work_dir/no-dispatch-$implementation"
  mkdir -p "$state"
  if [ "$implementation" = shell ]; then
    run_shell "$state" 'delivery-fixed --json'
  else
    run_binary "$state" 'delivery-fixed --json'
  fi
  assert_equal "$status" 1
  assert_equal "$output" ''
  assert_equal "$error" 'megabrain: no managed dispatch belongs to superset/child-terminal'
  printf '%s refuses when child dispatch cannot be resolved\n' "$implementation"
done

printf 'ok: child mailbox scenarios\n'
