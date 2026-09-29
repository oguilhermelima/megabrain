#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
binary="$root/.build/megabrain"
source "$root/tests/support/state-db.bash"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-e2e-findings.XXXXXX")"


cleanup() {
  rm -rf "$state_root"
}
trap cleanup EXIT

[ -x "$binary" ] || {
  printf 'skip: compiled binary is missing at %s; run bun run build\n' "$binary"
  exit 0
}

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

# Writes a dispatch meta.json directly (the JSON shape megabrain_dispatch_meta_write used to
# produce), without sourcing lib/module-orchestrate.sh: that function itself is now
# production-dead (zero callers anywhere in lib/, megabrain, or hooks/ — orchestrate's
# state-changing verbs all forward straight to the binary), so this is fixture setup only, not
# behaviour under test.
write_meta() {
  local state_dir="$1" dispatch_id="$2" parent_session="$3" state="$4" terminal_state="${5:-owned}" runtime="${6:-host}"
  local dispatch_dir="$state_dir/dispatches/$dispatch_id"
  mkdir -p "$dispatch_dir/messages" "$dispatch_dir/deliveries"
  jq -n --arg id "$dispatch_id" --arg parent "$parent_session" --arg state "$state" --arg terminalState "$terminal_state" --arg runtime "$runtime" '{
    dispatchId: $id, parentSessionId: $parent, parentHost: "superset", parentWorkspaceId: null,
    parentTmuxSession: null, parentTmuxPane: null, childHost: "superset", workspaceId: "workspace-test",
    terminalId: ($id + "-terminal"), worktreePath: "/work", branch: "main", agent: "codex", agentId: "codex",
    model: "gpt-5", effort: null, modelHonored: true, modelSubstitution: null, runtime: $runtime,
    spawnRuntime: (if $runtime == "tmux" then "tmux" else "ide" end), tmuxSession: null, tmuxPane: null,
    label: "label", chain: null, state: $state, promptDelivered: false, promptDelivery: "pending",
    promptDeliveryReason: null, promptPublication: "pending", promptTransport: "pending", promptReceipt: "pending",
    promptState: "awaiting-publication",
    processState: (if $state == "running" then "running" elif $state == "done" then "succeeded" elif $state == "failed" then "failed" elif $state == "closed" then "stopped" elif $state == "stalled" then "running" else "start-unproven" end),
    terminalState: $terminalState, terminalReason: null, failureCount: 0, stage: null, reason: null,
    reconcileOutcome: null, createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z"
  }' >"$dispatch_dir/meta.json"
}

# Scenario: `orchestrate list --all --json` reads imported dispatch state; it must
# never shell out to the host CLI just to list what it already has on disk.
# Falsification: a fake host binary on PATH that always fails would make the command fail (or
# hang) if it were ever invoked.
state1="$state_root/list"
write_meta "$state1" list-live parent-terminal running
state_db_import "$binary" "$state1"
hostile_bin="$state_root/hostile-bin"
mkdir -p "$hostile_bin"
cat >"$hostile_bin/superset" <<'EOF'
#!/usr/bin/env bash
printf 'a host call was made during orchestrate list\n' >&2
exit 1
EOF
chmod +x "$hostile_bin/superset"
list_output="$(PATH="$hostile_bin:$PATH" MEGABRAIN_STATE_DIR="$state1" "$binary" orchestrate list --all --json)"
assert_equal "$(printf '%s' "$list_output" | jq -r 'map(select(.dispatchId == "list-live")) | length')" 1
printf 'dispatch list uses metadata without host calls\n'

# Scenario: `done` and `ask` are accepted through the whole CLI-to-database path, from both a
# "running" and an "orphaned" starting state, and land the dispatch in the state the child/parent
# queue contract expects.
# Falsification: the CLI would refuse a transition the dispatch-state machine allows, or leave
# database row unchanged.
state2="$state_root/done-ask"
write_meta "$state2" stalled-done parent-terminal running
state_db_import "$binary" "$state2"
SUPERSET_TERMINAL_ID=stalled-done-terminal MEGABRAIN_STATE_DIR="$state2" MEGABRAIN_DISPATCH_ID=stalled-done \
  "$root/.build/megabrain" done 'completed after recovery' >/dev/null
assert_equal "$(state_db_dispatch "$binary" "$state2" stalled-done | jq -r '.meta.state')" done
printf 'done is accepted from the open dispatch contract\n'

