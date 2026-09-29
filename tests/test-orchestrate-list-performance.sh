#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_real_home="${HOME:-}"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-list-performance.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$state_dir/.megabrain-test-state"
require_megabrain_test_state

export HOME="$state_dir/home"
mkdir -p "$HOME" "$state_dir"
assert_safe_state_dir() {
  [ -n "${MEGABRAIN_STATE_DIR:-}" ] || { printf 'FAIL: MEGABRAIN_STATE_DIR is unset\n' >&2; exit 1; }
  local state_path home_path home_candidate
  state_path="$(cd "$MEGABRAIN_STATE_DIR" && pwd -P)"
  for home_candidate in "$test_real_home" "$HOME"; do
    [ -n "$home_candidate" ] && [ -d "$home_candidate" ] || continue
    home_path="$(cd "$home_candidate" && pwd -P)"
    case "$state_path/" in "$home_path/.megabrain/"*) printf 'FAIL: refusing real-home megabrain state directory\n' >&2; exit 1 ;; esac
  done
}

cleanup() {
  rm -rf "$state_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
db_import() { export MEGABRAIN_STATE_DIR="$state_dir"; assert_safe_state_dir; "$root/.build/megabrain" db import "$state_dir" --replace --json >/dev/null; }

mkdir -p "$state_dir/dispatches"

for i in $(seq 1 200); do
  dispatch_id="dispatch-$i"
  dispatch_dir="$state_dir/dispatches/$dispatch_id"
  mkdir -p "$dispatch_dir"
  jq -n \
    --arg dispatchId "$dispatch_id" \
    --arg worktreePath "$root" \
    '{dispatchId: $dispatchId, parentSessionId: "parent", parentHost: "unknown", childHost: "unknown", workspaceId: "", terminalId: "", worktreePath: $worktreePath, state: "closed", processState: "stopped", terminalState: "released", reconcileOutcome: null}' \
    >"$dispatch_dir/meta.json"
done
db_import

# `orchestrate list` reads dispatches through one database query. This checks that listing 200
# dispatches stays within its existing performance budget without scanning legacy JSON files.
export MEGABRAIN_STATE_DIR="$state_dir"
assert_safe_state_dir
start_ns="$(date +%s%N)"
output="$(MEGABRAIN_STATE_DIR="$state_dir" MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate list --all --json)"
end_ns="$(date +%s%N)"
elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
[ "$(printf '%s' "$output" | jq 'length')" = 200 ] || fail "list returned the wrong number of dispatches"
[ "$elapsed_ms" -le 3000 ] || fail "orchestrate list took ${elapsed_ms}ms for 200 dispatches, suspiciously non-linear"

printf 'ok: orchestrate list stays linear at 200 dispatches (%sms)\n' "$elapsed_ms"

# WHY: malformed legacy JSON must be reported during import, while listing the imported database
# remains successful and complete. A stray malformed file does not alter the database inventory.
mkdir -p "$state_dir/dispatches/broken-meta"
printf '%s\n' '{"dispatchId":"broken-meta", THIS IS NOT JSON' >"$state_dir/dispatches/broken-meta/meta.json"

if MEGABRAIN_STATE_DIR="$state_dir" "$root/.build/megabrain" db import "$state_dir" --replace --json >"$state_dir/import-output" 2>"$state_dir/import-stderr"; then
  fail 'malformed legacy metadata was imported'
fi
grep -q 'malformed input:' "$state_dir/import-stderr" || fail 'the importer did not report malformed input'
grep -q 'broken-meta/meta.json:' "$state_dir/import-stderr" || fail 'the importer omitted the malformed file and reason'
survivors="$(MEGABRAIN_STATE_DIR="$state_dir" MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate list --all --json 2>"$state_dir/list-stderr")"
[ "$(printf '%s' "$survivors" | jq 'length')" = 200 ] || fail "expected the 200 imported dispatches, got $(printf '%s' "$survivors" | jq 'length')"
printf '%s' "$survivors" | jq -e 'map(select(.dispatchId == "broken-meta")) | length == 0' >/dev/null || fail 'the malformed legacy dispatch was reported as if it were imported'
printf 'malformed legacy metadata is rejected by import and ignored by database listing\n'
