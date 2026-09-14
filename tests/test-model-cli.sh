#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-model-cli.XXXXXX")"
trap 'rm -rf "$state_root"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

run_shell() {
  MEGABRAIN_STATE_DIR="$state_root/shell" MEGABRAIN_MODEL_IMPLEMENTATION=shell "$root/megabrain" "$@"
}

run_binary() {
  MEGABRAIN_STATE_DIR="$state_root/binary" "$root/.build/megabrain" "$@"
}

compare() {
  local name="$1"; shift
  local shell_output binary_output shell_status binary_status
  if shell_output="$(run_shell "$@" 2>&1)"; then shell_status=0; else shell_status=$?; fi
  if binary_output="$(run_binary "$@" 2>&1)"; then binary_status=0; else binary_status=$?; fi
  [ "$shell_status" -eq "$binary_status" ] || fail "$name: shell status=$shell_status binary status=$binary_status"
  [ "$shell_output" = "$binary_output" ] || fail "$name: shell=$shell_output binary=$binary_output"
  printf '%s agrees between shell and binary\n' "$name"
}

# The shell side is the baseline gate before the compiled implementation exists.
run_shell model list --json >/dev/null
run_shell model list >/dev/null
run_shell model --help >/dev/null
run_shell model list --help >/dev/null
run_shell model add --help >/dev/null
run_shell model refresh --help >/dev/null
printf 'shell model CLI scenarios pass\n'

if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled model binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

compare registry-json model list --json
compare registry-table model list
compare model-help model --help
compare list-help model list --help
compare add-help model add --help
compare refresh-help model refresh --help
compare invalid-option model list --invalid
compare unavailable-refresh model refresh codex

printf 'ok: model implementations agree across CLI branches\n'
