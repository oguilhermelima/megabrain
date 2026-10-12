#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/support/child-parent-loop-common.bash"

# A coordinator whose runtime runs every command in a fresh shell with no tty and no agent session
# id. A long-lived perl process stands in for that runtime: each command below runs in its own
# sh -c under it, so the shells differ but the ancestor does not.
MEGABRAIN_TEST_RUNTIME=tmux
export MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS=0
set_state_dir "$(mktemp -d "/tmp/mblp-stable.XXXXXX")"
export MEGABRAIN_TEST_DISPATCH_ID=""
rm -f "$state_dir/bin/orca" "$state_dir/bin/superset"
unset ORCA_TERMINAL_HANDLE SUPERSET_TERMINAL_ID SUPERSET_WORKSPACE_ID ORCA_STRUCTURED_SESSION MEGABRAIN_SESSION_HOST MEGABRAIN_SESSION_ID CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID TMUX TMUX_PANE MEGABRAIN_DISPATCH_ID

runner_fifo="$state_dir/runner.fifo"
mkfifo "$runner_fifo"
perl -e 'open(my $f, "<", $ARGV[0]) or die; while (my $line = <$f>) { chomp $line; system("sh", "-c", $line); }' "$runner_fifo" &
runner_pid=$!
exec 9>"$runner_fifo"

# Runs one command line in its own sh -c under the runner, waits for it, prints its stdout.
in_runtime() {
  local out="$state_dir/out.$RANDOM" marker="$state_dir/done.$RANDOM"
  printf '{ %s ; } >%s 2>&1; echo $? >%s\n' "$*" "$out" "$marker" >&9
  local attempt=0
  while [ ! -s "$marker" ] && [ "$attempt" -lt 600 ]; do sleep 0.05; attempt=$((attempt + 1)); done
  [ -s "$marker" ] || fail "runtime command timed out: $*"
  [ "$(cat "$marker")" = 0 ] || fail "runtime command failed ($(cat "$marker")): $*: $(cat "$out")"
  cat "$out"
}

mb="MEGABRAIN_STATE_DIR=$state_dir PATH=$state_dir/bin:\$PATH $root/.build/megabrain"
chain_output="$(in_runtime "$mb chain run loop --parent-agent codex --worktree $root --prompt chain-launch --tmux true --json")"
dispatch_id="$(jq -r '.dispatch.dispatchId // empty' <<<"$chain_output")"
[ -n "$dispatch_id" ] || fail "spawn did not launch a dispatch: $chain_output"
export MEGABRAIN_TEST_DISPATCH_ID="$dispatch_id"
db_show() { MEGABRAIN_STATE_DIR="$state_dir" "$root/.build/megabrain" db show "$dispatch_id" --json; }
dispatch_meta="$(db_show | jq '.meta')"
assert_equal "$(jq -r '.parentHost' <<<"$dispatch_meta")" local
case "$(jq -r '.parentSessionId' <<<"$dispatch_meta")" in
  proc:*) ;;
  *) fail "owner is not a proc identity: $(jq -r '.parentSessionId' <<<"$dispatch_meta")" ;;
esac
child_session="$(jq -r '.tmuxSession' <<<"$dispatch_meta")"
child_pane="$(jq -r '.tmuxPane' <<<"$dispatch_meta")"
child_tmux="$(tmux_cmd display-message -p -t "$child_pane" '#{socket_path},#{pid},#{session_id}')"
printf 'stable owner: spawn records a proc owner\n'

child_command received >/dev/null
child_command ask stable-question >/dev/null

watched="$(in_runtime "$mb orchestrate watch $dispatch_id --timeout 10 --json")"
assert_equal "$(jq -r '.messages[0].text' <<<"$watched")" stable-question
in_runtime "$mb orchestrate ack $dispatch_id $(jq -r '.deliveryId' <<<"$watched") --json" >/dev/null
assert_equal "$(jq -r '.status' <<<"$(in_runtime "$mb orchestrate reply $dispatch_id --text stable-reply --json")")" queued
printf 'stable owner: watch, ack and reply from separate shells succeed\n'

child_command done stable-complete >/dev/null
done_delivery="$(in_runtime "$mb orchestrate watch $dispatch_id --timeout 10 --json")"
assert_equal "$(jq -r '.messages[0].text' <<<"$done_delivery")" stable-complete
in_runtime "$mb orchestrate ack $dispatch_id $(jq -r '.deliveryId' <<<"$done_delivery") --json" >/dev/null
tmux_cmd kill-pane -t "$child_pane" || true
in_runtime "$mb orchestrate close $dispatch_id --json" >/dev/null
assert_equal "$(db_show | jq -r '.meta.state')" closed
exec 9>&-
wait "$runner_pid" 2>/dev/null || true
printf 'ok: a local caller keeps one owner across transient shells\n'
