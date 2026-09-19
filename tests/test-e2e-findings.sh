#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-e2e-findings.XXXXXX")"
bin_dir="$state_dir/bin"
mkdir -p "$bin_dir"
cat >"$bin_dir/megabrain_superset" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = terminals ] && [ "${2:-}" = close ]; then
  printf '%s\n' '{"ok":true}'
  exit 0
fi
exit 1
EOF
chmod +x "$bin_dir/megabrain_superset"

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

export MEGABRAIN_STATE_DIR="$state_dir/state"
export MEGABRAIN_ROOT="$root"
export SUPERSET_TERMINAL_ID=parent-terminal
export PATH="$bin_dir:$PATH"

source "$root/lib/common.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-parent-notify.sh"
source "$root/lib/module-worktree.sh"

mkdir -p "$MEGABRAIN_DISPATCH_DIR"
host_call_log="$state_dir/host-calls"
: >"$host_call_log"

megabrain_dispatch_preamble() {
  printf 'preamble\n'
}

megabrain_superset_available() {
  return 0
}

host_mode=success
megabrain_superset() {
  printf '%s\n' "$*" >>"$host_call_log"
  if [ "$1" = terminals ] && [ "$2" = create ]; then
    if [ "$host_mode" = failure ]; then
      return 42
    fi
    printf '{"terminalId":"child-terminal"}\n'
    return 0
  fi
  if [ "$1" = terminals ] && [ "$2" = read ]; then
    if [ "$host_mode" = read-failure ]; then
      return 42
    fi
    printf '{"terminalId":"child-terminal","text":"READY"}\n'
    return 0
  fi
  return 1
}

megabrain_superset_wait_for_terminal_ready() {
  return 0
}

megabrain_dispatch_native_send() {
  return 0
}

megabrain_dispatch_send_prompt_with_receipt() {
  return 0
}

host_mode=failure
if host_failure_output="$(megabrain_launch_agent "$root" workspace-test codex gpt-5 medium ping label 2>&1)"; then
  fail 'host launch unexpectedly succeeded'
fi
assert_contains "$host_failure_output" 'Superset terminals create failed'
printf 'host launch failure reports the failed operation\n'

host_mode=read-failure
: >"$host_call_log"
if host_read_failure_output="$(megabrain_launch_agent "$root" workspace-test codex gpt-5 medium ping label 2>&1)"; then
  fail 'host read-back failure unexpectedly succeeded'
fi
assert_contains "$host_read_failure_output" 'could not be read immediately after creation'
assert_equal "$(wc -l <"$host_call_log" | tr -d ' ')" 3
assert_contains "$(sed -n '2p' "$host_call_log")" 'terminals read'
printf 'host launch fails immediately when terminal read-back fails\n'

host_mode=success
: >"$host_call_log"
host_output="$(megabrain_launch_agent "$root" workspace-test codex gpt-5 medium ping label 2>&1)"
assert_contains "$host_output" 'terminalId'
assert_equal "$(wc -l <"$host_call_log" | tr -d ' ')" 2
printf 'host launch success verifies and sends a dispatch\n'

megabrain_dispatch_meta_write list-live parent-terminal superset superset workspace-test child-terminal "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
: >"$host_call_log"
list_output="$(command_orchestrate_list --all --json)"
assert_equal "$(wc -l <"$host_call_log" | tr -d ' ')" 0
assert_equal "$(printf '%s' "$list_output" | jq -r 'map(select(.dispatchId == "list-live")) | length')" 1
printf 'dispatch list uses metadata without host calls\n'

megabrain_dispatch_meta_write stalled-live live-terminal superset superset workspace-test live-terminal "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
megabrain_dispatch_message_append stalled-live child received 'prompt received' live-terminal >/dev/null
env -u TMUX -u TMUX_PANE SUPERSET_TERMINAL_ID=live-terminal MEGABRAIN_HOOK_AGENT=codex "$root/hooks/megabrain-turn-end.sh" '{"last_assistant_message":"still working"}' >/dev/null
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/stalled-live/meta.json")" running
printf 'live queue activity does not trigger stalled\n'

megabrain_superset() {
  if [ "$1" = terminals ] && [ "$2" = list ]; then
    printf '[]\n'
    return 0
  fi
  return 1
}
megabrain_dispatch_meta_write stalled-missing child-terminal superset superset workspace-test missing-terminal "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
env -u TMUX -u TMUX_PANE SUPERSET_TERMINAL_ID=missing-terminal MEGABRAIN_HOOK_AGENT=codex "$root/hooks/megabrain-turn-end.sh" '{"last_assistant_message":"stuck"}' >/dev/null
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/stalled-missing/meta.json")" running
printf 'missing terminal does not rewrite the dispatch contract\n'

megabrain_dispatch_meta_write stalled-done done-terminal superset superset workspace-test done-terminal "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
env -u TMUX -u TMUX_PANE SUPERSET_TERMINAL_ID=done-terminal "$root/megabrain" done 'completed after recovery' >/dev/null
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/stalled-done/meta.json")" done
printf 'done is accepted from the open dispatch contract\n'

