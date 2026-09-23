#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
unset TMUX TMUX_PANE
state_dir=""
session_name=""
parent_pane=""
child_pane=""
child_session=""
child_tmux=""

# No -L socket: TMUX_TMPDIR alone (set in set_state_dir) isolates this test's default-socket tmux
# server from the host's. A named socket here would put the test's own "parent" session on a
# different server than the one the compiled binary's tmux launch line creates for the child --
# tmux new-session with no -L/-S targets the default socket under $TMUX_TMPDIR, so both sides
# must agree on using the default one to ever see the same server (confirmed empirically: with
# -L set here, `tmux list-sessions` only ever showed this test's own session, never the child's).
cleanup_tmux_server() {
  local directory="${1:-}"
  [ -n "$directory" ] || return 0
  TMUX_TMPDIR="$directory" env -u TMUX -u TMUX_PANE command tmux kill-server >/dev/null 2>&1 || true
}

cleanup() {
  local rc=$?
  cleanup_tmux_server "$state_dir"
  [ -n "$state_dir" ] && rm -rf "$state_dir"
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

wait_for_pane_text() {
  local pane="$1" expected="$2" attempt=0 capture=""
  while [ "$attempt" -lt 200 ]; do
    capture="$(tmux_cmd capture-pane -p -J -t "$pane" -S -20)"
    case "$capture" in
      *"$expected"*) return 0 ;;
    esac
    sleep 0.05
    attempt=$((attempt + 1))
  done
  fail "timed out waiting for '$expected' in pane $pane"
}

tmux_cmd() {
  tmux "$@"
}

compiled_close() {
  MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate close "$@"
}

# `chain run` execs the compiled binary unconditionally (lib/module-chain.sh's command_chain:
# "migrated chain verbs have no shell fallback"), so it is driven directly here rather than
# through the shell wrapper.
compiled_chain_run() {
  "$root/.build/megabrain" chain run "$@"
}

compiled_watch() {
  MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate watch "$@"
}

compiled_parent_ack() {
  MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate ack "$dispatch_id" "$1" --json
}

compiled_reply() {
  MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate reply "$@"
}

# Fixtures below build dispatch/chain state directly with jq. set_state_dir also lays down real
# executables on PATH for superset/orca/codex -- the compiled binary is a real subprocess and
# only ever sees PATH executables, never a shell function of the same name.
set_state_dir() {
  cleanup_tmux_server "$state_dir"
  [ -n "$state_dir" ] && rm -rf "$state_dir"
  state_dir="$(cd -P "$1" && pwd -P)"
  export TMUX_TMPDIR="$state_dir"
  export MEGABRAIN_STATE_DIR="$state_dir"
  export MEGABRAIN_CHAIN_FILE="$state_dir/chains.json"
  # A fresh HOME, with its own .bashrc/.bash_profile pinning PATH: orchestrate-spawn.ts's
  # createTmuxSession leaves the child pane's shell unspecified (hosts/tmux.ts's
  # createTmuxSession only passes a command when one is given, which the tmux launch path never
  # does), so tmux starts its configured default-shell as a *login* shell. A login bash sources
  # /etc/profile, which on Debian unconditionally resets PATH to a fixed system default -- wiping
  # out whatever PATH the spawning process had, fake bin directory included (confirmed
  # empirically inside the container: the child pane's own $PATH read back as
  # "/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games", Debian's login.defs default, even
  # though the spawning process's PATH was correct). ~/.bash_profile runs after /etc/profile for
  # a login shell and restores the fake bin directory; ~/.bashrc (sourced by .bash_profile, and
  # directly by a non-login interactive shell) does the same, so this holds regardless of which
  # form the pane's shell takes.
  export HOME="$state_dir/home"
  mkdir -p "$HOME" "$state_dir/bin"
  printf 'export PATH=%q:$PATH\n' "$state_dir/bin" >"$HOME/.bashrc"
  printf '. "$HOME/.bashrc"\n' >"$HOME/.bash_profile"
  # The tmux launch line runs this literally (agents/codex.ts's real flags are ignored by a
  # script that does not parse argv): it stands in for a real Codex TUI. It must print the exact
  # idle-composer marker classifyLiveness's codex matcher looks for (agents/codex.ts: /^\s*›
  # Ask Codex to do anything\s*$/m) before waitForTmuxReadiness's idle-detection will ever
  # consider the pane ready to receive the prompt, and again after each line it "answers".
  cat >"$state_dir/bin/codex" <<'CODEXEOF'
#!/usr/bin/env bash
printf '\xe2\x80\xba Ask Codex to do anything\n'
while IFS= read -r line; do
  printf 'agent-response:%s\n' "$line"
  printf '\xe2\x80\xba Ask Codex to do anything\n'
done
CODEXEOF
  chmod +x "$state_dir/bin/codex"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "${1:-}" = terminals ] && [ "${2:-}" = list ]; then' \
    '  printf '\''{"sessions":[{"terminalId":"child-terminal","title":"megabrain-dispatch-%s"}]}\n'\'' "${MEGABRAIN_TEST_DISPATCH_ID:-}"' \
    'elif [ "${1:-}" = terminals ] && [ "${2:-}" = read ]; then' \
    '  printf '\''{"text":"READY"}\n'\''' \
    'elif [ "${1:-}" = terminals ] && [ "${2:-}" = create ]; then' \
    '  printf '\''{"terminalId":"child-terminal"}\n'\''' \
    'elif [ "${1:-}" = terminals ] && [ "${2:-}" = send ]; then' \
    '  printf '\''%s\n'\'' "$*" >>"$MEGABRAIN_TEST_SEND_LOG"' \
    '  printf '\''{"ok":true}\n'\''' \
    'else' \
    '  printf '\''{"ok":true}\n'\''' \
    'fi' >"$state_dir/bin/superset"
  chmod +x "$state_dir/bin/superset"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "${1:-}" = terminal ] && [ "${2:-}" = close ]; then' \
    '  printf '\''{"ok":true}\n'\''' \
    '  exit 0' \
    'fi' \
    'exit 1' >"$state_dir/bin/orca"
  chmod +x "$state_dir/bin/orca"
  export PATH="$state_dir/bin:$PATH"
  export MEGABRAIN_TEST_SEND_LOG="$state_dir/fake-sends.log"
  : >"$MEGABRAIN_TEST_SEND_LOG"
  jq -n '{chains:{loop:{when:{parentAgent:"codex"},steps:[{agent:"codex",model:"gpt-5.6-luna",effort:"low"}]}},defaultSteps:[]}' >"$MEGABRAIN_CHAIN_FILE"
}

