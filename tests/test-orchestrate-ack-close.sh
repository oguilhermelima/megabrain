#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

binary="$root/.build/megabrain"

if [ ! -x "$binary" ]; then
  printf 'skip: compiled ack-close binary is missing at %s; run bun run build\n' "$binary"
  exit 0
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-ack-close.XXXXXX")"
fake_dir="$work_dir/bin"
mkdir -p "$fake_dir" "$work_dir/home"

cleanup() {
  local rc=$?
  if [ -n "${waiter_pid:-}" ]; then
    kill "$waiter_pid" 2>/dev/null || true
    wait "$waiter_pid" 2>/dev/null || true
  fi
  rm -rf "$work_dir"
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

cat >"$fake_dir/superset" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = terminals ] && [ "${2:-}" = close ]; then
  printf 'close:%s\n' "${6:-}" >>"$MEGABRAIN_TEST_HOST_LOG"
  if [ "${MEGABRAIN_TEST_CLOSE_MODE:-success}" = failure ]; then
    printf '%s\n' '{"error":{"message":"terminal close denied by host"}}' >&2
    exit 1
  fi
  printf '%s\n' '{"ok":true}'
  exit 0
fi
if [ "${1:-}" = terminals ] && [ "${2:-}" = send ]; then
  printf '%s\n' "$*" >>"$MEGABRAIN_TEST_SEND_LOG"
  printf '%s\n' '{"ok":true}'
  exit 0
fi
exit 1
EOF
cp "$fake_dir/superset" "$fake_dir/megabrain_superset"
chmod +x "$fake_dir/superset" "$fake_dir/megabrain_superset"

export PATH="$fake_dir:$PATH"
export HOME="$work_dir/home"
export MEGABRAIN_STATE_DIR="$work_dir/bootstrap"
export SUPERSET_TERMINAL_ID=parent-terminal
unset ORCA_TERMINAL_HANDLE TMUX TMUX_PANE

# Writes meta.json and a delivery record directly (the shapes megabrain_dispatch_meta_write and
# megabrain_dispatch_delivery_write used to produce), without sourcing lib/module-orchestrate.sh:
# both functions are now production-dead (zero callers anywhere in lib/, megabrain, or hooks/ —
# `orchestrate ack`/child `ack` forward straight to the binary, on purpose, per their own WHY
# comment about not letting a shell fallback diverge from the shared queue semantics). Fixture
# setup only, not behaviour under test.
make_dispatch() {
  local state_dir="$1" dispatch_id="$2" state="$3" delivery_id="$4"
  local dispatch_dir="$state_dir/dispatches/$dispatch_id"
  export MEGABRAIN_STATE_DIR="$state_dir"
  export MEGABRAIN_DISPATCH_DIR="$state_dir/dispatches"
  mkdir -p "$dispatch_dir/messages" "$dispatch_dir/deliveries"
  jq -n --arg id "$dispatch_id" --arg state "$state" --arg terminalId "terminal-$dispatch_id" --arg worktree "$root" '{
    dispatchId: $id, parentSessionId: "parent-terminal", parentHost: "superset", parentWorkspaceId: null,
    parentTmuxSession: null, parentTmuxPane: null, childHost: "superset", workspaceId: "workspace-test",
    terminalId: $terminalId, worktreePath: $worktree, branch: "main", agent: "codex", agentId: "codex",
    model: "gpt-5", effort: null, modelHonored: true, modelSubstitution: null, runtime: "host",
    spawnRuntime: "ide", tmuxSession: null, tmuxPane: null, label: "label", chain: null, state: $state,
    promptDelivered: false, promptDelivery: "pending", promptDeliveryReason: null, promptPublication: "pending",
    promptTransport: "pending", promptReceipt: "pending", promptState: "awaiting-publication",
    processState: (if $state == "done" then "succeeded" elif $state == "running" then "running" else "start-unproven" end),
    terminalState: "owned", terminalReason: null, failureCount: 0, stage: null, reason: null,
    reconcileOutcome: null, createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z"
  }' >"$dispatch_dir/meta.json"
  jq -n --arg id "$delivery_id" --arg dispatchId "$dispatch_id" '{
    id: $id, dispatchId: $dispatchId, consumer: "superset/parent-terminal", consumerGeneration: 1,
    messageSeqs: [1], status: "outstanding", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z",
    acknowledgedAt: null, fencedAt: null
  }' >"$dispatch_dir/deliveries/$delivery_id.json"
}

