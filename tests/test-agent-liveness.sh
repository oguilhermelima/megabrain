#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-agent-liveness.XXXXXX")"

cleanup() {
  rm -rf "$state_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

export MEGABRAIN_STATE_DIR="$state_dir/state"
export SUPERSET_TERMINAL_ID=parent-terminal

source "$root/lib/common.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-parent-notify.sh"

megabrain_dispatch_render_transcript() {
  cat "$1"
}

megabrain_tmux_agent_for_pane() {
  printf 'codex\n'
}

create_dispatch() {
  local dispatch_id="$1" state="${2:-running}" session="${3:-session}" pane="${4:-pane}"
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal superset superset workspace child-terminal \
    "$root" main codex label "$state" gpt-5 true codex "$session" "$pane" tmux tmux >/dev/null
}

create_dispatch legacy-timeout timeout
create_dispatch legacy-stalled stalled
assert_equal "$(jq -r '.state' <<<"$(megabrain_dispatch_meta_read legacy-timeout)")" running
assert_equal "$(jq -r '.state' <<<"$(megabrain_dispatch_meta_read legacy-stalled)")" running
printf 'retired states in old records normalise to running\n'

create_dispatch protocol-view
megabrain_dispatch_message_append protocol-view child received 'prompt received' child-terminal >/dev/null
megabrain_dispatch_message_append protocol-view child ack delivery-id child-terminal >/dev/null
megabrain_dispatch_message_append protocol-view child ask 'needs a decision' child-terminal >/dev/null
default_view="$(megabrain_dispatch_watch protocol-view --timeout 0 --poll-interval 0 --wait-mode poll --json)"
assert_equal "$(jq -r '.messages | length' <<<"$default_view")" 1
assert_equal "$(jq -r '.messages[0].type' <<<"$default_view")" ask
full_view="$(megabrain_dispatch_watch protocol-view --timeout 0 --poll-interval 0 --wait-mode poll --full --consumer protocol-trace --json)"
assert_equal "$(jq -r '.messages | length' <<<"$full_view")" 1
assert_equal "$(jq -r '.messages[0].type' <<<"$full_view")" received
full_delivery_id="$(jq -r '.deliveryId' <<<"$full_view")"
megabrain_dispatch_ack_for_owner parent protocol-view "$full_delivery_id" --consumer protocol-trace --generation 1 >/dev/null
full_view="$(megabrain_dispatch_watch protocol-view --timeout 0 --poll-interval 0 --wait-mode poll --full --consumer protocol-trace --json)"
assert_equal "$(jq -r '.messages | length' <<<"$full_view")" 1
assert_equal "$(jq -r '.messages[0].type' <<<"$full_view")" ack
printf 'default view hides protocol evidence and full trace reveals it\n'

printf 'ok: agent liveness, retired state migration, and protocol view\n'
