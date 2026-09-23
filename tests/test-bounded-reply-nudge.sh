#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/fixtures/a-dispatch-meta.sh"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-reply-nudge.XXXXXX")"
state_root="$(cd -P "$state_root" && pwd -P)"
state_dir="$state_root/state"
socket_name=mbreply
session_name=megabrain-reply-nudge
parent_pane=""
child_pane=""

unset TMUX TMUX_PANE ORCA_TERMINAL_HANDLE SUPERSET_TERMINAL_ID
export TMUX_TMPDIR="$state_root"
export MEGABRAIN_STATE_DIR="$state_dir"

tmux_cmd() {
  tmux -L "$socket_name" "$@"
}

cleanup() {
  local rc=$?
  command tmux -L "$socket_name" kill-server >/dev/null 2>&1 || true
  rm -rf "$state_root"
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

tmux_cmd new-session -d -s "$session_name" -x 120 -y 30 bash
parent_pane="$(tmux_cmd display-message -p -t "$session_name" '#{pane_id}')"
tmux_info="$(tmux_cmd display-message -p -t "$parent_pane" '#{socket_path},#{pid},#{session_id}')"
case "${tmux_info%%,*}" in
  "$state_root"/*) ;;
  *) fail "refusing to run: the tmux server is outside $state_root" ;;
esac
export TMUX="$tmux_info"
export TMUX_PANE="$parent_pane"
parent_identity="$session_name:$parent_pane"
child_pane="$(tmux_cmd split-window -d -t "$session_name" -c "$root" -P -F '#{pane_id}' 'trap "" INT; sleep 60')"

# Fixture built directly with jq (tests/fixtures/a-dispatch-meta.sh): no lib/ sourcing, no
# megabrain_dispatch_meta_write.
create_meta() {
  local dispatch_id="$1" pane="$2" agent="${3:-codex}"
  write_dispatch_meta "$state_dir" "$dispatch_id" \
    parentSessionId="$parent_identity" parentHost=tmux childHost=tmux terminalId=child-terminal \
    worktreePath="$root" branch=main agent="$agent" agentId="$agent" label=label state=running \
    model=gpt-5 modelHonored=true tmuxSession="$session_name" tmuxPane="$pane" \
    runtime=tmux spawnRuntime=tmux parentTmuxSession="$session_name" parentTmuxPane="$parent_pane" >/dev/null
}

# `orchestrate reply` writes the queue message durably before it ever touches the pane
# (queue-write.ts's appendMessage runs first in executeOrchestrateReply), then attempts a
# best-effort nudge through the real tmux binary (queue-write.ts's notifyChild ->
# hosts/tmux.ts's sendTmuxPair: "tmux send-keys -l" followed by the submit key). A process that
# never reads stdin exercises real pty backpressure on that send: the durable write and the
# command's own return must not depend on the child ever consuming it. Real tmux only here, no
# fakes — the whole point is exercising actual pty behaviour.
dispatch_id=bounded-reply
create_meta "$dispatch_id" "$child_pane"
answer="$(printf '%65536s' '' | tr ' ' x)"
done_file="$state_root/reply-done"
reply_output="$state_root/reply-output"
reply_error="$state_root/reply-error"
(
  if "$root/.build/megabrain" orchestrate reply "$dispatch_id" --text "$answer" --json >"$reply_output" 2>"$reply_error"; then
    printf '0\n' >"$done_file"
  else
    printf '1\n' >"$done_file"
  fi
) &
reply_pid=$!
started="$(date +%s)"
while [ ! -f "$done_file" ]; do
  now="$(date +%s)"
  [ $((now - started)) -lt 5 ] || break
  sleep 0.05
done
if [ ! -f "$done_file" ]; then
  kill "$reply_pid" >/dev/null 2>&1 || true
  wait "$reply_pid" 2>/dev/null || true
  fail 'reply remained blocked while the child pane did not read stdin'
fi
wait "$reply_pid"
assert_equal "$(jq -r '.status' "$reply_output")" queued
assert_equal "$(find "$state_dir/dispatches/$dispatch_id/messages" -name '*.json' | wc -l | tr -d ' ')" 1
assert_equal "$(jq -r '.text' "$state_dir/dispatches/$dispatch_id/messages"/*.json)" "$answer"
printf 'busy child: reply returns within the bound and keeps the full queue message\n'

tmux_cmd kill-pane -t "$child_pane"

# megabrain_tmux_nudge_text_for_pane (width capping with an ellipsis) has no production caller
# left: notifyChild/sendParentPointer (src/core/queue-write.ts, wired through
# executeOrchestrateReply in src/cli/commands/orchestrate-reply.ts) send a fixed pointer string
# ("[megabrain] reply available; run megabrain check") with no pane-width measurement or
# truncation anywhere in that path. Dropped per rule 3.

# A fake "tmux" placed first on PATH, not a shell function override — a subprocess (the compiled
# binary) never sees this script's own function table, only real executables on PATH. It records
# every send-keys call so the reply command's real submit-key choice per agent can be observed
# from outside.
fake_bin="$state_root/bin"
mkdir -p "$fake_bin"
send_log="$state_root/send.log"
cat >"$fake_bin/tmux" <<EOF
#!/usr/bin/env bash
case "\$1" in
  display-message) printf '%s\n' "$session_name" ;;
  send-keys) printf '%s\n' "\$*" >>"$send_log" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$fake_bin/tmux"

# The real production reply path (executeOrchestrateReply -> notifyChild) picks the submit key
# from the dispatch's own agent (src/agents/claude.ts, codex.ts, agy.ts: claude=Enter, codex=Tab,
# agy has none) and reports "typed"/"not-typed" purely from whether that send itself succeeded --
# there is no busy-pane inspection, no backspace clearing, and no distinct "queued" nudge status
# anywhere in notifyChild; it sends unconditionally. The old busy-composer / backspace-clearing /
# per-affordance "queued" assertions tested a shell nudge system with no surviving counterpart;
# dropped per rule 3. What is still real and worth proving here: which key each agent's dispatch
# causes to be sent, that a missing affordance (agy) sends no keys at all and still reports
# "not-typed" without losing the queued message, and that the message stays durable and
# attributed regardless of nudge outcome.
scenario_agent_nudge() {
  local agent="$1" expect_key="$2" expect_nudge="$3"
  local dispatch_id="nudge-$agent"
  : >"$send_log"
  create_meta "$dispatch_id" '%fake' "$agent"
  local output message
  output="$(PATH="$fake_bin:$PATH" "$root/.build/megabrain" orchestrate reply "$dispatch_id" --text "answer for $agent" --json)"
  assert_equal "$(jq -r '.status' <<<"$output")" queued
  assert_equal "$(jq -r '.nudge' <<<"$output")" "$expect_nudge"
  message="$state_dir/dispatches/$dispatch_id/messages"/*.json
  assert_equal "$(jq -r '.text' $message)" "answer for $agent"
  assert_contains "$(jq -r '.sessionId' $message)" ':'
  if [ "$expect_key" = none ]; then
    [ ! -s "$send_log" ] || fail "$agent: expected no send-keys call, got: $(cat "$send_log")"
  else
    # The pane receives a fixed pointer, never the reply text itself (queue-write.ts's
    # notifyChild: "[megabrain] reply available; run megabrain check"); the reply text only ever
    # lands in the durable queue message asserted above.
    grep -Fqx 'send-keys -t %fake -l [megabrain] reply available; run megabrain check' "$send_log" || fail "$agent: pointer text was not sent literally: $(cat "$send_log")"
    grep -Fqx "send-keys -t %fake $expect_key" "$send_log" || fail "$agent: submit key $expect_key was not sent: $(cat "$send_log")"
  fi
  printf '%s nudge: submit key %s, reported %s\n' "$agent" "$expect_key" "$expect_nudge"
}

scenario_agent_nudge claude Enter typed
scenario_agent_nudge codex Tab typed
scenario_agent_nudge agy none not-typed

# The per-pane lock around a queued text-plus-key pair (so two concurrent nudges to the same pane
# never interleave into one draft) is exercised directly against the real sendTmuxPair in
# tests/unit/tmux.test.ts: "keeps each text and submit key pair under one pane lock". Dropped
# here per rule 2.

printf 'ok: bounded reply nudge scenarios\n'
