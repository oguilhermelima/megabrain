#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-done-idempotency.XXXXXX")"

cleanup() {
  local rc=$?
  rm -rf "$state_dir"
  return "$rc"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

failures=0

assert_equal() {
  if [ "$1" != "$2" ]; then
    printf 'FAIL: expected %s, got %s\n' "$2" "$1" >&2
    failures=$((failures + 1))
  fi
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *)
      printf "FAIL: expected '%s' to contain '%s'\n" "$1" "$2" >&2
      failures=$((failures + 1))
      ;;
  esac
}

delivery_count() {
  find "$state_dir/dispatches/$1/deliveries" -name '*.json' -type f | wc -l | tr -d ' '
}

message_count() {
  find "$state_dir/dispatches/$1/messages" -name '*.json' -type f | wc -l | tr -d ' '
}

create_dispatch() {
  local dispatch_id="$1" child_terminal="child-$1"
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal superset superset workspace-test \
    "$child_terminal" "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
}

export MEGABRAIN_STATE_DIR="$state_dir"
export SUPERSET_TERMINAL_ID=parent-terminal
unset TMUX TMUX_PANE ORCA_TERMINAL_HANDLE

source "$root/lib/common.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-parent-notify.sh"

parent_nudges=0
megabrain_parent_notify_dispatch() {
  parent_nudges=$((parent_nudges + 1))
}

# A second completion is durable protocol mail, not a second actionable outcome.
create_dispatch repeated-done
export SUPERSET_TERMINAL_ID=child-repeated-done
megabrain_dispatch_child_message done 'first completion' >/dev/null
megabrain_dispatch_child_message done 'retried completion' >/dev/null
assert_equal "$parent_nudges" 1
assert_equal "$(message_count repeated-done)" 2
assert_equal "$(delivery_count repeated-done)" 2

export SUPERSET_TERMINAL_ID=parent-terminal
first_delivery="$(megabrain_dispatch_watch repeated-done --timeout 0 --poll-interval 0 --wait-mode poll --json)"
assert_equal "$(jq -r '.messages | length' <<<"$first_delivery")" 1
assert_equal "$(jq -r '.messages[0].text' <<<"$first_delivery")" 'first completion'
first_delivery_id="$(jq -r '.deliveryId' <<<"$first_delivery")"
megabrain_dispatch_ack repeated-done "$first_delivery_id" >/dev/null
default_after_ack="$(megabrain_dispatch_watch repeated-done --timeout 0 --poll-interval 0 --wait-mode poll --json)"
assert_equal "$(jq -r '.messages | length' <<<"$default_after_ack")" 0

full_delivery="$(megabrain_dispatch_watch repeated-done --timeout 0 --poll-interval 0 --wait-mode poll --full --json)"
assert_equal "$(jq -r '.messages | length' <<<"$full_delivery")" 1
assert_equal "$(jq -r '.messages[0].text' <<<"$full_delivery")" 'retried completion'
printf 'repeated done creates one actionable nudge and durable protocol mail\n'

# A different outcome after failure remains actionable, even though the state
# transition itself is refused by the settled dispatch contract.
create_dispatch different-outcome
export SUPERSET_TERMINAL_ID=child-different-outcome
megabrain_dispatch_meta_update_state different-outcome failed >/dev/null
if different_output="$(megabrain_dispatch_child_message done 'completion after failure' 2>&1)"; then
  fail 'done after failed dispatch was accepted'
fi
assert_contains "$different_output" 'illegal dispatch state transition: failed -> done'
assert_equal "$parent_nudges" 2
assert_equal "$(message_count different-outcome)" 1
assert_equal "$(delivery_count different-outcome)" 1
export SUPERSET_TERMINAL_ID=parent-terminal
different_delivery="$(megabrain_dispatch_watch different-outcome --timeout 0 --poll-interval 0 --wait-mode poll --json)"
assert_equal "$(jq -r '.messages[0].text' <<<"$different_delivery")" 'completion after failure'
printf 'done after failed dispatch remains a distinct actionable outcome\n'

if [ "$failures" -gt 0 ]; then
  printf '%s completion idempotency assertions failed\n' "$failures" >&2
  exit 1
fi
printf 'ok: completion idempotency preserves queue evidence\n'
