#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-parent-cli.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled parent command binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

make_dispatch() {
  local state="$1" dispatch="$2"
  env -i HOME="$work_dir/home" PATH="$PATH" MEGABRAIN_STATE_DIR="$state" \
    SUPERSET_TERMINAL_ID=parent-terminal bash -c '
      source "$1/lib/common.sh"
      source "$1/lib/module-orchestrate.sh"
      megabrain_dispatch_meta_write "$2" parent-terminal superset unknown unknown \
        "$2-child" "$1" main codex label running gpt-5 true codex "" "" host host >/dev/null
    ' -- "$root" "$dispatch"
}

run_shell() {
  local state="$1" dispatch="$2" verb="$3" extra="$4"
  env -i HOME="$work_dir/home" PATH="$PATH" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_ORCHESTRATE_REPLY_IMPLEMENTATION=shell \
    MEGABRAIN_ORCHESTRATE_CHANGE_IMPLEMENTATION=shell \
    SUPERSET_TERMINAL_ID=parent-terminal "$root/megabrain" orchestrate "$verb" "$dispatch" $extra
}

run_binary() {
  local state="$1" dispatch="$2" verb="$3" extra="$4"
  env -i HOME="$work_dir/home" PATH="$PATH" MEGABRAIN_STATE_DIR="$state" \
    SUPERSET_TERMINAL_ID=parent-terminal "$root/.build/megabrain" orchestrate "$verb" "$dispatch" $extra
}

compare() {
  local name="$1" shell_state binary_state
  local dispatch="$name" verb="$2" extra="$3" shell_output binary_output
  shell_state="$work_dir/$name-shell"
  binary_state="$work_dir/$name-binary"
  mkdir -p "$work_dir/home"
  make_dispatch "$shell_state" "$dispatch"
  make_dispatch "$binary_state" "$dispatch"
  shell_output="$(run_shell "$shell_state" "$dispatch" "$verb" "$extra")" || fail "$name: shell failed: $shell_output"
  binary_output="$(run_binary "$binary_state" "$dispatch" "$verb" "$extra")" || fail "$name: binary failed: $binary_output"
  [ "$shell_output" = "$binary_output" ] || fail "$name: shell=$shell_output binary=$binary_output"
  printf '%s agrees between shell and binary\n' "$name"
}

compare reply-json reply '--text answer --json'
compare change-json change '--text replacement --json'

for implementation in shell binary; do
  state="$work_dir/consumed-$implementation"
  dispatch="consumed-$implementation"
  mkdir -p "$work_dir/home"
  make_dispatch "$state" "$dispatch"
  run_shell "$state" "$dispatch" reply '--text old' >/dev/null
  delivery="$(find "$state/dispatches/$dispatch/deliveries" -name '*.json' -print -quit)"
  [ -n "$delivery" ] || fail "$implementation: reply did not create a delivery"
  jq '.consumer = "child-terminal" | .consumerGeneration = 1' "$delivery" >"$delivery.tmp"
  mv "$delivery.tmp" "$delivery"
  if [ "$implementation" = shell ]; then
    output="$(run_shell "$state" "$dispatch" change '--text new --json')"
  else
    output="$(run_binary "$state" "$dispatch" change '--text new --json')"
  fi
  [ "$(printf '%s' "$output" | jq -r '.supersededDelivered')" = 1 ] || fail "$implementation: consumed reply was not superseded"
done
printf 'consumed reply supersede scenario agrees\n'

printf 'ok: orchestrate reply and change implementations agree\n'
