#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-receipt.XXXXXX")"

cleanup() {
  rm -rf "$state_dir"
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
export ORCA_TERMINAL_HANDLE=parent-terminal
unset SUPERSET_TERMINAL_ID
source "$root/lib/common.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-parent-notify.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-worktree.sh"

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

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "expected '$1' not to contain '$2'" ;;
    *) ;;
  esac
}

create_dispatch() {
  local dispatch_id="$1" state="$2" terminal_id="${3:-child-terminal}"
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal orca orca "" "$terminal_id" "$root" fix/prompt-delivery-proof codex label "$state" gpt-5 true codex "" "" host ide >/dev/null
}

preamble="$(MEGABRAIN_ROOT="$root" MEGABRAIN_EXECUTABLE="$root/megabrain" megabrain_dispatch_preamble "$root")"
assert_contains "$preamble" 'received to confirm that you received this prompt'
assert_contains "$preamble" 'ask "your question"'
assert_contains "$preamble" 'check until a reply arrives'
assert_contains "$preamble" 'ack <delivery-id>'
assert_contains "$preamble" 'done "short outcome summary"'
assert_not_contains "$preamble" 'Facts in scope'

no_path_root="$state_dir/no-path"
mkdir -p "$no_path_root/lib"
cp "$root/lib/common.sh" "$root/lib/module-context.sh" "$root/lib/module-orchestrate.sh" "$no_path_root/lib/"
no_path_preamble="$(PATH=/usr/bin:/bin MEGABRAIN_ROOT="$no_path_root" MEGABRAIN_EXECUTABLE="$no_path_root/megabrain" bash -c 'source "$1/lib/common.sh"; source "$1/lib/module-orchestrate.sh"; megabrain_dispatch_preamble "$1"' _ "$no_path_root")"
assert_contains "$no_path_preamble" 'could not be resolved through PATH or an absolute executable path'
assert_not_contains "$no_path_preamble" 'run ./megabrain'
printf 'dispatch preamble contains only the protocol and handles an unavailable executable\n'

create_dispatch stalled-report spawning
megabrain_dispatch_message_append stalled-report child stalled 'child could not run the dispatch command' child-terminal >/dev/null
megabrain_spawn_mark_prompt_failed stalled-report prompt-send-not-observed
failure_output="$(megabrain_dispatch_failure_error stalled-report 'dispatch did not observe prompt send' 2>&1)"
assert_contains "$failure_output" 'child message: "child could not run the dispatch command"'
assert_equal "$(jq -r '.state' "$state_dir/dispatches/stalled-report/meta.json")" failed
printf 'failed dispatch reports the child stalled message\n'

# A turn-end hook is evidence that a child turn ended, not evidence that this prompt
# reached it. An empty turn must remain pending rather than becoming a receipt.
create_dispatch empty-turn running
env -u SUPERSET_TERMINAL_ID -u TMUX -u TMUX_PANE ORCA_TERMINAL_HANDLE=child-terminal MEGABRAIN_DISPATCH_ID=empty-turn MEGABRAIN_HOOK_AGENT=codex \
  "$root/hooks/megabrain-turn-end.sh" '{"last_assistant_message":""}' >/dev/null
assert_equal "$(jq -r '.promptDelivery' "$state_dir/dispatches/empty-turn/meta.json")" pending
assert_equal "$(jq -r '.state' "$state_dir/dispatches/empty-turn/meta.json")" running
printf 'empty child turn does not confirm prompt delivery or rewrite the contract\n'

# The child receipt is the delivery fact. It is durable in the dispatch queue and must be
# observed before the parent marks the prompt delivered.
create_dispatch optional-receipt spawning command-terminal
received_output="$(env -u SUPERSET_TERMINAL_ID -u TMUX -u TMUX_PANE ORCA_TERMINAL_HANDLE=command-terminal MEGABRAIN_STATE_DIR="$state_dir" \
  "$root/megabrain" received)"
assert_equal "$received_output" 'received sent: optional-receipt'
received_message="$state_dir/dispatches/optional-receipt/messages/0001-child-received.json"
[ -f "$received_message" ] || fail 'received command did not leave a durable message'
assert_equal "$(jq -r '.type' "$received_message")" received
assert_equal "$(jq -r '.state' "$state_dir/dispatches/optional-receipt/meta.json")" running
printf 'received command is durable and authoritative\n'

receipt_dispatch=receipt-retry
create_dispatch "$receipt_dispatch" spawning command-terminal
receipt_send_count=0
megabrain_dispatch_native_send() {
  receipt_send_count=$((receipt_send_count + 1))
  if [ "$receipt_send_count" -eq 2 ]; then
    megabrain_dispatch_message_append "$receipt_dispatch" child received 'prompt received' child-terminal >/dev/null
  fi
  return 0
}
export MEGABRAIN_PROMPT_RECEIPT_ATTEMPTS=3
export MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS=0
megabrain_dispatch_send_prompt_with_receipt "$receipt_dispatch" 'prompt delivered after retry' ||
  fail 'prompt was not delivered after the child receipt appeared'
