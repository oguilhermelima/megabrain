#!/usr/bin/env bash

set -euo pipefail

# Scenarios written before implementation: an archived dispatch and an invalid identifier.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-dispatch-paths.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled dispatch binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

make_archived() {
  local state="$1"
  mkdir -p "$state/dispatches/archive/2026-09/arq/messages" "$state/dispatches/archive/2026-09/arq/deliveries"
  printf '%s\n' '{"dispatchId":"arq","parentSessionId":"p","parentHost":"orca","runtime":"host","childHost":"orca","terminalId":"child","terminalState":"retained"}' >"$state/dispatches/archive/2026-09/arq/meta.json"
}

mkdir -p "$work/home"
make_archived "$work/archive"
set +e
archived_output="$(MEGABRAIN_STATE_DIR="$work/archive" MEGABRAIN_SESSION_HOST=orca MEGABRAIN_SESSION_ID=p ORCA_TERMINAL_HANDLE=p "$root/.build/megabrain" orchestrate close arq 2>&1)"; archived_status=$?
set -e
[ "$archived_status" -eq 1 ] || fail "archived dispatch unexpectedly succeeded: $archived_output"
case "$archived_output" in
  *'terminal is retained because identity is unproven'*) ;;
  *) fail "archived dispatch content was not reported by the compiled command: $archived_output" ;;
esac
printf 'compiled archived-dispatch path reports the missing live record\n'

set +e
invalid_output="$(MEGABRAIN_STATE_DIR="$work/invalid" MEGABRAIN_SESSION_HOST=orca MEGABRAIN_SESSION_ID=p ORCA_TERMINAL_HANDLE=p "$root/.build/megabrain" orchestrate close ../fora 2>&1)"; invalid_status=$?
set -e
[ "$invalid_status" -eq 1 ] || fail "invalid dispatch identifier unexpectedly succeeded: $invalid_output"
case "$invalid_output" in
  *'invalid dispatch id'*) ;;
  *) fail "invalid dispatch identifier content was not reported by the compiled command: $invalid_output" ;;
esac
printf 'compiled invalid-dispatch path reports the rejected identifier\n'

store_module_candidates="$(grep -rl '^export function dispatchRoot(' "$root/src")"
[ -n "$store_module_candidates" ] || fail 'could not locate the module that exports dispatchRoot'
case "$store_module_candidates" in
  *$'\n'*) fail "multiple modules export dispatchRoot:\n$store_module_candidates" ;;
esac
store_module="$(realpath "$store_module_candidates")"

set +e
grep -rn 'dispatches/' "$root/src" >"$work/dispatch-path-matches"
dispatch_path_status=$?
set -e
case "$dispatch_path_status" in
  0)
    : >"$work/offending-dispatch-path-matches"
    while IFS= read -r match; do
      matched_file="${match%%:*}"
      [ "$(realpath "$matched_file")" = "$store_module" ] || printf '%s\n' "$match" >>"$work/offending-dispatch-path-matches"
    done <"$work/dispatch-path-matches"
    if [ -s "$work/offending-dispatch-path-matches" ]; then
      fail "dispatch path construction exists outside the dispatch store:
$(cat "$work/offending-dispatch-path-matches")"
    fi
    ;;
  1) ;;
  *) fail "could not scan src for dispatch path construction (rg exit $dispatch_path_status)" ;;
esac
printf 'dispatch path construction is confined to the dispatch store\n'
