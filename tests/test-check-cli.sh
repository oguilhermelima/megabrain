#!/usr/bin/env bash

set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled check binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-check-cli.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

write_fixture() {
  local state_dir="$1"
  mkdir -p "$state_dir/dispatches/check/messages" "$state_dir/dispatches/check/deliveries"
  printf '%s\n' '{"dispatchId":"check","terminalId":"child-terminal","childHost":"superset","runtime":"host"}' >"$state_dir/dispatches/check/meta.json"
  printf '%s\n' '{"seq":1,"from":"parent","type":"reply","text":"hello"}' >"$state_dir/dispatches/check/messages/1.json"
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
