#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/support/child-parent-loop-common.bash"

# A parent in a plain shell: no Orca, no Superset, no tmux, only an agent session id. The child
# runs in tmux, mail waits in the queue, the Stop hook surfaces it, and watch reads it.
MEGABRAIN_TEST_RUNTIME=tmux
export MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS=0
set_state_dir "$(mktemp -d "/tmp/mblp-local.XXXXXX")"
export MEGABRAIN_TEST_DISPATCH_ID=""
rm -f "$state_dir/bin/orca" "$state_dir/bin/superset"
unset ORCA_TERMINAL_HANDLE SUPERSET_TERMINAL_ID SUPERSET_WORKSPACE_ID ORCA_STRUCTURED_SESSION MEGABRAIN_SESSION_HOST MEGABRAIN_SESSION_ID TMUX TMUX_PANE MEGABRAIN_DISPATCH_ID
export CLAUDE_CODE_SESSION_ID=local-parent-session

chain_output="$(compiled_chain_run loop --parent-agent codex --worktree "$root" --prompt chain-launch --tmux true --json)"
dispatch_id="$(jq -r '.dispatch.dispatchId // empty' <<<"$chain_output")"
[ -n "$dispatch_id" ] || fail "local parent chain did not launch a dispatch: $chain_output"
export MEGABRAIN_TEST_DISPATCH_ID="$dispatch_id"
db_show() { MEGABRAIN_STATE_DIR="$state_dir" "$root/.build/megabrain" db show "$dispatch_id" --json; }
dispatch_meta="$(db_show | jq '.meta')"
assert_equal "$(jq -r '.parentHost' <<<"$dispatch_meta")" local
assert_equal "$(jq -r '.parentSessionId' <<<"$dispatch_meta")" claude:local-parent-session
child_session="$(jq -r '.tmuxSession' <<<"$dispatch_meta")"
child_pane="$(jq -r '.tmuxPane' <<<"$dispatch_meta")"
child_tmux="$(tmux_cmd display-message -p -t "$child_pane" '#{socket_path},#{pid},#{session_id}')"
printf 'local: spawn from a plain shell records a local parent\n'

child_command received >/dev/null
child_command ask local-question >/dev/null

# Nothing was typed into any terminal: the Stop hook is what tells the parent.
hook_output="$("$root/.build/megabrain" hook turn-end </dev/null)"
assert_equal "$(jq -r '.decision' <<<"$hook_output")" block
assert_contains "$(jq -r '.reason' <<<"$hook_output")" "orchestrate watch $dispatch_id"
hook_again="$("$root/.build/megabrain" hook turn-end </dev/null)"
assert_equal "$hook_again" '{}'
printf 'local: the Stop hook surfaces child mail once\n'

delivery="$(parent_watch_actionable)"
assert_equal "$(jq -r '.messages[0].text' <<<"$delivery")" local-question
compiled_parent_ack "$(jq -r '.deliveryId' <<<"$delivery")" >/dev/null
assert_equal "$(jq -r '.status' <<<"$(compiled_reply "$dispatch_id" --text local-reply --json)")" queued
child_command done local-complete >/dev/null
done_delivery="$(parent_watch)"
assert_equal "$(jq -r '.messages[0].text' <<<"$done_delivery")" local-complete
compiled_parent_ack "$(jq -r '.deliveryId' <<<"$done_delivery")" >/dev/null

tmux_cmd kill-pane -t "$child_pane" || true
compiled_close "$dispatch_id" --json >/dev/null
assert_equal "$(db_show | jq -r '.meta.state')" closed
printf 'ok: child parent loop end to end from a plain shell without Orca or Superset\n'
