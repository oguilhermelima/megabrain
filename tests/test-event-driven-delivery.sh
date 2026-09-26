#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/fixtures/a-dispatch-meta.sh"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-event-delivery.XXXXXX")"
bin_dir="$state_dir/bin"
mkdir -p "$bin_dir"
send_log="$state_dir/send.log"
: >"$send_log"
cat >"$bin_dir/superset" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = terminals ] && [ "\${2:-}" = send ]; then
  printf '%s\n' "\$*" >>"$send_log"
  exit 0
fi
if [ "\${1:-}" = terminals ] && [ "\${2:-}" = list ]; then
  printf '%s\n' '{"sessions":[]}'
  exit 0
fi
exit 0
EOF
chmod +x "$bin_dir/superset"

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

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$1' to contain '$2'" ;;
  esac
}

delivery_count() {
  find "$state_dir/dispatches/$1/deliveries" -name '*.json' -type f | wc -l | tr -d ' '
}

create_dispatch() {
  local dispatch_id="$1" child_terminal="child-$1"
  write_dispatch_meta "$state_dir" "$dispatch_id" \
    childHost=superset workspaceId=workspace-test terminalId="$child_terminal" state=running >/dev/null
}

export MEGABRAIN_STATE_DIR="$state_dir"
export PATH="$bin_dir:/usr/bin:/bin"
export SUPERSET_TERMINAL_ID=child-terminal
unset TMUX TMUX_PANE ORCA_TERMINAL_HANDLE

run_child_message() {
  local dispatch_id="$1" type="$2" text="${3:-}"
  if [ "$type" = received ]; then
    env -i HOME="$state_dir/home" PATH="$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state_dir" \
      MEGABRAIN_DISPATCH_ID="$dispatch_id" SUPERSET_TERMINAL_ID="child-$dispatch_id" \
      "$root/.build/megabrain" "$type"
  else
    env -i HOME="$state_dir/home" PATH="$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state_dir" \
      MEGABRAIN_DISPATCH_ID="$dispatch_id" SUPERSET_TERMINAL_ID="child-$dispatch_id" \
      "$root/.build/megabrain" "$type" "$text"
  fi
}

nudge_count() {
  find "$state_dir/dispatches" -name nudge.log -type f | wc -l | tr -d ' '
}

send_count() {
  wc -l <"$send_log" | tr -d ' '
}

# A child ask is an event: append alone creates its parent delivery and one nudge.
create_dispatch child-ask
export SUPERSET_TERMINAL_ID=child-child-ask
run_child_message child-ask ask 'needs a decision' >/dev/null
assert_equal "$(delivery_count child-ask)" 1
assert_equal "$(nudge_count)" 1
assert_equal "$(jq -r '.recipient' "$state_dir/dispatches/child-ask/deliveries"/*.json)" parent
printf 'child ask creates one parent delivery and one nudge\n'

# A child done has the same event-driven behavior.
create_dispatch child-done
export SUPERSET_TERMINAL_ID=child-child-done
run_child_message child-done done 'finished successfully' >/dev/null
assert_equal "$(delivery_count child-done)" 1
assert_equal "$(nudge_count)" 2
printf 'child done creates one parent delivery and one nudge\n'

# A "child stalled" message is not user-invoked; only the turn-end hook writes one
# (hook-turn-end.ts's own appendMessage call), when stalledIsDue finds the terminal unproven (our
# fake superset's empty "terminals list" makes it "missing") or no recent child activity. Driven
# through the real hook so the same production appendMessage path creates both the delivery and
# the nudge, instead of a fixture that could only fabricate the delivery half.
create_dispatch child-stalled
env -i HOME="$state_dir/home" PATH="$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state_dir" \
  MEGABRAIN_DISPATCH_ID=child-stalled SUPERSET_TERMINAL_ID=child-child-stalled MEGABRAIN_HOOK_AGENT=codex \
  "$root/.build/megabrain" hook turn-end '{"last_assistant_message":"needs intervention"}' >/dev/null
assert_equal "$(delivery_count child-stalled)" 1
assert_equal "$(jq -r '.type' "$state_dir/dispatches/child-stalled/messages"/*.json)" stalled
assert_equal "$(nudge_count)" 3
printf 'child stalled creates one parent delivery and one nudge\n'

# Protocol evidence remains durable without creating an actionable nudge. A plain "received"
# message still creates a (protocol) delivery, since recipientForQueueMessage returns "parent" for
# any classified mail, actionable or not (src/core/queue-write.ts) -- only the nudge is gated on
# "actionable". The ack half of the original scenario is covered below instead of here: child-ack
# (src/cli/commands/child-ack.ts) only ever appends its own "child ack" protocol receipt when the
# delivery being acknowledged is a parent reply (isReply(...)); acking a plain "received" delivery
# writes no message at all. The "delivery replays until acknowledged" scenario further down acks a
# real parent-reply delivery and is what actually exercises that receipt path.
create_dispatch protocol-only
export SUPERSET_TERMINAL_ID=child-protocol-only
run_child_message protocol-only received 'prompt received' >/dev/null
assert_equal "$(delivery_count protocol-only)" 1
assert_equal "$(nudge_count)" 3
printf 'received mail is durable and protocol-only\n'

