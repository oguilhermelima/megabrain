#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-lock.XXXXXX")"
holder_pid=""
cleanup() {
  [ -z "$holder_pid" ] || kill -9 "$holder_pid" 2>/dev/null || true
  rm -rf "$state_dir"
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
guard_db_state() {
  [ -n "${MEGABRAIN_STATE_DIR:-}" ] || { printf 'FAIL: MEGABRAIN_STATE_DIR is unset\n' >&2; exit 1; }
  case "$MEGABRAIN_STATE_DIR" in "${HOME:-}"/.megabrain|"${HOME:-}"/.megabrain/*) printf 'FAIL: refusing real HOME database\n' >&2; exit 1 ;; esac
}
guard_db_state
export MEGABRAIN_ROOT="$root"
export ORCA_TERMINAL_HANDLE=child-terminal
unset SUPERSET_TERMINAL_ID
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }

# Former stale-lock recovery now proves SQLite releases an abandoned writer transaction.
# Keep the old scenario name so the history of the invariant remains clear.
mkdir -p "$state_dir/dispatches/queue/messages" "$state_dir/dispatches/queue/deliveries"
jq -n --arg dispatchId queue --arg worktreePath "$root" '{
  dispatchId: $dispatchId, parentSessionId: "parent-terminal", parentHost: "orca",
  childHost: "orca", terminalId: "child-terminal", worktreePath: $worktreePath,
  branch: "main", agent: "codex", model: "gpt-5", label: "label", state: "running",
  runtime: "host", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z"
}' >"$state_dir/dispatches/queue/meta.json"
"$root/.build/megabrain" db import "$state_dir" >/dev/null

holder_ready="$state_dir/holder-ready"
MEGABRAIN_DB_MODULE="$root/src/db/db.ts" MEGABRAIN_STATE_DIR="$state_dir" bun -e '
  const { openDatabase, withWrite } = await import(process.env.MEGABRAIN_DB_MODULE);
  const opened = openDatabase({ MEGABRAIN_STATE_DIR: process.env.MEGABRAIN_STATE_DIR });
  if (opened.kind !== "ok") throw new Error(opened.error);
  withWrite(opened.value, () => {
    process.stdout.write("locked\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  });
' >"$holder_ready" 2>&1 &
holder_pid=$!

for _ in $(seq 1 100); do
  [ "$(cat "$holder_ready" 2>/dev/null || true)" = locked ] && break
  kill -0 "$holder_pid" 2>/dev/null || fail 'writer helper exited before holding the transaction'
  sleep 0.02
done
assert_equal "$(cat "$holder_ready")" locked
kill -9 "$holder_pid"
wait "$holder_pid" 2>/dev/null || true
holder_pid=""

output="$(MEGABRAIN_DB_BUSY_SECONDS=5 MEGABRAIN_DISPATCH_ID=queue "$root/.build/megabrain" ask 'after interrupted writer')"
assert_equal "$output" 'ask sent: queue'
queue="$("$root/.build/megabrain" db show queue --json)"
assert_equal "$(printf '%s' "$queue" | jq -c '[.messages[].seq]')" '[1]'
assert_equal "$(printf '%s' "$queue" | jq '.messages | length')" 1
integrity="$("$root/.build/megabrain" db check --json)"
assert_equal "$(printf '%s' "$integrity" | jq -r '.clean')" true

printf 'abandoned writer transaction releases cleanly and the next message starts at sequence 1\n'
printf 'ok: former mailbox lock recovery is covered by database transaction recovery\n'
