#!/usr/bin/env bash

set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled check binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-check-cli.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

assert_equal() {
  local actual="$1" expected="$2"
  [ "$actual" = "$expected" ] || {
    printf 'FAIL: expected %s, got %s\n' "$expected" "$actual" >&2
    exit 1
  }
}

write_fixture() {
  local state_dir="$1"
  mkdir -p "$state_dir/dispatches/check/messages" "$state_dir/dispatches/check/deliveries"
  printf '%s\n' '{"dispatchId":"check","terminalId":"child-terminal","childHost":"superset","runtime":"host"}' >"$state_dir/dispatches/check/meta.json"
  printf '%s\n' '{"seq":1,"from":"parent","type":"reply","text":"hello"}' >"$state_dir/dispatches/check/messages/0001-parent-reply.json"
  printf '%s\n' '{"id":"delivery-fixed","dispatchId":"check","recipient":"child","consumer":null,"consumerGeneration":null,"messageSeqs":[1],"status":"outstanding"}' >"$state_dir/dispatches/check/deliveries/delivery-fixed.json"
}

run_side() {
  local implementation="$1" state_dir="$2" executable="$3"
  if [ "$implementation" = shell ]; then
    env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state_dir" MEGABRAIN_CHECK_IMPLEMENTATION=shell SUPERSET_TERMINAL_ID=child-terminal "$executable" check --timeout 0 --json
  else
    env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-terminal "$executable" check --timeout 0 --json
  fi
}

mkdir -p "$work_dir/home"
shell_state="$work_dir/shell-state"
binary_state="$work_dir/binary-state"
write_fixture "$shell_state"
write_fixture "$binary_state"
shell_output="$(run_side shell "$shell_state" "$root/megabrain")"
binary_output="$(run_side binary "$binary_state" "$root/.build/megabrain")"
[ "$shell_output" = "$binary_output" ] || { printf 'FAIL: shell and binary check output differ\n' >&2; exit 1; }
printf 'check agrees between shell and binary\n'

shell_default_home="$work_dir/shell-home"
binary_default_home="$work_dir/binary-home"
write_fixture "$shell_default_home/.megabrain"
write_fixture "$binary_default_home/.megabrain"
shell_output="$(env -i HOME="$shell_default_home" PATH="/usr/bin:/bin" MEGABRAIN_CHECK_IMPLEMENTATION=shell SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" check --timeout 0 --json)"
binary_output="$(env -i HOME="$binary_default_home" PATH="/usr/bin:/bin" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" check --timeout 0 --json)"
[ "$shell_output" = "$binary_output" ] || { printf 'FAIL: default state directory differs\n' >&2; exit 1; }
printf 'check default state directory agrees\n'

run_claim() {
  local implementation="$1" state_dir="$2" executable="$3"
  if [ "$implementation" = shell ]; then
    env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state_dir" \
      MEGABRAIN_CHECK_IMPLEMENTATION=shell MEGABRAIN_CONSUMER_ID=shared-consumer \
      MEGABRAIN_CONSUMER_GENERATION=7 SUPERSET_TERMINAL_ID=child-terminal \
      "$executable" check --timeout 0 --json
  else
    env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state_dir" \
      MEGABRAIN_CONSUMER_ID=shared-consumer MEGABRAIN_CONSUMER_GENERATION=7 \
      SUPERSET_TERMINAL_ID=child-terminal "$executable" check --timeout 0 --json
  fi
}

run_ack() {
  local state_dir="$1" delivery_id="$2"
  env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state_dir" \
    MEGABRAIN_CONSUMER_ID=shared-consumer MEGABRAIN_CONSUMER_GENERATION=7 \
    SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" ack "$delivery_id" --json
}

handoff_state="$work_dir/handoff-state"
write_fixture "$handoff_state"
shell_claim="$(run_claim shell "$handoff_state" "$root/megabrain")"
shell_delivery_id="$(printf '%s' "$shell_claim" | jq -r '.deliveryId')"
binary_replay="$(run_claim binary "$handoff_state" "$root/.build/megabrain")"
assert_equal "$(printf '%s' "$binary_replay" | jq -r '.replayed')" true
run_ack "$handoff_state" "$shell_delivery_id" >/dev/null
assert_equal "$(jq -r '.status' "$handoff_state/dispatches/check/deliveries/$shell_delivery_id.json")" acknowledged

handoff_state="$work_dir/handoff-state-reverse"
write_fixture "$handoff_state"
binary_claim="$(run_claim binary "$handoff_state" "$root/.build/megabrain")"
binary_delivery_id="$(printf '%s' "$binary_claim" | jq -r '.deliveryId')"
shell_replay="$(run_claim shell "$handoff_state" "$root/megabrain")"
assert_equal "$(printf '%s' "$shell_replay" | jq -r '.replayed')" true
run_ack "$handoff_state" "$binary_delivery_id" >/dev/null
assert_equal "$(jq -r '.status' "$handoff_state/dispatches/check/deliveries/$binary_delivery_id.json")" acknowledged
printf 'shell and binary claims interoperate across acknowledgements\n'

side_state="$work_dir/side-state"
side_shell_state="$side_state/shell"
side_binary_state="$side_state/binary"
write_fixture "$side_shell_state"
write_fixture "$side_binary_state"
side_shell_claim="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$side_shell_state" \
  MEGABRAIN_CHECK_IMPLEMENTATION=shell MEGABRAIN_SESSION_HOST=parent-host \
  MEGABRAIN_SESSION_ID=parent-session SUPERSET_TERMINAL_ID=child-terminal \
  "$root/megabrain" check --timeout 0 --json)"
side_binary_claim="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$side_binary_state" \
  MEGABRAIN_SESSION_HOST=parent-host MEGABRAIN_SESSION_ID=parent-session \
  SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" check --timeout 0 --json)"
side_shell_delivery_id="$(printf '%s' "$side_shell_claim" | jq -r '.deliveryId')"
side_binary_delivery_id="$(printf '%s' "$side_binary_claim" | jq -r '.deliveryId')"
side_shell_consumer="$(jq -r '.consumer' "$side_shell_state/dispatches/check/deliveries/$side_shell_delivery_id.json")"
side_binary_consumer="$(jq -r '.consumer' "$side_binary_state/dispatches/check/deliveries/$side_binary_delivery_id.json")"
[ "$side_shell_consumer" = "$side_binary_consumer" ] || {
  printf 'FAIL: child mailbox consumer differs: shell=%s binary=%s\n' "$side_shell_consumer" "$side_binary_consumer" >&2
  exit 1
}
printf 'child mailbox consumer agrees between shell and binary\n'
