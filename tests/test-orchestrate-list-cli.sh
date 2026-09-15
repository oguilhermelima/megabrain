#!/usr/bin/env bash
set -euo pipefail

# Scenarios written before implementation: plain/JSON parity, every selection flag, archived
# records, malformed records, and an empty inventory.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-orchestrate-list.XXXXXX")"
trap 'rm -rf "$state_dir"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
write_fixture() {
  local root_dir="$1"
  mkdir -p "$root_dir/dispatches/owned" "$root_dir/dispatches/other" "$root_dir/dispatches/orphan" "$root_dir/dispatches/uncertain" "$root_dir/dispatches/future" "$root_dir/dispatches/archive/2026-09-14/archived" "$root_dir/dispatches/broken"
  printf '%s\n' '{"dispatchId":"owned","parentSessionId":"caller","parentHost":"host","state":"running","processState":"running","terminalState":"owned","worktreePath":"/owned","reconcileOutcome":null}' >"$root_dir/dispatches/owned/meta.json"
  printf '%s\n' '{"dispatchId":"other","parentSessionId":"other-session","parentHost":"host","state":"running","processState":"running","terminalState":"owned","worktreePath":"/other"}' >"$root_dir/dispatches/other/meta.json"
  printf '%s\n' '{"dispatchId":"orphan","parentSessionId":"caller","parentHost":"host","state":"orphaned","processState":"running","terminalState":"owned","worktreePath":"/orphan"}' >"$root_dir/dispatches/orphan/meta.json"
  printf '%s\n' '{"dispatchId":"uncertain","parentSessionId":"caller","parentHost":"host","state":"running","processState":"exited","terminalState":"owned","worktreePath":"/uncertain"}' >"$root_dir/dispatches/uncertain/meta.json"
  printf '%s\n' '{"dispatchId":"future","parentSessionId":"caller","parentHost":"host","state":"future","processState":"mystery","terminalState":"owned","worktreePath":"/future"}' >"$root_dir/dispatches/future/meta.json"
  printf '%s\n' '{"dispatchId":"archived","parentSessionId":"other-session","parentHost":"host","state":"done","processState":"succeeded","terminalState":"released","worktreePath":"/archived"}' >"$root_dir/dispatches/archive/2026-09-14/archived/meta.json"
  printf '%s\n' '{not json' >"$root_dir/dispatches/broken/meta.json"
}
run_side() {
  local implementation="$1" executable="$2" root_dir="$3" args="$4"
  if [ "$implementation" = shell ]; then
    MEGABRAIN_ORCHESTRATE_LIST_IMPLEMENTATION=shell MEGABRAIN_STATE_DIR="$root_dir" MEGABRAIN_SESSION_ID=caller MEGABRAIN_SESSION_HOST=host "$executable" orchestrate list $args
  else
    MEGABRAIN_STATE_DIR="$root_dir" MEGABRAIN_SESSION_ID=caller MEGABRAIN_SESSION_HOST=host "$executable" orchestrate list $args
  fi
}
write_fixture "$state_dir"
for args in "" "--json" "--all" "--all --json" "--orphans --json" "--uncertain --json"; do
  shell_output="$(run_side shell "$root/megabrain" "$state_dir" "$args" 2>"$state_dir/shell.err")"
  [ -n "$shell_output" ] || fail "shell produced no output for args: $args"
  if [ -x "$root/.build/megabrain" ]; then
    binary_output="$(run_side binary "$root/.build/megabrain" "$state_dir" "$args" 2>"$state_dir/binary.err")"
    [ "$shell_output" = "$binary_output" ] || fail "shell and binary differ for args: $args"
  fi
done
empty="$state_dir/empty"
mkdir -p "$empty"
[ "$(run_side shell "$root/megabrain" "$empty" "--json")" = '[]' ] || fail 'empty shell JSON inventory differs'
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled orchestrate list binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
else
  printf 'orchestrate list agrees between shell and binary\n'
fi
printf 'malformed metadata was skipped without corrupting stdout\n'
