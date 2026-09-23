#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-list-performance.XXXXXX")"

cleanup() {
  rm -rf "$state_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

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

# command_orchestrate_list (lib/module-context.sh) is gone from the reachable call graph:
# `orchestrate list` already execs the binary unconditionally, so this drives that instead. The
# binary's loadRecords (src/cli/commands/orchestrate-list.ts) reads each meta.json with Bun's own
# JSON parser, not jq, so a jq-invocation count no longer applies; the property this scenario
# protects — listing 200 dispatches stays linear, not quadratic in per-dispatch subprocess spawns
# — is checked as wall-clock time instead.
start_ns="$(date +%s%N)"
output="$(MEGABRAIN_STATE_DIR="$state_dir" MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate list --all --json)"
end_ns="$(date +%s%N)"
elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
[ "$(printf '%s' "$output" | jq 'length')" = 200 ] || fail "list returned the wrong number of dispatches"
[ "$elapsed_ms" -le 3000 ] || fail "orchestrate list took ${elapsed_ms}ms for 200 dispatches, suspiciously non-linear"

printf 'ok: orchestrate list stays linear at 200 dispatches (%sms)\n' "$elapsed_ms"

# WHY: the listing must not let one unreadable meta abort the whole batch — the coordinator would
# otherwise lose sight of every dispatch it owns because of a single corrupt file. One bad file
# must cost that file and nothing else, and the warning must stay off stdout so --json survives.
mkdir -p "$state_dir/dispatches/broken-meta"
printf '%s\n' '{"dispatchId":"broken-meta", THIS IS NOT JSON' >"$state_dir/dispatches/broken-meta/meta.json"

if ! survivors="$(MEGABRAIN_STATE_DIR="$state_dir" MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate list --all --json 2>"$state_dir/list-stderr")"; then
  fail 'one unreadable meta made the whole listing fail'
fi
[ "$(printf '%s' "$survivors" | jq 'length')" = 200 ] || fail "expected the 200 readable dispatches, got $(printf '%s' "$survivors" | jq 'length')"
printf '%s' "$survivors" | jq -e 'map(select(.dispatchId == "broken-meta")) | length == 0' >/dev/null || fail 'the unreadable dispatch was reported as if it were readable'
grep -q 'broken-meta' "$state_dir/list-stderr" || fail 'the unreadable meta was skipped without telling anyone'
printf 'one unreadable meta costs that dispatch and no other\n'
