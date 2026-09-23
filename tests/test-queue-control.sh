#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/fixtures/a-dispatch-meta.sh"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-queue-control.XXXXXX")"
pane_fixture="$state_dir/pane.transcript"
stop_calls_file="$state_dir/stop.calls"
terminal_status_fixture=proven

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

export MEGABRAIN_STATE_DIR="$state_dir"
export MEGABRAIN_ROOT="$root"
export SUPERSET_TERMINAL_ID=parent-terminal
unset TMUX TMUX_PANE ORCA_TERMINAL_HANDLE

# A fake tmux/ps/orca on PATH, ahead of the real ones -- the compiled binary is a real
# subprocess and only ever sees executables on PATH, never this script's own shell functions.
fake_bin="$state_dir/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes) printf '%s\n' "$TARGET_PANE" ;;
  display-message) printf '999\n' ;;
  capture-pane) cat "$PANE_FIXTURE" ;;
  send-keys) printf '%s\n' "$*" >>"$STOP_CALLS_FILE" ;;
  *) exit 0 ;;
esac
EOF
cat >"$fake_bin/ps" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = -p ]; then
  printf 'pts/1\n'
elif [ "${IDENTITY_FIXTURE:-unknown}" = proven ]; then
  printf '999 1 worker MEGABRAIN_DISPATCH_ID=%s\n' "$TARGET_DISPATCH"
else
  printf '999 1 unrelated-worker\n'
fi
EOF
cat >"$fake_bin/orca" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  'terminal list') printf '{"result":{"terminals":[{"handle":"%s"},{"handle":"parent-terminal"}]}}\n' "${ORCA_IDENTITY:-unknown}" ;;
  'terminal send') printf '%s\n' "$*" >>"$STOP_CALLS_FILE"; printf '%s\n' '{"ok":true}' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fake_bin/tmux" "$fake_bin/ps" "$fake_bin/orca"
export PATH="$fake_bin:/usr/bin:/bin" PANE_FIXTURE="$pane_fixture" STOP_CALLS_FILE="$stop_calls_file"

compiled_stop() {
  local dispatch_id="$1" pane identity
  pane="$(jq -r '.tmuxPane // empty' "$state_dir/dispatches/$dispatch_id/meta.json")"
  identity="$terminal_status_fixture"
  env MEGABRAIN_ROOT="$root" MEGABRAIN_SESSION_HOST=superset MEGABRAIN_SESSION_ID=parent-terminal \
    TARGET_PANE="$pane" TARGET_DISPATCH="$dispatch_id" IDENTITY_FIXTURE="$identity" ORCA_CHILD_ID="$dispatch_id-child" ORCA_IDENTITY="${identity/proven/$dispatch_id-child}" \
    "$root/.build/megabrain" orchestrate stop "$@"
}

compiled_reply() {
  env MEGABRAIN_SESSION_HOST=superset MEGABRAIN_SESSION_ID="${SUPERSET_TERMINAL_ID}" "$root/.build/megabrain" orchestrate reply "$@"
}

compiled_change() {
  "$root/.build/megabrain" orchestrate change "$@"
}

compiled_check() {
  "$root/.build/megabrain" check "$@"
}

compiled_ack() {
  "$root/.build/megabrain" ack "$@"
}

begin_scenario() {
  export SUPERSET_TERMINAL_ID=parent-terminal
  unset TMUX TMUX_PANE ORCA_TERMINAL_HANDLE
}

# Fixture built directly with jq (tests/fixtures/a-dispatch-meta.sh): no lib/ sourcing, no
# megabrain_dispatch_meta_write.
create_dispatch() {
  local dispatch_id="$1" runtime="${2:-tmux}" host="${3:-superset}"
  write_dispatch_meta "$state_dir" "$dispatch_id" \
    parentSessionId=parent-terminal parentHost=superset childHost="$host" workspaceId="$host" \
    terminalId="$dispatch_id-child" worktreePath="$root" branch=main agent=codex agentId=codex \
    label=label state=running model=gpt-5 modelHonored=true tmuxSession=session-% \
    tmuxPane="$dispatch_id-pane" runtime="$runtime" spawnRuntime="$runtime" >/dev/null
}

set_pane_fixture() {
  cp "$root/tests/fixtures/agent-liveness/$1.transcript" "$pane_fixture"
}

# orchestrate reply's JSON output carries no message sequence; the sequence is read back from
# the queue file the compiled binary itself just wrote.
last_reply_seq() {
  local dispatch_id="$1" file
  file="$(find "$state_dir/dispatches/$dispatch_id/messages" -name '*-parent-reply.json' | sort | tail -1)"
  jq -r '.seq' "$file"
}