megabrain_dispatch_meta_write stalled-ask parent-terminal superset superset workspace-test stalled-ask-terminal "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
TMUX= TMUX_PANE= SUPERSET_TERMINAL_ID=stalled-ask-terminal MEGABRAIN_DISPATCH_ID=stalled-ask \
  "$root/.build/megabrain" ask 'question after stall' >/dev/null
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/stalled-ask/meta.json")" waiting_for_reply
printf 'ask is accepted from the open dispatch contract\n'

megabrain_dispatch_meta_write orphaned-ask parent-terminal superset superset workspace-test orphaned-ask-terminal "$root" main codex label orphaned gpt-5 true codex '' '' host ide >/dev/null
TMUX= TMUX_PANE= SUPERSET_TERMINAL_ID=orphaned-ask-terminal MEGABRAIN_DISPATCH_ID=orphaned-ask \
  "$root/.build/megabrain" ask 'question after orphaning' >/dev/null
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/orphaned-ask/meta.json")" waiting_for_reply
printf 'ask is accepted from orphaned\n'

megabrain_dispatch_terminal_status() {
  MEGABRAIN_TERMINAL_STATUS=unknown
}

megabrain_dispatch_parent_status() {
  MEGABRAIN_PARENT_STATUS=alive
}

megabrain_dispatch_native_close() {
  MEGABRAIN_DISPATCH_CLOSE_OUTCOME=host
  return 0
}

megabrain_dispatch_meta_write queued-proof parent-terminal superset superset workspace-test queued-proof-terminal "$root" main codex label done gpt-5 true codex '' '' host ide >/dev/null
megabrain_dispatch_message_append queued-proof child done 'finished before close' queued-proof-terminal >/dev/null
megabrain_dispatch_reconcile_one queued-proof
assert_equal "$MEGABRAIN_RECONCILE_OUTCOME" adopted
assert_equal "$(jq -r '.terminalState' "$MEGABRAIN_DISPATCH_DIR/queued-proof/meta.json")" owned
MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate close queued-proof >/dev/null
assert_equal "$(jq -r '.terminalState' "$MEGABRAIN_DISPATCH_DIR/queued-proof/meta.json")" released
printf 'child queue message proves identity for a done dispatch\n'

megabrain_dispatch_meta_write queued-unproven parent-terminal superset superset workspace-test queued-unproven-terminal "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
megabrain_dispatch_reconcile_one queued-unproven
assert_equal "$MEGABRAIN_RECONCILE_OUTCOME" identity-unproven
assert_equal "$(jq -r '.terminalState' "$MEGABRAIN_DISPATCH_DIR/queued-unproven/meta.json")" retained
printf 'unproven terminal without child queue evidence remains retained\n'

megabrain_dispatch_meta_write late-reply parent-terminal superset superset workspace-test late-reply-terminal "$root" main codex label done gpt-5 true codex '' '' host ide >/dev/null
if late_reply_output="$(megabrain_dispatch_reply late-reply --text 'late answer' --json 2>&1)"; then
  fail 'a reply to a settled dispatch was accepted'
fi
assert_contains "$late_reply_output" 'open a new dispatch'
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/late-reply/meta.json")" done
assert_equal "$(find "$MEGABRAIN_DISPATCH_DIR/late-reply/messages" -name '*.json' | wc -l | tr -d ' ')" 0
printf 'reply to a settled dispatch is refused and keeps the queue empty\n'

stalled_reply_send_mode=success
megabrain_dispatch_native_send() {
  [ "$stalled_reply_send_mode" = success ]
}
megabrain_dispatch_meta_write stalled-reply-accepted parent-terminal superset superset workspace-test stalled-reply-terminal "$root" main codex label stalled gpt-5 true codex '' '' host ide >/dev/null
stalled_reply_output="$(megabrain_dispatch_reply stalled-reply-accepted --text 'reply reaches stalled child' --json)"
assert_equal "$(printf '%s' "$stalled_reply_output" | jq -r '.status')" queued
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/stalled-reply-accepted/meta.json")" running
printf 'stalled reply: accepted and resumed the dispatch\n'

stalled_reply_send_mode=failure
megabrain_dispatch_meta_write stalled-reply-resumed parent-terminal superset superset workspace-test stalled-reply-resumed-terminal "$root" main codex label stalled gpt-5 true codex '' '' host ide >/dev/null
stalled_reply_output="$(megabrain_dispatch_reply stalled-reply-resumed --text 'queued reply resumes stalled child' --json)"
assert_equal "$(printf '%s' "$stalled_reply_output" | jq -r '.status')" queued
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/stalled-reply-resumed/meta.json")" running
printf 'stalled reply queue: transport failure still resumed the dispatch\n'

model_output="$("$root/megabrain" model list)"
assert_contains "$model_output" 'sourced'
assert_contains "$model_output" 'verified'
assert_equal "$("$root/megabrain" model list --json | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-5.6-luna") | .provenance.kind')" sourced
assert_equal "$("$root/megabrain" model list --json | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-5.6-luna") | .reasoning.provenance.kind')" verified
assert_equal "$("$root/megabrain" model list --json | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-5.6-luna") | .reasoning.provenance.verified[0]')" xhigh
printf 'model list separates sourced ids from verified effort spellings\n'

printf 'ok: end to end findings coverage\n'
