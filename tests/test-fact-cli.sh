#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-fact-cli.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled fact binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
compare() {
  local name="$1" shell_out="$2" shell_rc="$3" binary_out="$4" binary_rc="$5"
  [ "$shell_rc" = "$binary_rc" ] || fail "$name: status shell=$shell_rc binary=$binary_rc"
  [ "$shell_out" = "$binary_out" ] || fail "$name: output differs: shell=$shell_out binary=$binary_out"
  printf '%s agrees between shell and binary\n' "$name"
}
run_pair() {
  local name="$1" facts="$2"; shift 2
  local shell_out binary_out shell_rc binary_rc
  if shell_out="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_FACTS_FILE="$facts.shell" MEGABRAIN_FACT_IMPLEMENTATION=shell "$root/megabrain" "$@" 2>&1)"; then shell_rc=0; else shell_rc=$?; fi
  if binary_out="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_FACTS_FILE="$facts.binary" "$root/.build/megabrain" "$@" 2>&1)"; then binary_rc=0; else binary_rc=$?; fi
  compare "$name" "$shell_out" "$shell_rc" "$binary_out" "$binary_rc"
}

mkdir -p "$work_dir/home"
run_pair absent "$work_dir/absent.json" fact list --json
run_pair empty "$work_dir/empty.json" fact list --json
run_pair missing-name "$work_dir/empty.json" fact remove absent --json
run_pair add "$work_dir/add.json" fact add bash-version --measurement 'Bash 3.2.57 is installed on macOS' --who tester --when 2026-09-07T19:27:29Z --command 'bash --version' --json
run_pair invalid-date "$work_dir/invalid.json" fact add not-a-date --measurement m --who tester --when yesterday --command echo

unset MEGABRAIN_STATE_DIR
run_pair state-default "$work_dir/state-default.json" fact list --json

handoff_shell="$work_dir/handoff-shell.json"
handoff_binary="$work_dir/handoff-binary.json"
env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_FACTS_FILE="$handoff_shell" MEGABRAIN_FACT_IMPLEMENTATION=shell "$root/megabrain" fact add shell-fact --measurement shell --who tester --when 2026-09-07T19:27:29Z --command measure >/dev/null
shell_to_binary="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_FACTS_FILE="$handoff_shell" "$root/.build/megabrain" fact list --json)"
[ "$shell_to_binary" = '[{"id":"shell-fact","measurement":"shell","scope":{"type":"global"},"provenance":{"who":"tester","when":"2026-09-07T19:27:29Z","command":"measure"}}]' ] || fail 'binary could not read shell fact store'
env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_FACTS_FILE="$handoff_binary" "$root/.build/megabrain" fact add binary-fact --measurement binary --who tester --when 2026-09-07T19:27:29Z --command measure >/dev/null
binary_to_shell="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_FACTS_FILE="$handoff_binary" MEGABRAIN_FACT_IMPLEMENTATION=shell "$root/megabrain" fact list --json)"
[ "$binary_to_shell" = '[{"id":"binary-fact","measurement":"binary","scope":{"type":"global"},"provenance":{"who":"tester","when":"2026-09-07T19:27:29Z","command":"measure"}}]' ] || fail 'shell could not read binary fact store'
printf 'shell and binary exchange fact stores\n'
printf 'ok: fact implementations agree across absent, empty, missing, write, invalid, and default-state cases\n'