scenario_empty_report() {
  local json plain
  begin_scenario
  create_dispatch empty-report host
  export SUPERSET_TERMINAL_ID=empty-report-child
  json="$(compiled_check --timeout 0 --poll-interval 0 --json)"
  assert_equal "$(jq -r '.status' <<<"$json")" empty
  plain="$(compiled_check --timeout 0 --poll-interval 0)"
  assert_contains "$plain" 'status: empty'
  printf 'empty mailbox reports empty in JSON and plain output\n'
}

scenario_supersede_undelivered() {
  local result old_first old_second child_view full_view
  begin_scenario
  create_dispatch supersede-queued host
  compiled_reply supersede-queued --text 'old direction one' >/dev/null
  old_first="$(last_reply_seq supersede-queued)"
  compiled_reply supersede-queued --text 'old direction two' >/dev/null
  old_second="$(last_reply_seq supersede-queued)"
  result="$(compiled_reply supersede-queued --text 'new authoritative direction' --supersede --json)"
  assert_equal "$(jq -r '.supersededQueued' <<<"$result")" 2
  assert_equal "$(jq -r '.supersededDelivered' <<<"$result")" 0
  assert_equal "$(jq -r '.deliveredSequences | length' <<<"$result")" 0
  assert_equal "$(jq -r '.status' <<<"$result")" queued
  assert_equal "$(jq -s '[.[].status] | map(select(. == "superseded")) | length' "$state_dir/dispatches/supersede-queued/deliveries"/*.json)" 2
  assert_equal "$(jq -s '[.[].status] | map(select(. == "outstanding")) | length' "$state_dir/dispatches/supersede-queued/deliveries"/*.json)" 1
  export SUPERSET_TERMINAL_ID=supersede-queued-child
  child_view="$(compiled_check --timeout 0 --poll-interval 0 --json)"
  assert_contains "$(jq -r '.text' <<<"$child_view")" 'new authoritative direction'
  assert_not_contains "$(jq -r '.text' <<<"$child_view")" 'old direction'
  compiled_ack "$(jq -r '.deliveryId' <<<"$child_view")" >/dev/null
  full_view="$(compiled_check --timeout 0 --poll-interval 0 --full --json)"
  assert_equal "$(jq -r '.messageSeqs | join(",")' <<<"$full_view")" "$old_first"
  assert_contains "$(jq -r '.text' <<<"$full_view")" 'old direction one'
  compiled_ack "$(jq -r '.deliveryId' <<<"$full_view")" >/dev/null
  full_view="$(compiled_check --timeout 0 --poll-interval 0 --full --json)"
  assert_equal "$(jq -r '.messageSeqs | join(",")' <<<"$full_view")" "$old_second"
  printf 'undelivered replies are superseded from the actionable stream and remain in full trace\n'
}

