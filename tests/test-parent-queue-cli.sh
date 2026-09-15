#!/usr/bin/env bash

set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled parent queue binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-parent-queue.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

write_fixture() {
  local state="$1" dispatch="$2"
  mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
  printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"parentSessionId\":\"parent-session\",\"parentHost\":\"orca\"}" >"$state/dispatches/$dispatch/meta.json"
  printf '%s\n' '{"seq":1,"from":"child","type":"done","text":"finished"}' >"$state/dispatches/$dispatch/messages/0001-child-done.json"
  printf '%s\n' "{\"id\":\"delivery-fixed\",\"dispatchId\":\"$dispatch\",\"recipient\":\"parent\",\"consumer\":null,\"consumerGeneration\":null,\"messageSeqs\":[1],\"status\":\"outstanding\"}" >"$state/dispatches/$dispatch/deliveries/delivery-fixed.json"
}

run_watch() {
  local implementation="$1" executable="$2" state="$3" dispatch="$4"
  if [ "$implementation" = shell ]; then
    env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" \
      MEGABRAIN_ORCHESTRATE_WATCH_IMPLEMENTATION=shell MEGABRAIN_CONSUMER_ID=orca/parent-session ORCA_TERMINAL_HANDLE=parent-session \
      "$executable" orchestrate watch "$dispatch" --timeout 0 --poll-interval 0 --wait-mode poll --json
  else
    env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
      MEGABRAIN_CONSUMER_ID=orca/parent-session ORCA_TERMINAL_HANDLE=parent-session \
      "$executable" orchestrate watch "$dispatch" --timeout 0 --poll-interval 0 --wait-mode poll --json
  fi
}

mkdir -p "$work_dir/home"
shell_state="$work_dir/shell"; binary_state="$work_dir/binary"
write_fixture "$shell_state" queue
write_fixture "$binary_state" queue
shell_output="$(run_watch shell "$root/megabrain" "$shell_state" queue)"
binary_output="$(run_watch binary "$root/.build/megabrain" "$binary_state" queue)"
[ "$shell_output" = "$binary_output" ] || { printf 'FAIL: watch output differs\n' >&2; exit 1; }
printf 'watch output agrees between shell and binary\n'

cross_state="$work_dir/cross"; write_fixture "$cross_state" queue
shell_claim="$(run_watch shell "$root/megabrain" "$cross_state" queue)"
binary_replay="$(run_watch binary "$root/.build/megabrain" "$cross_state" queue)"
[ "$(printf '%s' "$binary_replay" | jq -r '.replayed')" = true ] || { printf 'FAIL: binary did not replay shell claim\n' >&2; exit 1; }
binary_ack="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$cross_state" MEGABRAIN_CONSUMER_ID=orca/parent-session ORCA_TERMINAL_HANDLE=parent-session "$root/.build/megabrain" orchestrate ack queue delivery-fixed --json)"
[ "$(printf '%s' "$binary_ack" | jq -r '.duplicate')" = false ] || { printf 'FAIL: binary did not acknowledge shell claim\n' >&2; exit 1; }
printf 'shell claim and binary acknowledgement interoperate\n'

reverse_state="$work_dir/reverse"; write_fixture "$reverse_state" queue
binary_claim="$(run_watch binary "$root/.build/megabrain" "$reverse_state" queue)"
shell_replay="$(run_watch shell "$root/megabrain" "$reverse_state" queue)"
[ "$(printf '%s' "$shell_replay" | jq -r '.replayed')" = true ] || { printf 'FAIL: shell did not replay binary claim\n' >&2; exit 1; }
shell_ack="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$reverse_state" MEGABRAIN_ORCHESTRATE_ACK_IMPLEMENTATION=shell MEGABRAIN_CONSUMER_ID=orca/parent-session ORCA_TERMINAL_HANDLE=parent-session "$root/megabrain" orchestrate ack queue delivery-fixed --json)"
[ "$(printf '%s' "$shell_ack" | jq -r '.duplicate')" = false ] || { printf 'FAIL: shell did not acknowledge binary claim\n' >&2; exit 1; }
binary_duplicate="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$reverse_state" MEGABRAIN_CONSUMER_ID=orca/parent-session ORCA_TERMINAL_HANDLE=parent-session "$root/.build/megabrain" orchestrate ack queue delivery-fixed --json)"
[ "$(printf '%s' "$binary_duplicate" | jq -r '.duplicate')" = true ] || { printf 'FAIL: duplicate acknowledgement was not reported\n' >&2; exit 1; }
printf 'binary claim, shell acknowledgement and duplicate are safe\n'

default_shell="$work_dir/default-shell"; default_binary="$work_dir/default-binary"
write_fixture "$default_shell/.megabrain" queue
write_fixture "$default_binary/.megabrain" queue
shell_default="$(env -i HOME="$default_shell" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_ORCHESTRATE_WATCH_IMPLEMENTATION=shell MEGABRAIN_CONSUMER_ID=orca/parent-session ORCA_TERMINAL_HANDLE=parent-session "$root/megabrain" orchestrate watch queue --timeout 0 --poll-interval 0 --wait-mode poll --json)"
binary_default="$(env -i HOME="$default_binary" PATH="/usr/bin:/bin" MEGABRAIN_CONSUMER_ID=orca/parent-session ORCA_TERMINAL_HANDLE=parent-session "$root/.build/megabrain" orchestrate watch queue --timeout 0 --poll-interval 0 --wait-mode poll --json)"
[ "$shell_default" = "$binary_default" ] || { printf 'FAIL: default state directory differs\n' >&2; exit 1; }
printf 'watch default state directory agrees\n'