assert_equal "$receipt_send_count" 2
assert_equal "$(jq -r '.promptDelivery' "$state_dir/dispatches/$receipt_dispatch/meta.json")" pending
printf 'prompt receipt: missing first receipt causes a bounded resend\n'

no_receipt_dispatch=no-receipt
create_dispatch "$no_receipt_dispatch" spawning command-terminal
no_receipt_send_count=0
megabrain_dispatch_native_send() {
  no_receipt_send_count=$((no_receipt_send_count + 1))
  return 0
}
export MEGABRAIN_PROMPT_RECEIPT_ATTEMPTS=2
if megabrain_dispatch_send_prompt_with_receipt "$no_receipt_dispatch" 'prompt without receipt'; then
  fail 'prompt without a receipt unexpectedly succeeded'
fi
assert_equal "$no_receipt_send_count" 2
printf 'prompt receipt: exhaustion fails without claiming delivery\n'

create_dispatch running-reply running
reply_result="$(megabrain_dispatch_reply running-reply --text 'Continue work' --json)"
assert_equal "$(jq -r '.status' <<<"$reply_result")" queued
reply_message="$(find "$state_dir/dispatches/running-reply/messages" -name '*.json' -print -quit)"
assert_equal "$(jq -r '.type' "$reply_message")" reply
assert_equal "$(jq -r '.text' "$reply_message")" 'Continue work'
printf 'running child accepts queued parent reply\n'

# A child that has just ended an ask turn is waiting_for_reply. The turn-end hook must
# inspect its own mailbox before the waiting guard, and ask the agent to consume it.
create_dispatch waiting-reply waiting_for_reply waiting-terminal
megabrain_dispatch_message_append waiting-reply parent reply 'reply waiting at turn end' parent-terminal >/dev/null
waiting_hook_output="$(env -u SUPERSET_TERMINAL_ID -u TMUX -u TMUX_PANE ORCA_TERMINAL_HANDLE=waiting-terminal MEGABRAIN_STATE_DIR="$state_dir" \
  "$root/hooks/megabrain-turn-end.sh" '{}')"
assert_equal "$(jq -r '.decision' <<<"$waiting_hook_output")" block
assert_contains "$(jq -r '.reason' <<<"$waiting_hook_output")" 'megabrain check'
waiting_delivery="$state_dir/dispatches/waiting-reply/deliveries"/*.json
assert_equal "$(jq -r '.status' $waiting_delivery)" outstanding
assert_equal "$(jq -r '.state' "$state_dir/dispatches/waiting-reply/meta.json")" waiting_for_reply
printf 'waiting child turn: hook exposes queued reply before the state guard\n'

# A starting agent may accept the first prompt's keystrokes while ignoring Enter. A
# receipt retry must press the prompt affordance again without appending another copy.
tmux_prompt_dispatch=tmux-prompt-retry
tmux_prompt_pane=%prompt
tmux_prompt_composer="$state_dir/tmux-prompt-composer"
tmux_prompt_submitted="$state_dir/tmux-prompt-submitted"
tmux_prompt_keys="$state_dir/tmux-prompt-keys"
create_tmux_dispatch() {
  megabrain_dispatch_meta_write "$tmux_prompt_dispatch" parent-terminal orca orca "" child-terminal "$root" fix/prompt-delivery-proof codex label spawning gpt-5 true codex test-session "$tmux_prompt_pane" tmux tmux >/dev/null
}
create_tmux_dispatch
: >"$tmux_prompt_composer"
: >"$tmux_prompt_submitted"
: >"$tmux_prompt_keys"
tmux() {
  local command="${1:-}" enter_count
  case "$command" in
    send-keys)
      case "${4:-}" in
        -l) printf '%s' "${5:-}" >>"$tmux_prompt_composer" ;;
        Enter)
          printf '%s\n' Enter >>"$tmux_prompt_keys"
          enter_count="$(wc -l <"$tmux_prompt_keys" | tr -d ' ')"
          if [ "$enter_count" -ge 2 ]; then
            cat "$tmux_prompt_composer" >"$tmux_prompt_submitted"
            : >"$tmux_prompt_composer"
            megabrain_dispatch_message_append "$tmux_prompt_dispatch" child received 'prompt received' child-terminal >/dev/null
          fi
          ;;
      esac
      ;;
    *) return 0 ;;
  esac
}
export MEGABRAIN_PROMPT_RECEIPT_ATTEMPTS=2
export MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS=0
tmux_prompt_text='prompt survives a non-submitting first Enter'
if ! megabrain_dispatch_send_prompt_with_receipt "$tmux_prompt_dispatch" "$tmux_prompt_text"; then
  fail 'tmux prompt retry did not receive the child receipt'
fi
assert_equal "$(wc -l <"$tmux_prompt_keys" | tr -d ' ')" 2
assert_equal "$(cat "$tmux_prompt_submitted")" "$tmux_prompt_text"
assert_equal "$(cat "$tmux_prompt_composer")" ''
printf 'tmux prompt receipt retry: Enter is retried without duplicating composer text\n'
unset -f tmux

printf 'ok: receipt delivery and running reply scenarios\n'