run_parent_ack() {
  local implementation="$1" state_dir="$2" dispatch_id="$3" delivery_id="$4" close="$5" mode="$6"
  local output rc
  export MEGABRAIN_STATE_DIR="$state_dir"
  export MEGABRAIN_ORCHESTRATE_ACK_IMPLEMENTATION="$implementation"
  export MEGABRAIN_TEST_CLOSE_MODE="$mode"
  set +e
  # --consumer/--generation pin the ack to the exact consumer identity the fixture's delivery
  # record was written with, rather than relying on ambient caller-identity auto-detection (whose
  # resolved "id" is not always the plain SUPERSET_TERMINAL_ID value once a persistent session id
  # is available) to happen to match.
  if [ "$close" = true ]; then
    output="$("$root/megabrain" orchestrate ack "$dispatch_id" "$delivery_id" --consumer superset/parent-terminal --generation 1 --close --json 2>"$state_dir/error")"
  else
    output="$("$root/megabrain" orchestrate ack "$dispatch_id" "$delivery_id" --consumer superset/parent-terminal --generation 1 --json 2>"$state_dir/error")"
  fi
  rc=$?
  set -e
  ACK_OUTPUT="$output"
  ACK_RC="$rc"
  ACK_ERROR="$(cat "$state_dir/error")"
}

run_child_ack() {
  local implementation="$1" state_dir="$2" delivery_id="$3"
  local output rc
  export MEGABRAIN_STATE_DIR="$state_dir"
  export MEGABRAIN_ORCHESTRATE_ACK_IMPLEMENTATION="$implementation"
  export SUPERSET_TERMINAL_ID=child-terminal
  set +e
  output="$("$root/megabrain" ack "$delivery_id" --close 2>"$state_dir/error")"
  rc=$?
  set -e
  CHILD_OUTPUT="$output"
  CHILD_RC="$rc"
  CHILD_ERROR="$(cat "$state_dir/error")"
  export SUPERSET_TERMINAL_ID=parent-terminal
}

# MEGABRAIN_ORCHESTRATE_ACK_IMPLEMENTATION has no effect anywhere in lib/ any more (grep: zero
# hits) — `orchestrate ack`/child `ack` are unconditional binary passthroughs now, so a "shell vs
# binary" loop over this variable would just run the identical binary path twice under two
# labels (rule 3: a MEGABRAIN_*_IMPLEMENTATION=shell comparison that no longer does anything).
# Collapsed to a single pass.
implementation=binary
{
  state_dir="$work_dir/$implementation-done"
  dispatch_id="done-$implementation"
  delivery_id="delivery-$implementation"
  make_dispatch "$state_dir" "$dispatch_id" done "$delivery_id"
  : >"$work_dir/host.log"
  export MEGABRAIN_TEST_HOST_LOG="$work_dir/host.log"
  run_parent_ack "$implementation" "$state_dir" "$dispatch_id" "$delivery_id" true success
  assert_equal "$ACK_RC" 0
  assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_id/deliveries/$delivery_id.json")" acknowledged
  assert_equal "$(jq -r '.state' "$state_dir/dispatches/$dispatch_id/meta.json")" closed
  assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/$dispatch_id/meta.json")" released
  assert_equal "$(wc -l <"$work_dir/host.log" | tr -d ' ')" 1
  assert_equal "$(printf '%s' "$ACK_OUTPUT" | jq -r '.close.status')" closed
  assert_equal "$(printf '%s' "$ACK_OUTPUT" | jq -r '.duplicate')" false
  printf '%s: done ack closes and acknowledges\n' "$implementation"

  state_dir="$work_dir/$implementation-running"
  dispatch_id="running-$implementation"
  delivery_id="running-delivery-$implementation"
  make_dispatch "$state_dir" "$dispatch_id" running "$delivery_id"
  : >"$work_dir/host.log"
  run_parent_ack "$implementation" "$state_dir" "$dispatch_id" "$delivery_id" true success
  assert_equal "$ACK_RC" 1
  assert_contains "$ACK_ERROR" dispatch-not-done
  assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_id/deliveries/$delivery_id.json")" outstanding
  assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/$dispatch_id/meta.json")" owned
  assert_equal "$(wc -l <"$work_dir/host.log" | tr -d ' ')" 0
  printf '%s: running ack-close refuses without side effects\n' "$implementation"

  state_dir="$work_dir/$implementation-duplicate"
  dispatch_id="duplicate-$implementation"
  delivery_id="duplicate-delivery-$implementation"
  make_dispatch "$state_dir" "$dispatch_id" done "$delivery_id"
  : >"$work_dir/host.log"
  run_parent_ack "$implementation" "$state_dir" "$dispatch_id" "$delivery_id" true success
  run_parent_ack "$implementation" "$state_dir" "$dispatch_id" "$delivery_id" true success
  assert_equal "$ACK_RC" 0
  assert_equal "$(printf '%s' "$ACK_OUTPUT" | jq -r '.duplicate')" true
  assert_equal "$(printf '%s' "$ACK_OUTPUT" | jq -r '.close.duplicate')" true
  assert_equal "$(wc -l <"$work_dir/host.log" | tr -d ' ')" 1
  printf '%s: duplicate ack-close reports both duplicates\n' "$implementation"

  state_dir="$work_dir/$implementation-failure"
  dispatch_id="failure-$implementation"
  delivery_id="failure-delivery-$implementation"
  make_dispatch "$state_dir" "$dispatch_id" done "$delivery_id"
  run_parent_ack "$implementation" "$state_dir" "$dispatch_id" "$delivery_id" true failure
  assert_equal "$ACK_RC" 1
  assert_contains "$ACK_ERROR" acknowledged
  assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_id/deliveries/$delivery_id.json")" acknowledged
  assert_equal "$(jq -r '.state' "$state_dir/dispatches/$dispatch_id/meta.json")" done
  assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/$dispatch_id/meta.json")" owned
  printf '%s: close failure preserves durable acknowledgement\n' "$implementation"

  state_dir="$work_dir/$implementation-plain"
  dispatch_id="plain-$implementation"
  delivery_id="plain-delivery-$implementation"
  make_dispatch "$state_dir" "$dispatch_id" done "$delivery_id"
  run_parent_ack "$implementation" "$state_dir" "$dispatch_id" "$delivery_id" false success
  assert_equal "$ACK_RC" 0
  assert_equal "$(printf '%s' "$ACK_OUTPUT" | jq -r 'has("close")')" false
  assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_id/deliveries/$delivery_id.json")" acknowledged
  assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/$dispatch_id/meta.json")" owned
  printf '%s: ack without close keeps its JSON shape\n' "$implementation"

  state_dir="$work_dir/$implementation-child"
  dispatch_id="child-$implementation"
  delivery_id="child-delivery-$implementation"
  make_dispatch "$state_dir" "$dispatch_id" done "$delivery_id"
  jq '.terminalId = "child-terminal"' "$state_dir/dispatches/$dispatch_id/meta.json" >"$state_dir/meta.tmp"
  mv "$state_dir/meta.tmp" "$state_dir/dispatches/$dispatch_id/meta.json"
  run_child_ack "$implementation" "$state_dir" "$delivery_id"
  assert_equal "$CHILD_RC" 2
  assert_contains "$CHILD_ERROR" 'unknown orchestrate ack option: --close'
  assert_equal "$(jq -r '.status' "$state_dir/dispatches/$dispatch_id/deliveries/$delivery_id.json")" outstanding
  printf '%s: child ack rejects close as a usage error\n' "$implementation"
}

