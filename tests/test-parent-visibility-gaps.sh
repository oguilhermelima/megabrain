#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
binary="$root/.build/megabrain"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-parent-visibility.XXXXXX")"

cleanup() {
  local rc=$?
  rm -rf "$state_dir"
  return "$rc"
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

# Defects 1-3 (stalled-signal debounce, actionable/protocol mail classification, megabrain-usage
# routing) all sourced lib/module-orchestrate.sh, lib/module-context.sh, and
# lib/module-parent-notify.sh to call shell functions directly. megabrain_dispatch_message_append
# no longer exists anywhere in lib/ (grep: zero hits) — running the original file confirms this,
# failing immediately at line 58 (megabrain_dispatch_meta_read is also gone). Every one of those
# three defects is faithfully ported and covered by bun tests, so dropped here (rule 2):
#   - Defect 1 (stalled debounce: proven+idle due, proven+recent not due, missing always due,
#     unknown+recent not due) — tests/unit/hook-turn-end.test.ts: "does not append a stalled
#     message while the terminal is proven and the child spoke recently", "appends the fallback
#     stalled text when the terminal is missing and no payload text is given" cover the ported
#     stalledIsDue/hasRecentChildActivity (src/cli/commands/hook-turn-end.ts).
#   - Defect 2 (mail classification has exactly one owner, exhaustive over every actionable/
#     protocol key) — tests/unit/check.test.ts's "classifyMail" describe block is a test.each over
#     every key this scenario derived from the shell's canonical arrays (child:ask/done/stalled,
#     megabrain:usage, parent:withdrawal as actionable; child:received/ack, child:done with a
#     prior done, parent:interrupt/interrupt-result as protocol), plus "shows actionable child
#     mail by default and skips protocol mail" / "--full shows protocol mail" for the
#     default-vs-full visibility half. tests/unit/queue-write.test.ts has the same table for
#     classifyQueueMail/recipientForQueueMessage (the write-side classifier).
#   - Defect 3 (a megabrain-sender usage message routes to the parent) —
#     tests/unit/queue-write.test.ts's recipientForQueueMessage table includes
#     ("megabrain","usage",false) -> actionable -> recipient "parent".
#
# Defect 4 (orchestrate reply reports the truth about whether its nudge was typed, independent of
# whether the reply itself succeeds) has no equivalent bun coverage (grep for "nudge" across
# tests/unit/: only hook-turn-end.test.ts's unrelated finished-dispatch nudge). Kept as a
# black-box scenario driving the binary directly (rule 1). The fixture below uses state "running",
# not the original "stalled": tests/test-e2e-findings.sh already documents, as a rule-4 finding,
# that `orchestrate reply` now refuses a "stalled" dispatch outright rather than resuming it, which
# would make every scenario here fail on that unrelated, already-reported defect instead of
# exercising nudge honesty at all.

write_meta() {
  local state="$1" dispatch_id="$2"
  local dispatch_dir="$state/dispatches/$dispatch_id"
  mkdir -p "$dispatch_dir/messages" "$dispatch_dir/deliveries"
  jq -n --arg id "$dispatch_id" --arg terminalId "child-$dispatch_id" '{
    dispatchId: $id, parentSessionId: "parent-terminal", parentHost: "superset", parentWorkspaceId: "parent-workspace",
    parentTmuxSession: null, parentTmuxPane: null, childHost: "superset", workspaceId: "workspace-test",
    terminalId: $terminalId, worktreePath: "/work", branch: "main", agent: "codex", agentId: "codex",
    model: "gpt-5", effort: null, modelHonored: true, modelSubstitution: null, runtime: "host",
    spawnRuntime: "ide", tmuxSession: null, tmuxPane: null, label: "label", chain: null, state: "running",
    promptDelivered: false, promptDelivery: "pending", promptDeliveryReason: null, promptPublication: "pending",
    promptTransport: "pending", promptReceipt: "pending", promptState: "awaiting-publication",
    processState: "running", terminalState: "owned", terminalReason: null, failureCount: 0, stage: null,
    reason: null, reconcileOutcome: null, createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z"
  }' >"$dispatch_dir/meta.json"
}

bin_dir="$state_dir/bin"
mkdir -p "$bin_dir"

# Scenario: a failed terminal send is reported as nudge=not-typed while the reply itself still
# succeeds (status stays queued) — the notify failure must never fail the reply.
# Falsification: a dead pane turns the whole reply into a failure, or nudge is misreported as typed.
fail_state="$state_dir/nudge-fails"
write_meta "$fail_state" nudge-fails
cat >"$bin_dir/superset" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$bin_dir/superset"
reply_fail_output="$(PATH="$bin_dir:$PATH" SUPERSET_TERMINAL_ID=parent-terminal MEGABRAIN_STATE_DIR="$fail_state" "$binary" orchestrate reply nudge-fails --text 'answer despite a dead pane' --json)"
assert_equal "$(printf '%s' "$reply_fail_output" | jq -r '.status')" queued
assert_equal "$(printf '%s' "$reply_fail_output" | jq -r '.nudge')" not-typed
printf 'a failed terminal send is reported as nudge=not-typed while status stays queued\n'

# Scenario: a successful terminal send is reported as nudge=typed.
# Falsification: a live pane is misreported as not-typed.
ok_state="$state_dir/nudge-succeeds"
write_meta "$ok_state" nudge-succeeds
cat >"$bin_dir/superset" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = terminals ] && [ "${2:-}" = send ]; then
  printf '{}\n'
  exit 0
fi
exit 1
EOF
chmod +x "$bin_dir/superset"
reply_ok_output="$(PATH="$bin_dir:$PATH" SUPERSET_TERMINAL_ID=parent-terminal MEGABRAIN_STATE_DIR="$ok_state" "$binary" orchestrate reply nudge-succeeds --text 'answer reaches a live pane' --json)"
assert_equal "$(printf '%s' "$reply_ok_output" | jq -r '.status')" queued
assert_equal "$(printf '%s' "$reply_ok_output" | jq -r '.nudge')" typed
printf 'a successful terminal send is reported as nudge=typed\n'

printf 'ok: reply nudge honesty covered (stalled debounce, mail classification, and usage routing are bun-covered, see report)\n'