scenario_supersede_delivered() {
  local result old_seq child_view withdrawal_path
  begin_scenario
  create_dispatch supersede-delivered host
  compiled_reply supersede-delivered --text 'old delivered direction' >/dev/null
  old_seq="$(last_reply_seq supersede-delivered)"
  export SUPERSET_TERMINAL_ID=supersede-delivered-child
  child_view="$(compiled_check --timeout 0 --poll-interval 0 --json)"
  assert_equal "$(jq -r '.messageSeqs | join(",")' <<<"$child_view")" "$old_seq"
  export SUPERSET_TERMINAL_ID=parent-terminal
  result="$(compiled_reply supersede-delivered --text 'new direction' --supersede --json)"
  assert_equal "$(jq -r '.supersededQueued' <<<"$result")" 0
  assert_equal "$(jq -r '.supersededDelivered' <<<"$result")" 1
  assert_equal "$(jq -r '.deliveredSequences | join(",")' <<<"$result")" "$old_seq"
  withdrawal_path="$state_dir/dispatches/supersede-delivered/messages"/*-parent-withdrawal.json
  assert_equal "$(jq -r '.type' $withdrawal_path)" withdrawal
  # appendMessage's persisted shape (src/cli/commands/queue-write.ts) is fixed:
  # {seq,from,type,text,createdAt,sessionId}, with no room for an extra structured "supersedes"
  # array the way the retired shell writer had -- the withdrawn sequence is only ever encoded in
  # the prose text below. The old structured-field assertion is dropped per rule 3.
  assert_contains "$(jq -r '.text' $withdrawal_path)" "$old_seq"
  export SUPERSET_TERMINAL_ID=supersede-delivered-child
  child_view="$(compiled_check --timeout 0 --poll-interval 0 --json)"
  assert_equal "$(jq -r '.messages[0].type' <<<"$child_view")" withdrawal
  assert_contains "$(jq -r '.text' <<<"$child_view")" "$old_seq"
  printf 'delivered replies produce a withdrawal naming their sequence\n'
}

scenario_stop_pending_check() {
  local result
  begin_scenario
  create_dispatch stop-pending
  set_pane_fixture pending-check
  if result="$(compiled_stop stop-pending --json 2>&1)"; then
    fail 'pending-check frame was not refused'
  fi
  assert_contains "$result" 'pending check'
  assert_equal "$(find "$state_dir/dispatches/stop-pending/messages" -name '*.json' -type f | wc -l | tr -d ' ')" 0
  printf 'pending-check transcript refuses stop before sending Escape\n'
}

scenario_stop_working() {
  local result message_types
  begin_scenario
  create_dispatch stop-working
  set_pane_fixture working
  : >"$stop_calls_file"
  result="$(compiled_stop stop-working --json)"
  assert_equal "$(jq -r '.status' <<<"$result")" interrupted
  assert_equal "$(wc -l <"$stop_calls_file" | tr -d ' ')" 1
  message_types="$(jq -r '.type' "$state_dir/dispatches/stop-working/messages"/*.json | tr '\n' ' ')"
  assert_equal "$message_types" 'interrupt interrupt-result '
  printf 'working transcript records the interrupt before and after Escape\n'
}

scenario_stop_host() {
  local result
  begin_scenario
  create_dispatch stop-host host
  if result="$(compiled_stop stop-host --json 2>&1)"; then
    fail 'Superset runtime accepted an interrupt it cannot provide'
  fi
  assert_contains "$result" 'Superset terminals send offers no interrupt capability'
  printf 'Superset runtime refuses its missing interrupt capability explicitly\n'
}

scenario_stop_orca() {
  local result message
  begin_scenario
  create_dispatch stop-orca host orca
  terminal_status_fixture=proven
  : >"$stop_calls_file"
  result="$(compiled_stop stop-orca --json)"
  assert_equal "$(jq -r '.status' <<<"$result")" interrupted
  assert_equal "$(wc -l <"$stop_calls_file" | tr -d ' ')" 1
  assert_contains "$(cat "$stop_calls_file")" '--interrupt'
  message="$(jq -r '.text' "$state_dir/dispatches/stop-orca/messages"/*-parent-interrupt.json)"
  assert_contains "$message" 'working liveness and pending-check frame are unavailable on Orca'
  printf 'Orca interrupts through terminal send and records its weaker guard explicitly\n'
}

scenario_stop_orca_unproven() {
  local result
  begin_scenario
  create_dispatch stop-orca-unproven host orca
  terminal_status_fixture=unknown
  : >"$stop_calls_file"
  if result="$(compiled_stop stop-orca-unproven --json 2>&1)"; then
    fail 'Orca runtime interrupted without terminal identity proof'
  fi
  assert_contains "$result" 'Orca terminal identity is unproven'
  assert_equal "$(wc -l <"$stop_calls_file" | tr -d ' ')" 0
  printf 'Orca refuses an interrupt when terminal identity cannot be proven\n'
}

scenario_change_on_refusal() {
  local result child_view
  begin_scenario
  create_dispatch change-refused
  compiled_reply change-refused --text 'obsolete direction' >/dev/null
  set_pane_fixture pending-check
  result="$(compiled_change change-refused --text 'authoritative replacement' --json 2>&1)" || true
  assert_equal "$(jq -r '.queueChanged' <<<"$result")" true
  assert_equal "$(jq -r '.interrupted' <<<"$result")" false
  assert_contains "$result" 'not interrupted'
  export SUPERSET_TERMINAL_ID=change-refused-child
  child_view="$(compiled_check --timeout 0 --poll-interval 0 --json)"
  assert_contains "$(jq -r '.text' <<<"$child_view")" 'authoritative replacement'
  printf 'change keeps the queue update when the interrupt guard refuses\n'
}

case "${1:-all}" in
  empty) scenario_empty_report ;;
  undelivered) scenario_supersede_undelivered ;;
  delivered) scenario_supersede_delivered ;;
  pending) scenario_stop_pending_check ;;
  working) scenario_stop_working ;;
  host) scenario_stop_host ;;
  orca) scenario_stop_orca ;;
  orca-unproven) scenario_stop_orca_unproven ;;
  change) scenario_change_on_refusal ;;
  all)
    scenario_empty_report
    scenario_supersede_undelivered
    scenario_supersede_delivered
    scenario_stop_pending_check
    scenario_stop_working
    scenario_stop_host
    scenario_stop_orca
    scenario_stop_orca_unproven
    scenario_change_on_refusal
    ;;
  *) fail "unknown scenario: $1" ;;
esac

printf 'ok: queue supersession and interrupt guards\n'
