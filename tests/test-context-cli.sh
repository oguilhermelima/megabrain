#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-context-cli.XXXXXX")"

cleanup() {
  rm -rf "$work_dir"
  return 0
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

run_shell() {
  env -i \
    HOME="$work_dir/home" \
    PATH="/usr/bin:/bin" \
    MEGABRAIN_STATE_DIR="$work_dir/state" \
    MEGABRAIN_CONTEXT_IMPLEMENTATION=shell \
    "$root/megabrain" context --json
}

run_binary() {
  env -i \
    HOME="$work_dir/home" \
    PATH="/usr/bin:/bin" \
    MEGABRAIN_STATE_DIR="$work_dir/state" \
    "$root/.build/megabrain" context --json
}

compare_case() {
  local name="$1" shell_output="$2" binary_output="$3"
  [ "$shell_output" = "$binary_output" ] || fail "$name: shell=$shell_output binary=$binary_output"
  printf '%s agrees between shell and binary\n' "$name"
}

mkdir -p "$work_dir/home"

superset_shell="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$work_dir/state" MEGABRAIN_CONTEXT_IMPLEMENTATION=shell SUPERSET_TERMINAL_ID=terminal SUPERSET_WORKSPACE_ID=workspace SUPERSET_AGENT_ID=claude "$root/megabrain" context --json)"
superset_binary="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$work_dir/state" SUPERSET_TERMINAL_ID=terminal SUPERSET_WORKSPACE_ID=workspace SUPERSET_AGENT_ID=claude "$root/.build/megabrain" context --json)"
compare_case superset "$superset_shell" "$superset_binary"

ai_shell="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$work_dir/state" MEGABRAIN_CONTEXT_IMPLEMENTATION=shell AI_AGENT=claude-code_1-2-3_agent AI_MODEL=model AI_EFFORT=high "$root/megabrain" context --json)"
ai_binary="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$work_dir/state" AI_AGENT=claude-code_1-2-3_agent AI_MODEL=model AI_EFFORT=high "$root/.build/megabrain" context --json)"
compare_case recognized-ai-agent "$ai_shell" "$ai_binary"

unknown_agent_shell="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$work_dir/state" MEGABRAIN_CONTEXT_IMPLEMENTATION=shell AI_AGENT=unknown-shape "$root/megabrain" context --json)"
unknown_agent_binary="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$work_dir/state" AI_AGENT=unknown-shape "$root/.build/megabrain" context --json)"
compare_case unrecognized-ai-agent "$unknown_agent_shell" "$unknown_agent_binary"

absent_shell="$(run_shell)"
absent_binary="$(run_binary)"
compare_case no-agent "$absent_shell" "$absent_binary"

printf 'ok: context implementations agree across all branches\n'
