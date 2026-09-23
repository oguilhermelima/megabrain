#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
binary="$root/.build/megabrain"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-queue.XXXXXX")"

cleanup() {
  wait 2>/dev/null || true
  rm -rf "$state_dir"
  return 0
}
trap cleanup EXIT

[ -x "$binary" ] || {
  printf 'skip: compiled binary is missing at %s; run bun run build\n' "$binary"
  exit 0
}

fail() {
  report_writer_failures
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

report_writer_failures() {
  local stderr_path writer_id exit_path exit_code
  for stderr_path in "$state_dir/writers"/*.stderr; do
    [ -f "$stderr_path" ] || continue
    writer_id="$(basename "$stderr_path" .stderr)"
    exit_path="$state_dir/writers/$writer_id.exit"
    [ -f "$exit_path" ] || continue
    exit_code="$(cat "$exit_path")"
    [ "$exit_code" -eq 0 ] && continue
    printf 'writer %s exited %s: ' "$writer_id" "$exit_code" >&2
    cat "$stderr_path" >&2
  done
}

# megabrain_dispatch_meta_write (production-dead, zero callers anywhere in lib/) and
# megabrain_dispatch_message_append (no longer exists anywhere in lib/ at all, grep: zero hits)
# used to seed this fixture and drive the concurrent writes directly as shell functions. Running
# the original file showed why that is dangerous, not just stale: it reported "0 durable, 20
# refused" and still printed "ok" — every writer failed on "command not found" (the deleted
# function), counted as a refusal, and every assertion below passed vacuously on zero files. A
# green result that cannot tell "everything is broken" from "everything works" is worse than a
# red one. Rewritten to drive the compiled binary for real (rule 1), matching test-queue-write-
# cli.sh's run_binary_concurrency but against an orca-hosted dispatch instead of a superset-hosted
# one — a distinct host path through the same mailbox-locking code.
mkdir -p "$state_dir/dispatches/queue-race/messages" "$state_dir/dispatches/queue-race/deliveries"
jq -n '{
  dispatchId: "queue-race", parentSessionId: "parent-terminal", parentHost: "orca", parentWorkspaceId: null,
  parentTmuxSession: null, parentTmuxPane: null, childHost: "orca", workspaceId: null,
  terminalId: "child-terminal", worktreePath: "/work", branch: "main", agent: "codex", agentId: "codex",
  model: "gpt-5", effort: null, modelHonored: true, modelSubstitution: null, runtime: "host",
  spawnRuntime: "ide", tmuxSession: null, tmuxPane: null, label: "label", chain: null, state: "running",
  promptDelivered: false, promptDelivery: "pending", promptDeliveryReason: null, promptPublication: "pending",
  promptTransport: "pending", promptReceipt: "pending", promptState: "awaiting-publication",
  processState: "running", terminalState: "owned", terminalReason: null, failureCount: 0, stage: null,
  reason: null, reconcileOutcome: null, createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z"
}' >"$state_dir/dispatches/queue-race/meta.json"

# WHY: a parent reply and a child ask are written by different processes into the same
# mailbox, so the sequence number and the file name are allocated concurrently. Without
# the lock two writers pick the same sequence and one message silently overwrites the
# other, which is the one way the queue can lose something. The serial tests cannot see
# that, so this is the only place the durability claim is actually exercised.
writers=20
writers_dir="$state_dir/writers"
mkdir "$writers_dir"
for i in $(seq 1 "$writers"); do
  (
    stderr_path="$writers_dir/$i.stderr"
    exit_path="$writers_dir/$i.exit"
    if env -i HOME="$state_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state_dir" \
      ORCA_TERMINAL_HANDLE=child-terminal MEGABRAIN_DISPATCH_ID=queue-race \
      "$binary" ask "concurrent body $i" >/dev/null 2>"$stderr_path"; then
      writer_exit=0
      : > "$writers_dir/$i.written"
    else
      writer_exit=$?
      : > "$writers_dir/$i.refused"
    fi
    printf '%s\n' "$writer_exit" > "$exit_path"
  ) &
done
wait

messages_dir="$state_dir/dispatches/queue-race/messages"
written="$(find "$messages_dir" -name '*.json' | wc -l | tr -d ' ')"
durable="$(find "$writers_dir" -name '*.written' | wc -l | tr -d ' ')"
refused="$(find "$writers_dir" -name '*.refused' | wc -l | tr -d ' ')"
results="$(find "$writers_dir" -name '*.exit' | wc -l | tr -d ' ')"
accounted=$((durable + refused))
assert_equal "$results" "$writers"
assert_equal "$accounted" "$writers"
assert_equal "$written" "$durable"
[ "$durable" -gt 0 ] || fail 'no writer was durable; the scenario proved nothing'

unique_seqs="$(find "$messages_dir" -name '*.json' -exec jq -r '.seq' {} \; | sort -u | wc -l | tr -d ' ')"
assert_equal "$unique_seqs" "$durable"

unique_bodies="$(find "$messages_dir" -name '*.json' -exec jq -r '.text' {} \; | sort -u | wc -l | tr -d ' ')"
assert_equal "$unique_bodies" "$durable"

[ ! -d "$messages_dir/.lock" ] || fail 'the mailbox lock was left behind'
printf '%s concurrent writers: %s durable, %s refused; every durable message kept, every sequence unique\n' \
  "$writers" "$durable" "$refused"

printf 'ok: the queue does not lose a message under concurrent writers\n'
