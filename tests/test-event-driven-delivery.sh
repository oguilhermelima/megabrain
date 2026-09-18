#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-event-delivery.XXXXXX")"
bin_dir="$state_dir/bin"
mkdir -p "$bin_dir"
cat >"$bin_dir/superset" <<'EOF'
#!/usr/bin/env bash
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
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal superset superset workspace-test \
    "$child_terminal" "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
}

export MEGABRAIN_STATE_DIR="$state_dir"
export PATH="$bin_dir:/usr/bin:/bin"
export SUPERSET_TERMINAL_ID=child-terminal
unset TMUX TMUX_PANE ORCA_TERMINAL_HANDLE

source "$root/lib/common.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-parent-notify.sh"

declare -F megabrain_dispatch_terminal_status >/dev/null 2>&1 || \
  fail 'module-orchestrate did not load the terminal identity helper'
printf 'module-orchestrate loads the terminal identity helper\n'

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

child_nudges=0
megabrain_dispatch_native_send() {
  child_nudges=$((child_nudges + 1))
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

create_dispatch child-stalled
megabrain_dispatch_message_append child-stalled child stalled 'needs intervention' child-terminal >/dev/null
assert_equal "$(delivery_count child-stalled)" 1
assert_equal "$(nudge_count)" 3
printf 'child stalled creates one parent delivery and one nudge\n'

# Protocol evidence remains durable without creating an actionable nudge.
create_dispatch protocol-only
export SUPERSET_TERMINAL_ID=child-protocol-only
run_child_message protocol-only received 'prompt received' >/dev/null
assert_equal "$(delivery_count protocol-only)" 1
assert_equal "$(nudge_count)" 3
megabrain_dispatch_message_append protocol-only child ack delivery-id child-terminal >/dev/null
assert_equal "$(delivery_count protocol-only)" 2
assert_equal "$(nudge_count)" 3
printf 'received and ack remain protocol-only\n'

# A parent reply creates the child's delivery before the child checks.
export SUPERSET_TERMINAL_ID=parent-terminal
create_dispatch parent-reply
megabrain_dispatch_reply parent-reply --text 'continue' >/dev/null
assert_equal "$(delivery_count parent-reply)" 1
assert_equal "$(jq -r '.recipient' "$state_dir/dispatches/parent-reply/deliveries"/*.json)" child
assert_equal "$child_nudges" 1
printf 'parent reply creates one child delivery and one nudge\n'

# The unclaimed delivery is claimed by the child and replays until acknowledged.
export SUPERSET_TERMINAL_ID=child-parent-reply
first_check="$(megabrain_dispatch_child_check --timeout 0 --poll-interval 0 --json)"
second_check="$(megabrain_dispatch_child_check --timeout 0 --poll-interval 0 --json)"
first_id="$(jq -r '.deliveryId' <<<"$first_check")"
assert_equal "$(jq -r '.replayed' <<<"$first_check")" false
assert_equal "$(jq -r '.replayed' <<<"$second_check")" true
assert_equal "$(jq -r '.deliveryId' <<<"$second_check")" "$first_id"
megabrain_dispatch_child_ack "$first_id" --json >/dev/null
third_check="$(megabrain_dispatch_child_check --timeout 0 --poll-interval 0 --json)"
assert_equal "$(jq -r '.deliveryId' <<<"$third_check")" null
printf 'delivery replays until the matching child acknowledges it\n'

# A foreign consumer cannot acknowledge a delivery claimed by the parent.
export SUPERSET_TERMINAL_ID=parent-terminal
unset ORCA_TERMINAL_HANDLE
create_dispatch consumer-fence
megabrain_dispatch_message_append consumer-fence child ask 'fence me' child-terminal >/dev/null
fence_check="$(megabrain_dispatch_watch consumer-fence --timeout 0 --poll-interval 0 --wait-mode poll --json)"
fence_id="$(jq -r '.deliveryId' <<<"$fence_check")"
if megabrain_dispatch_ack_for_owner parent consumer-fence "$fence_id" --consumer foreign --generation 1 >/dev/null 2>&1; then
  fail 'foreign consumer acknowledged a claimed delivery'
fi
assert_equal "$(jq -r '.status' "$state_dir/dispatches/consumer-fence/deliveries/$fence_id.json")" outstanding
printf 'foreign consumer is refused by the delivery fence\n'

# Watch only reads and claims the delivery born at append; it does not create one.
create_dispatch watch-reader
megabrain_dispatch_message_append watch-reader child done 'already delivered' child-terminal >/dev/null
before_watch="$(delivery_count watch-reader)"
watch_output="$(megabrain_dispatch_watch watch-reader --timeout 0 --poll-interval 0 --wait-mode poll --json)"
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
legacy_output="$("$root/megabrain" orchestrate watch legacy-queue --timeout 0 --poll-interval 0 --wait-mode poll --json)"
assert_equal "$(delivery_count legacy-queue)" 1
assert_equal "$(jq -r '.messages[0].text' <<<"$legacy_output")" 'legacy question'
printf 'legacy actionable mail is migrated before watch reads it\n'

printf 'ok: event-driven delivery, replay, fencing, protocol, and reader behavior\n'