prepare_tmux_parent() {
  session_name="megabrain-loop-parent-$$"
  tmux_cmd new-session -d -s "$session_name" bash
  parent_pane="$(tmux_cmd display-message -p -t "$session_name" '#{pane_id}')"
  tmux_cmd send-keys -t "$parent_pane" -l "PS1='PARENT$ '; export PS1; printf 'parent-ready\\n'"
  tmux_cmd send-keys -t "$parent_pane" Enter
  wait_for_pane_text "$parent_pane" parent-ready
}

child_command() {
  local verb="$1" text="${2:-}"
  if [ "$MEGABRAIN_TEST_RUNTIME" = tmux ]; then
    if [ "$verb" = received ]; then
      env -u SUPERSET_TERMINAL_ID -u ORCA_TERMINAL_HANDLE MEGABRAIN_STATE_DIR="$state_dir" TMUX="$child_tmux" TMUX_PANE="$child_pane" "$root/megabrain" "$verb"
    else
      env -u SUPERSET_TERMINAL_ID -u ORCA_TERMINAL_HANDLE MEGABRAIN_STATE_DIR="$state_dir" TMUX="$child_tmux" TMUX_PANE="$child_pane" "$root/megabrain" "$verb" "$text"
    fi
  else
    if [ "$verb" = received ]; then
      env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" "$verb"
    else
      env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" "$verb" "$text"
    fi
  fi
}

child_check() {
  if [ "$MEGABRAIN_TEST_RUNTIME" = tmux ]; then
    env -u SUPERSET_TERMINAL_ID -u ORCA_TERMINAL_HANDLE MEGABRAIN_STATE_DIR="$state_dir" TMUX="$child_tmux" TMUX_PANE="$child_pane" "$root/megabrain" check --timeout 0 --json
  else
    env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" check --timeout 0 --json
  fi
}

child_ack() {
  if [ "$MEGABRAIN_TEST_RUNTIME" = tmux ]; then
    env -u SUPERSET_TERMINAL_ID -u ORCA_TERMINAL_HANDLE MEGABRAIN_STATE_DIR="$state_dir" TMUX="$child_tmux" TMUX_PANE="$child_pane" "$root/megabrain" ack "$1" --json
  else
    env -u TMUX -u TMUX_PANE MEGABRAIN_STATE_DIR="$state_dir" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" ack "$1" --json
  fi
}

