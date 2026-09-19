#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-list-performance.XXXXXX")"
wrapper_dir="$state_dir/bin"
count_file="$state_dir/jq-count"
real_jq="$(command -v jq)"

cleanup() {
  rm -rf "$state_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p "$wrapper_dir" "$state_dir/dispatches"
printf '0\n' >"$count_file"

printf '%s\n' '#!/usr/bin/env bash' \
  'count=$(cat "$MEGABRAIN_TEST_JQ_COUNT")' \
  'count=$((count + 1))' \
  'printf "%s\\n" "$count" >"$MEGABRAIN_TEST_JQ_COUNT"' \
  'exec "$MEGABRAIN_TEST_JQ_REAL" "$@"' >"$wrapper_dir/jq"
chmod +x "$wrapper_dir/jq"

for i in $(seq 1 200); do
  dispatch_id="dispatch-$i"
  dispatch_dir="$state_dir/dispatches/$dispatch_id"
  mkdir -p "$dispatch_dir"
  "$real_jq" -n \
    --arg dispatchId "$dispatch_id" \
    --arg worktreePath "$root" \
    '{dispatchId: $dispatchId, parentSessionId: "parent", parentHost: "unknown", childHost: "unknown", workspaceId: "", terminalId: "", worktreePath: $worktreePath, state: "closed", processState: "stopped", terminalState: "released", reconcileOutcome: null}' \
    >"$dispatch_dir/meta.json"
done

export MEGABRAIN_STATE_DIR="$state_dir"
export MEGABRAIN_ROOT="$root"
export MEGABRAIN_DISPATCH_DIR="$state_dir/dispatches"
export MEGABRAIN_TEST_JQ_COUNT="$count_file"
export MEGABRAIN_TEST_JQ_REAL="$real_jq"

source "$root/lib/common.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"

megabrain_dispatch_parent_status() {
  MEGABRAIN_PARENT_STATUS=unknown
}

PATH="$wrapper_dir:$PATH"
export PATH

output="$(command_orchestrate_list --all --json)"
count="$(cat "$count_file")"
[ "$(printf '%s' "$output" | "$real_jq" 'length')" = 200 ] || fail "list returned the wrong number of dispatches"
[ "$count" -le 6 ] || fail "orchestrate list used $count jq invocations for 200 dispatches"

printf 'ok: orchestrate list stays linear at 200 dispatches with %s jq invocations\n' "$count"

# WHY: the listing slurps every meta in one jq, so a single unreadable file aborted the
# batch and the coordinator lost sight of every dispatch it owns. That is the same shape
# as a dead marketplace entry breaking a whole plugin listing. One bad file must cost
# that file and nothing else, and the warning must stay off stdout so --json survives.
mkdir -p "$state_dir/dispatches/broken-meta"
printf '%s\n' '{"dispatchId":"broken-meta", THIS IS NOT JSON' >"$state_dir/dispatches/broken-meta/meta.json"

if ! survivors="$(command_orchestrate_list --all --json 2>"$state_dir/list-stderr")"; then
  fail 'one unreadable meta made the whole listing fail'
fi
[ "$(printf '%s' "$survivors" | "$real_jq" 'length')" = 200 ] || fail "expected the 200 readable dispatches, got $(printf '%s' "$survivors" | "$real_jq" 'length')"
printf '%s' "$survivors" | "$real_jq" -e 'map(select(.dispatchId == "broken-meta")) | length == 0' >/dev/null || fail 'the unreadable dispatch was reported as if it were readable'
grep -q 'broken-meta' "$state_dir/list-stderr" || fail 'the unreadable meta was skipped without telling anyone'
printf 'one unreadable meta costs that dispatch and no other\n'
