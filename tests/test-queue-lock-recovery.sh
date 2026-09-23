#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-lock.XXXXXX")"
dispatch_dir="$state_dir/dispatches"

cleanup() {
  rm -rf "$state_dir"
  return 0
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
export MEGABRAIN_ROOT="$root"
export ORCA_TERMINAL_HANDLE=child-terminal
unset SUPERSET_TERMINAL_ID

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

# megabrain_dispatch_message_append (lib/module-orchestrate.sh) has no production caller left
# (its only caller, megabrain_dispatch_reply, is itself unreachable since `orchestrate reply`
# execs the binary unconditionally). The lock-recovery mechanism it used to implement is ported:
# acquireLock (src/cli/commands/queue-write.ts) breaks a lock directory older than
# MEGABRAIN_LOCK_STALE_SECONDS and otherwise waits up to MEGABRAIN_LOCK_WAIT_SECONDS before
# refusing — exercised here through `megabrain ask`, which calls appendMessage with the same lock.
create_dispatch() {
  local dispatch_id="$1" dir="$dispatch_dir/$1"
  mkdir -p "$dir/messages" "$dir/deliveries"
  jq -n --arg dispatchId "$dispatch_id" --arg worktreePath "$root" '{
    dispatchId: $dispatchId, parentSessionId: "parent-terminal", parentHost: "orca",
    childHost: "orca", workspaceId: "", terminalId: "child-terminal",
    worktreePath: $worktreePath, branch: "main", agent: "codex", agentId: "codex",
    model: "gpt-5", modelHonored: true, label: "label", state: "running",
    runtime: "host", spawnRuntime: "ide",
    createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z"
  }' >"$dir/meta.json"
}

run_ask() {
  local dispatch_id="$1" text="$2"; shift 2
  env MEGABRAIN_DISPATCH_ID="$dispatch_id" "$@" "$root/.build/megabrain" ask "$text"
}

create_dispatch stale-lock
create_dispatch held-lock

# WHY: the lock is a directory, so it outlives the process that made it. A writer killed
# between mkdir and rmdir leaves it behind, and every later ask, done, received and reply for
# that dispatch would wait on it forever without a staleness check.
stale_lock="$dispatch_dir/stale-lock/messages/.lock"
mkdir -p "$stale_lock"
touch -t 200001010000 "$stale_lock"
if ! stale_output="$(run_ask stale-lock 'after a stale lock' env MEGABRAIN_LOCK_STALE_SECONDS=1)"; then
  fail 'a stale lock was not broken'
fi
assert_equal "$stale_output" 'ask sent: stale-lock'
assert_equal "$(find "$dispatch_dir/stale-lock/messages" -name '*.json' | wc -l | tr -d ' ')" 1
printf 'a lock left behind by a dead writer is broken and the message is written\n'

# WHY: a lock a live writer is holding right now must not be stolen, because stealing it
# reintroduces the lost message the lock exists to prevent. The caller gets a refusal it can
# report instead of a wait that never ends.
held_lock="$dispatch_dir/held-lock/messages/.lock"
mkdir -p "$held_lock"
if run_ask held-lock 'while another writer holds it' env MEGABRAIN_LOCK_WAIT_SECONDS=1 MEGABRAIN_LOCK_STALE_SECONDS=60 >/dev/null 2>&1; then
  fail 'a lock held by a live writer was not refused'
fi
assert_equal "$(find "$dispatch_dir/held-lock/messages" -name '*.json' | wc -l | tr -d ' ')" 0
[ -d "$held_lock" ] || fail 'a lock held by a live writer was stolen'
printf 'a lock held right now is not stolen and the caller is refused\n'

printf 'ok: mailbox lock recovery and refusal\n'