export SUPERSET_TERMINAL_ID=parent-terminal
export MEGABRAIN_TEST_SEND_LOG="$work_dir/send.log"

# The superset host provider's send() refuses a null workspace ("superset cannot address a
# terminal without a workspace", src/hosts/superset.ts) — a real requirement for a Superset
# terminal, not something make_dispatch's fixture sets by default (parentWorkspaceId: null there
# covers every other scenario, which never reach a real send() call).
set_parent_workspace() {
  jq '.parentWorkspaceId = "workspace-test"' "$1" >"$1.tmp"
  mv "$1.tmp" "$1"
}

: >"$MEGABRAIN_TEST_SEND_LOG"
hook_state="$work_dir/hook-state"
make_dispatch "$hook_state" hook-owned done hook-delivery
set_parent_workspace "$hook_state/dispatches/hook-owned/meta.json"
"$binary" hook turn-end '{}' >/dev/null
assert_equal "$(wc -l <"$MEGABRAIN_TEST_SEND_LOG" | tr -d ' ')" 1
assert_contains "$(cat "$MEGABRAIN_TEST_SEND_LOG")" 'orchestrate close hook-owned'
printf 'turn-end hook notices an owned done dispatch with a retained terminal\n'

: >"$MEGABRAIN_TEST_SEND_LOG"
waiter_state="$work_dir/hook-waiter"
make_dispatch "$waiter_state" hook-waiter done waiter-delivery
set_parent_workspace "$waiter_state/dispatches/hook-waiter/meta.json"
sleep 30 &
waiter_pid=$!
printf '%s\n' "{\"pid\":$waiter_pid}" >"$waiter_state/dispatches/hook-waiter/waiter.json"
"$binary" hook turn-end '{}' >/dev/null
assert_equal "$(wc -l <"$MEGABRAIN_TEST_SEND_LOG" | tr -d ' ')" 0
kill "$waiter_pid" 2>/dev/null || true
wait "$waiter_pid" 2>/dev/null || true
unset waiter_pid
printf 'turn-end hook suppresses a done dispatch with an active watch\n'

: >"$MEGABRAIN_TEST_SEND_LOG"
foreign_state="$work_dir/hook-foreign"
make_dispatch "$foreign_state" hook-foreign done foreign-delivery
set_parent_workspace "$foreign_state/dispatches/hook-foreign/meta.json"
jq '.parentSessionId = "other-parent"' "$foreign_state/dispatches/hook-foreign/meta.json" >"$foreign_state/meta.tmp"
mv "$foreign_state/meta.tmp" "$foreign_state/dispatches/hook-foreign/meta.json"
"$binary" hook turn-end '{}' >/dev/null
assert_equal "$(wc -l <"$MEGABRAIN_TEST_SEND_LOG" | tr -d ' ')" 0
printf 'turn-end hook suppresses a done dispatch owned by another session\n'

printf 'ok: orchestrate ack-close and finished-dispatch notice\n'
