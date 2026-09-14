#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-queue.XXXXXX")"

cleanup() {
  wait 2>/dev/null || true
  rm -rf "$state_dir"
  return 0
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
export MEGABRAIN_LOCK_WAIT_SECONDS="${MEGABRAIN_LOCK_WAIT_SECONDS:-120}"
export ORCA_TERMINAL_HANDLE=parent-terminal
unset SUPERSET_TERMINAL_ID
source "$root/lib/common.sh"
source "$root/lib/module-parent-notify.sh"
source "$root/lib/module-orchestrate.sh"

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

megabrain_dispatch_meta_write queue-race parent-terminal orca orca "" child-terminal "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null

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
    if megabrain_dispatch_message_append queue-race child ask "concurrent body $i" child-terminal \
      >/dev/null 2>"$stderr_path"; then
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

unique_seqs="$(find "$messages_dir" -name '*.json' -exec jq -r '.seq' {} \; | sort -u | wc -l | tr -d ' ')"
assert_equal "$unique_seqs" "$durable"

unique_bodies="$(find "$messages_dir" -name '*.json' -exec jq -r '.text' {} \; | sort -u | wc -l | tr -d ' ')"
assert_equal "$unique_bodies" "$durable"

[ ! -d "$messages_dir/.lock" ] || fail 'the mailbox lock was left behind'
printf '%s concurrent writers: %s durable, %s refused; every durable message kept, every sequence unique\n' \
  "$writers" "$durable" "$refused"

printf 'ok: the queue does not lose a message under concurrent writers\n'