parent_watch() {
  local timeout="${1:-10}"
  compiled_watch "$dispatch_id" --timeout "$timeout" --poll-interval 0 --wait-mode poll --full --json
}

assert_parent_receipt() {
  local delivery="$1"
  assert_equal "$(jq -r '.status' <<<"$delivery")" received
  assert_equal "$(jq -r '.messages[0].type' <<<"$delivery")" received
  assert_equal "$(jq -r '.messages[0].text' <<<"$delivery")" 'prompt received'
}

parent_watch_actionable() {
  local delivery delivery_type delivery_id
  while :; do
    delivery="$(parent_watch 10)"
    delivery_type="$(jq -r '.messages[0].type // empty' <<<"$delivery")"
    case "$delivery_type" in
      received)
        assert_parent_receipt "$delivery"
        delivery_id="$(jq -r '.deliveryId' <<<"$delivery")"
        compiled_parent_ack "$delivery_id" >/dev/null
        ;;
      ask|done|stalled|usage)
        printf '%s\n' "$delivery"
        return 0
        ;;
      *)
        fail "unexpected parent mail type: ${delivery_type:-none}"
        ;;
    esac
  done
}

run_flow() {
  local runtime="$1" spawn_choice chain_output dispatch_meta reply_result
  local receipt_delivery receipt_delivery_id delivery replay delivery_id
  local push_check push_delivery push_ack push_receipt push_receipt_id
  local done_delivery done_delivery_id close_output
  MEGABRAIN_TEST_RUNTIME="$runtime"
  export MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS=1
  set_state_dir "$(mktemp -d "/tmp/mblp-$runtime.XXXXXX")"
  export MEGABRAIN_TEST_DISPATCH_ID=""
  if [ "$runtime" = tmux ]; then
    export ORCA_TERMINAL_HANDLE=parent-terminal
    unset SUPERSET_TERMINAL_ID SUPERSET_WORKSPACE_ID
    prepare_tmux_parent
    spawn_choice=true
  else
    export SUPERSET_TERMINAL_ID=parent-terminal SUPERSET_WORKSPACE_ID=workspace-test
    unset ORCA_TERMINAL_HANDLE TMUX TMUX_PANE
    spawn_choice=false
  fi

  chain_output="$(compiled_chain_run loop --parent-agent codex --worktree "$root" --prompt chain-launch --tmux "$spawn_choice" --json)"
  assert_equal "$(jq -r '.step' <<<"$chain_output")" 1
  assert_equal "$(jq -r '.agent' <<<"$chain_output")" codex
  dispatch_id="$(jq -r '.dispatch.dispatchId // empty' <<<"$chain_output")"
  [ -n "$dispatch_id" ] || fail "$runtime chain did not launch a dispatch"
  export MEGABRAIN_TEST_DISPATCH_ID="$dispatch_id"
  dispatch_meta="$(cat "$state_dir/dispatches/$dispatch_id/meta.json")"

  if [ "$runtime" = tmux ]; then
    child_session="$(jq -r '.tmuxSession' <<<"$dispatch_meta")"
    child_pane="$(jq -r '.tmuxPane' <<<"$dispatch_meta")"
    child_tmux="$(tmux_cmd display-message -p -t "$child_pane" '#{socket_path},#{pid},#{session_id}')"
    assert_contains "$(tmux_cmd capture-pane -p -t "$child_pane" -S -30)" 'agent-response:chain-launch'
  else
    assert_contains "$(cat "$MEGABRAIN_TEST_SEND_LOG")" chain-launch
  fi

  # awaitReceipt (orchestrate-spawn.ts) only polls an existing receipt; it never resends the
  # prompt (see the WHY note in tests/test-prompt-delivery.sh). So the child confirms receipt for
  # real, as its own next step, instead of racing a background writer against spawn's own short
  # internal poll window.
  child_command received >/dev/null
  receipt_delivery="$(parent_watch 10)"
  assert_parent_receipt "$receipt_delivery"
  receipt_delivery_id="$(jq -r '.deliveryId' <<<"$receipt_delivery")"
  compiled_parent_ack "$receipt_delivery_id" >/dev/null
  # updateMeta (src/cli/commands/queue-write.ts) sets promptReceipt/promptState from a "received"
  # message directly, but promptDelivered/promptDelivery only flip through reconcile's
  # syncPromptReceipt (src/cli/commands/orchestrate-stop-reconcile.ts) -- already exercised
  # directly in tests/test-prompt-state.sh's "reconcile-receipt" scenario, so it is not repeated
  # here.
  assert_equal "$(jq -r '.promptReceipt' "$state_dir/dispatches/$dispatch_id/meta.json")" received
  printf '%s: chain run launches a dispatch and the child receipt is durable\n' "$runtime"

  child_command ask "$runtime-question" >/dev/null
  delivery="$(parent_watch_actionable)"
  replay="$(parent_watch)"
  delivery_id="$(jq -r '.deliveryId' <<<"$delivery")"
  assert_equal "$(jq -r '.messages[0].text' <<<"$delivery")" "$runtime-question"
  assert_equal "$(jq -r '.replayed' <<<"$replay")" true
  assert_equal "$(jq -r '.deliveryId' <<<"$replay")" "$delivery_id"
  compiled_parent_ack "$delivery_id" >/dev/null
  printf '%s: child ask is delivered once and replays for a second read\n' "$runtime"

  # A reply's nudge to a busy or unreachable pane is a separate, already-covered concern
  # (tests/test-bounded-reply-nudge.sh's per-agent nudge table; tests/test-queue-control.sh's
  # supersede/stop scenarios): notifyChild sends unconditionally and the queued message is
  # durable regardless of the nudge outcome. This flow only needs one ordinary reply round trip
  # to prove the loop closes end to end.
  reply_result="$(compiled_reply "$dispatch_id" --text "$runtime-reply-text" --json)"
  assert_equal "$(jq -r '.status' <<<"$reply_result")" queued
  push_check="$(child_check)"
  assert_contains "$(jq -r '.text' <<<"$push_check")" "$runtime-reply-text"
  push_delivery="$(jq -r '.deliveryId' <<<"$push_check")"
  push_ack="$(child_ack "$push_delivery")"
  assert_equal "$(jq -r '.duplicate' <<<"$push_ack")" false
  push_receipt="$(parent_watch)"
  assert_equal "$(jq -r '.messages[0].type' <<<"$push_receipt")" ack
  assert_equal "$(jq -r '.messages[0].text' <<<"$push_receipt")" "$push_delivery"
  push_receipt_id="$(jq -r '.deliveryId' <<<"$push_receipt")"
  compiled_parent_ack "$push_receipt_id" >/dev/null
  printf '%s: parent reply reaches the child and the child ack reaches the parent\n' "$runtime"

  child_command done "$runtime-complete" >/dev/null
  done_delivery="$(parent_watch)"
  assert_equal "$(jq -r '.messages[0].text' <<<"$done_delivery")" "$runtime-complete"
  done_delivery_id="$(jq -r '.deliveryId' <<<"$done_delivery")"
  compiled_parent_ack "$done_delivery_id" >/dev/null
  assert_equal "$(jq -r '.duplicate' <<<"$(compiled_parent_ack "$done_delivery_id")")" true

  queue_types="$(find "$state_dir/dispatches/$dispatch_id/messages" -name '*.json' -exec jq -r '[.from, .type] | join("/")' {} \; | sort)"
  assert_contains "$queue_types" 'child/received'
  assert_contains "$queue_types" 'child/ask'
  assert_contains "$queue_types" 'parent/reply'
  assert_contains "$queue_types" 'child/ack'
  assert_contains "$queue_types" 'child/done'

  if [ "$runtime" = tmux ]; then
    tmux_cmd kill-pane -t "$child_pane"
    close_output="$(compiled_close "$dispatch_id" --json)"
    tmux_cmd has-session -t "$child_session" >/dev/null 2>&1 && fail 'tmux session survived close' || true
  else
    close_output="$(compiled_close "$dispatch_id" --json)"
  fi
  assert_contains "$close_output" "$dispatch_id"
  assert_equal "$(jq -r '.state' "$state_dir/dispatches/$dispatch_id/meta.json")" closed
  assert_equal "$(find "$state_dir/dispatches/$dispatch_id/deliveries" -name '*.json' -exec jq -r 'select(.status == "outstanding") | .id' {} \; | wc -l | tr -d ' ')" 0
  printf '%s end-to-end: chain, receipt, ask, reply, done, duplicate ack, and close\n' "$runtime"
}