write_meta "$state2" stalled-ask parent-terminal running
state_db_import "$binary" "$state2" true
SUPERSET_TERMINAL_ID=stalled-ask-terminal MEGABRAIN_STATE_DIR="$state2" MEGABRAIN_DISPATCH_ID=stalled-ask \
  "$binary" ask 'question after stall' >/dev/null
assert_equal "$(state_db_dispatch "$binary" "$state2" stalled-ask | jq -r '.meta.state')" waiting_for_reply
printf 'ask is accepted from the open dispatch contract\n'

write_meta "$state2" orphaned-ask parent-terminal orphaned
state_db_import "$binary" "$state2" true
SUPERSET_TERMINAL_ID=orphaned-ask-terminal MEGABRAIN_STATE_DIR="$state2" MEGABRAIN_DISPATCH_ID=orphaned-ask \
  "$binary" ask 'question after orphaning' >/dev/null
assert_equal "$(state_db_dispatch "$binary" "$state2" orphaned-ask | jq -r '.meta.state')" waiting_for_reply
printf 'ask is accepted from orphaned\n'

# Scenario: `orchestrate close` releases a terminal that reconcile already proved ("owned") on a
# settled dispatch.
# Falsification: close would leave terminalState untouched or refuse a done dispatch.
state3="$state_root/close"
write_meta "$state3" queued-proof parent-terminal done owned
state_db_import "$binary" "$state3"
SUPERSET_TERMINAL_ID=parent-terminal MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state3" "$binary" orchestrate close queued-proof >/dev/null
assert_equal "$(state_db_dispatch "$binary" "$state3" queued-proof | jq -r '.meta.terminalState')" released
printf 'orchestrate close releases an owned terminal on a settled dispatch\n'

# A fresh, isolated MEGABRAIN_STATE_DIR is required here: without one, model list falls back to
# resolving state against the real $HOME, reading whatever personal ~/.megabrain/models.json
# happens to exist on the machine running the test instead of upgrading a fresh copy from this
# repo's tracked .megabrain/models.json template — the two can disagree (a local state copy can be
# older than the template). Isolating it is what makes this scenario deterministic.
model_state="$state_root/model-list"
mkdir -p "$model_state"
model_output="$(MEGABRAIN_STATE_DIR="$model_state" "$root/.build/megabrain" model list)"
assert_contains "$model_output" 'sourced'
assert_contains "$model_output" 'verified'
assert_equal "$(MEGABRAIN_STATE_DIR="$model_state" "$root/.build/megabrain" model list --json | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-5.6-luna") | .provenance.kind')" sourced
assert_equal "$(MEGABRAIN_STATE_DIR="$model_state" "$root/.build/megabrain" model list --json | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-5.6-luna") | .reasoning.provenance.kind')" verified
assert_equal "$(MEGABRAIN_STATE_DIR="$model_state" "$root/.build/megabrain" model list --json | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-5.6-luna") | .reasoning.provenance.verified[0]')" xhigh
printf 'model list separates sourced ids from verified effort spellings\n'

# FINDINGS below are placed last so every scenario above still runs and reports; set -e plus
# fail()'s immediate exit means the script still stops at the first one reached (rule 4: leave it
# failing, do not weaken the assertion). Both are documented here regardless of which one a given
# run actually reaches.

# A reply to a dispatch already "done" is refused and leaves its mailbox empty.
state4="$state_root/reply-done"
write_meta "$state4" late-reply parent-terminal done
state_db_import "$binary" "$state4"
if late_reply_output="$(SUPERSET_TERMINAL_ID=parent-terminal MEGABRAIN_STATE_DIR="$state4" "$binary" orchestrate reply late-reply --text 'late answer' --json 2>&1)"; then
  fail "a reply to a settled dispatch unexpectedly succeeded: $late_reply_output"
fi
assert_contains "$late_reply_output" 'settled in state done'
assert_equal "$(state_db_dispatch "$binary" "$state4" late-reply | jq -r '.meta.state')" done
assert_equal "$(state_db_dispatch "$binary" "$state4" late-reply | jq -r '.messages | length')" 0
printf 'reply to a settled dispatch is refused and its mailbox stays empty\n'

# A legacy "stalled" dispatch is rejected because it is outside the database state constraint.
state5="$state_root/reply-stalled"
write_meta "$state5" stalled-reply parent-terminal stalled
if stalled_import_output="$(state_db_import "$binary" "$state5" 2>&1)"; then
  fail 'database import unexpectedly accepted the retired stalled state'
fi
assert_contains "$stalled_import_output" 'invalid dispatch state: stalled'
printf 'legacy stalled state is rejected during import\n'

printf 'ok: end to end findings coverage for current database behavior\n'