# A parent reply creates the child's delivery before the child checks, and notifies the child's
# host directly (`superset terminals send`) -- orchestrate reply forwards unconditionally to the
# compiled binary (megabrain_dispatch_reply, the shell implementation this used to call, has no
# production caller left), so the child's own notify-child path (queue-write.ts's notifyChild) is
# what fires here, not a shell nudge function.
export SUPERSET_TERMINAL_ID=parent-terminal
create_dispatch parent-reply
"$root/.build/megabrain" orchestrate reply parent-reply --text 'continue' --json >/dev/null
assert_equal "$(delivery_count parent-reply)" 1
assert_equal "$(jq -r '.recipient' "$state_dir/dispatches/parent-reply/deliveries"/*.json)" child
assert_equal "$(send_count)" 1
printf 'parent reply creates one child delivery and one nudge\n'

# The unclaimed delivery is claimed by the child and replays until acknowledged.
export SUPERSET_TERMINAL_ID=child-parent-reply
first_check="$(MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-parent-reply "$root/.build/megabrain" check --timeout 0 --poll-interval 0 --json)"
second_check="$(MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-parent-reply "$root/.build/megabrain" check --timeout 0 --poll-interval 0 --json)"
first_id="$(jq -r '.deliveryId' <<<"$first_check")"
assert_equal "$(jq -r '.replayed' <<<"$first_check")" false
assert_equal "$(jq -r '.replayed' <<<"$second_check")" true
assert_equal "$(jq -r '.deliveryId' <<<"$second_check")" "$first_id"
MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-parent-reply "$root/.build/megabrain" ack "$first_id" --json >/dev/null
third_check="$(MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-parent-reply "$root/.build/megabrain" check --timeout 0 --poll-interval 0 --json)"
assert_equal "$(jq -r '.deliveryId' <<<"$third_check")" null
printf 'delivery replays until the matching child acknowledges it\n'

# A foreign consumer cannot acknowledge a delivery claimed by the parent.
export SUPERSET_TERMINAL_ID=parent-terminal
unset ORCA_TERMINAL_HANDLE
create_dispatch consumer-fence
append_dispatch_message "$state_dir" consumer-fence child ask 'fence me' child-terminal >/dev/null
fence_check="$("$root/.build/megabrain" orchestrate watch consumer-fence --timeout 0 --poll-interval 0 --wait-mode poll --json)"
fence_id="$(jq -r '.deliveryId' <<<"$fence_check")"
if "$root/.build/megabrain" orchestrate ack consumer-fence "$fence_id" --consumer foreign --generation 1 >/dev/null 2>&1; then
  fail 'foreign consumer acknowledged a claimed delivery'
fi
assert_equal "$(jq -r '.status' "$state_dir/dispatches/consumer-fence/deliveries/$fence_id.json")" outstanding
printf 'foreign consumer is refused by the delivery fence\n'

# Watch only reads and claims the delivery born at append; it does not create one.
create_dispatch watch-reader
append_dispatch_message "$state_dir" watch-reader child done 'already delivered' child-terminal >/dev/null
before_watch="$(delivery_count watch-reader)"
watch_output="$("$root/.build/megabrain" orchestrate watch watch-reader --timeout 0 --poll-interval 0 --wait-mode poll --json)"
assert_equal "$(delivery_count watch-reader)" "$before_watch"
assert_contains "$(jq -r '.messages[0].text' <<<"$watch_output")" 'already delivered'
printf 'watch reads an existing delivery without creating one\n'

# A queue written by the old implementation is migrated at command startup so it is
# reachable without putting delivery creation back into the watch reader.
create_dispatch legacy-queue
mkdir -p "$state_dir/dispatches/legacy-queue/messages"
jq -n '{seq: 1, from: "child", type: "ask", text: "legacy question", createdAt: "2026-09-10T00:00:00Z", sessionId: "child-legacy-queue"}' \
  >"$state_dir/dispatches/legacy-queue/messages/0001-child-ask.json"
export SUPERSET_TERMINAL_ID=parent-terminal
legacy_output="$("$root/.build/megabrain" orchestrate watch legacy-queue --timeout 0 --poll-interval 0 --wait-mode poll --json)"
assert_equal "$(delivery_count legacy-queue)" 1
assert_equal "$(jq -r '.messages[0].text' <<<"$legacy_output")" 'legacy question'
printf 'legacy actionable mail is migrated before watch reads it\n'

printf 'ok: event-driven delivery, replay, fencing, protocol, and reader behavior\n'
