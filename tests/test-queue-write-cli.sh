#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled queue-write binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-queue-write-cli.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

write_fixture() {
  local state="$1" dispatch="$2"
  mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
  printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"terminalId\":\"child-terminal\",\"childHost\":\"superset\",\"state\":\"running\",\"processState\":\"running\",\"terminalState\":\"owned\"}" >"$state/dispatches/$dispatch/meta.json"
}

run_pair() {
  local label dispatch verb text shell_state binary_state shell_output binary_output shell_status binary_status
  label="$1"; dispatch="$2"; verb="$3"; text="${4:-}"
  shell_state="$work_dir/shell-$dispatch"; binary_state="$work_dir/binary-$dispatch"
  write_fixture "$shell_state" "$dispatch"
  write_fixture "$binary_state" "$dispatch"
  set +e
  if [ "$verb" = received ]; then
    shell_output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$shell_state" MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION=shell SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" received 2>&1)"; shell_status=$?
    binary_output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$binary_state" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" received 2>&1)"; binary_status=$?
  else
    shell_output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$shell_state" MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION=shell SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" "$verb" "$text" 2>&1)"; shell_status=$?
    binary_output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$binary_state" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" "$verb" "$text" 2>&1)"; binary_status=$?
  fi
  set -e
  [ "$shell_status" -eq "$binary_status" ] || fail "$label status shell=$shell_status binary=$binary_status"
  [ "$shell_output" = "$binary_output" ] || fail "$label output differs: shell=$shell_output binary=$binary_output"
  [ "$shell_status" -eq 0 ] || fail "$label refused: $shell_output"
  [ "$(find "$binary_state/dispatches/$dispatch/messages" -name '*.json' | wc -l | tr -d ' ')" -eq 1 ] || fail "$label did not write one message"
  printf '%s agrees between shell and binary\n' "$label"
}

mkdir -p "$work_dir/home"
run_pair received received received
run_pair ask ask ask 'a question'
run_pair done done done 'finished'
printf 'ok: queue-write implementations agree across child verbs\n'
