#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/fixtures/a-dispatch-meta.sh"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-receipt.XXXXXX")"

cleanup() {
  rm -rf "$state_dir"
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
export ORCA_TERMINAL_HANDLE=parent-terminal
unset SUPERSET_TERMINAL_ID TMUX TMUX_PANE

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

# Fixture built directly with jq (tests/fixtures/a-dispatch-meta.sh): no lib/ sourcing, no
# megabrain_dispatch_meta_write / megabrain_dispatch_message_append.
create_dispatch() {
  local dispatch_id="$1" state="$2" terminal_id="${3:-child-terminal}"
  write_dispatch_meta "$state_dir" "$dispatch_id" \
    parentSessionId=parent-terminal parentHost=orca childHost=orca terminalId="$terminal_id" \
    worktreePath="$root" branch=fix/prompt-delivery-proof agent=codex agentId=codex label=label \
    state="$state" model=gpt-5 modelHonored=true runtime=host spawnRuntime=ide >/dev/null
}

# megabrain_dispatch_preamble (dynamic PATH-based executable-hint text, with a distinct fallback
# message when the executable cannot be resolved through PATH or an absolute path) has no
# equivalent left: the compiled binary's spawn prompt (finalPrompt, src/cli/commands/
# orchestrate-spawn.ts) is a fixed template embedded inside executeSpawn, with no executable-path
# resolution at all and no standalone entry point to call it directly outside a real spawn.
# Dropped per rule 3.

# megabrain_spawn_mark_prompt_failed and megabrain_dispatch_failure_error (a formatter that
# surfaces the child's last stalled message inside a spawn failure error) have no TS callers or
# equivalent output shape anywhere in src/ -- grep for "child message:"/"failureError"/
# "markPromptFailed" across src/ is empty. A spawn failure is reported through executeSpawn's own
# Result, never through a standalone "failure error" formatter. Dropped per rule 3.

# The turn-end hook (src/cli/commands/hook-turn-end.ts, a full port of hooks/megabrain-turn-
# end.sh) never touches promptDelivery/promptReceipt/promptState for an ordinary turn, empty or
# not -- grep for those fields in hook-turn-end.ts only matches the unrelated usage-limit-refusal
# branch. The "a turn ending can implicitly confirm receipt, guarded against an empty turn"
# mechanism this scenario proved is gone; the only path that ever sets promptReceipt=received is
# an explicit child "received" message (via `megabrain received`, exercised below, or
# reconcile's syncPromptReceipt). Dropped per rule 3. FLAG FOR THE LEAD: this may be an
# intentional simplification (receipts are now always explicit) or a dropped safety net for
# agents that never call `megabrain received`; worth confirming which.

# megabrain_dispatch_send_prompt_with_receipt's bounded resend (MEGABRAIN_PROMPT_RECEIPT_ATTEMPTS
# retries, re-pressing Enter/Tab until a receipt appears or attempts are exhausted) has no
# equivalent: the compiled spawn path's awaitReceipt (src/cli/commands/orchestrate-spawn.ts)
# sends the prompt exactly once and then only polls for an existing receipt for
# MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS -- it never resends, and a timeout never fails the
# spawn (it returns success with promptState="awaiting-receipt", pointing at `orchestrate
# reconcile`; see tests/unit/spawn.test.ts: "returns success while receipt is pending and points
# to reconcile"). The three scenarios built on the old resend contract -- a bounded resend that
# eventually gets a receipt, exhaustion failing without claiming delivery, and a tmux Enter retry
# that must not duplicate composer text -- all test that removed contract. Dropped per rule 3.

outside="$state_dir/outside-repository"
mkdir -p "$outside"
write_dispatch_meta "$state_dir" outside-repository \
  parentSessionId=parent-terminal parentHost=superset childHost=superset workspaceId=workspace-test \
  terminalId=outside-terminal worktreePath="$outside" branch=main agent=codex agentId=codex \
  label=label state=spawning model=gpt-5 modelHonored=true runtime=host spawnRuntime=ide >/dev/null
(cd "$outside" && env -u TMUX -u TMUX_PANE -u ORCA_TERMINAL_HANDLE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=outside-terminal "$root/.build/megabrain" received >/dev/null)
assert_equal "$(find "$state_dir/dispatches/outside-repository/messages" -name '*-child-received.json' | wc -l | tr -d ' ')" 1
printf 'dispatch receipt works from a non-checkout directory\n'

create_dispatch optional-receipt spawning command-terminal
received_output="$(env -u SUPERSET_TERMINAL_ID -u TMUX -u TMUX_PANE ORCA_TERMINAL_HANDLE=command-terminal MEGABRAIN_STATE_DIR="$state_dir" \
  "$root/.build/megabrain" received)"
assert_equal "$received_output" 'received sent: optional-receipt'
received_message="$state_dir/dispatches/optional-receipt/messages/0001-child-received.json"
[ -f "$received_message" ] || fail 'received command did not leave a durable message'
assert_equal "$(jq -r '.type' "$received_message")" received
assert_equal "$(jq -r '.state' "$state_dir/dispatches/optional-receipt/meta.json")" running
printf 'received command is durable and authoritative\n'

create_dispatch running-reply running
reply_result="$("$root/.build/megabrain" orchestrate reply running-reply --text 'Continue work' --json)"
assert_equal "$(jq -r '.status' <<<"$reply_result")" queued
reply_message="$(find "$state_dir/dispatches/running-reply/messages" -name '*.json' -print -quit)"
assert_equal "$(jq -r '.type' "$reply_message")" reply
assert_equal "$(jq -r '.text' "$reply_message")" 'Continue work'
printf 'running child accepts queued parent reply\n'

# A child that has just ended an ask turn is waiting_for_reply. The turn-end hook must inspect
# its own mailbox before the waiting guard, and ask the agent to consume it.
create_dispatch waiting-reply waiting_for_reply waiting-terminal
append_dispatch_message "$state_dir" waiting-reply parent reply 'reply waiting at turn end' parent-terminal >/dev/null
waiting_hook_output="$(env -u SUPERSET_TERMINAL_ID -u TMUX -u TMUX_PANE ORCA_TERMINAL_HANDLE=waiting-terminal MEGABRAIN_STATE_DIR="$state_dir" \
  "$root/.build/megabrain" hook turn-end '{}')"
assert_equal "$(jq -r '.decision' <<<"$waiting_hook_output")" block
assert_contains "$(jq -r '.reason' <<<"$waiting_hook_output")" 'megabrain check'
waiting_delivery="$state_dir/dispatches/waiting-reply/deliveries"/*.json
assert_equal "$(jq -r '.status' $waiting_delivery)" outstanding
assert_equal "$(jq -r '.state' "$state_dir/dispatches/waiting-reply/meta.json")" waiting_for_reply
printf 'waiting child turn: hook exposes queued reply before the state guard\n'

printf 'ok: receipt delivery and running reply scenarios\n'
