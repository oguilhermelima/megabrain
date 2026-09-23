#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/fixtures/a-dispatch-meta.sh"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-state-guards.XXXXXX")"

cleanup() {
  rm -rf "$state_root"
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

export MEGABRAIN_STATE_DIR="$state_root/state"
export HOME="$state_root/home"
mkdir -p "$MEGABRAIN_STATE_DIR"

write_dispatch() {
  local dispatch_id="$1" state="$2"
  write_dispatch_meta "$MEGABRAIN_STATE_DIR" "$dispatch_id" state="$state" >/dev/null
}

# WHY: megabrain_terminal_kill_process_tree (lib/module-worktree.sh) and the doctor's
# MODULE_LEAKED_DISPATCH_SESSIONS nounset-default check have no production caller left —
# `megabrain terminal close`/`megabrain doctor` both forward unconditionally to the compiled
# binary (lib/module-worktree.sh:445-... and lib/module-install.sh:16-25), so command_install's
# shell body and module_orchestration_doctor (the only callers) are already unreachable dead
# code. Dropped per rule 3, not rewritten: there is no CLI surface left that exercises either
# property.

scenario_reply_uses_transition_table() {
  local output failure_output
  write_dispatch orphaned-reply orphaned
  output="$(SUPERSET_TERMINAL_ID=parent-terminal MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" \
    "$root/.build/megabrain" orchestrate reply orphaned-reply --text 'resume orphan' --json)"
  assert_equal "$(printf '%s' "$output" | jq -r '.status')" queued
  assert_equal "$(jq -r '.state' "$MEGABRAIN_STATE_DIR/dispatches/orphaned-reply/meta.json")" running
  assert_equal "$(jq -r '.type' "$MEGABRAIN_STATE_DIR/dispatches/orphaned-reply/messages"/*.json)" reply

  write_dispatch forbidden-reply failed
  if failure_output="$(SUPERSET_TERMINAL_ID=parent-terminal MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" \
    "$root/.build/megabrain" orchestrate reply forbidden-reply --text 'must fail' 2>&1)"; then
    fail 'a forbidden reply transition succeeded'
  fi
  assert_contains "$failure_output" 'state failed'
  printf 'orphaned reply follows the table and failed reply is rejected\n'
}

scenario_retired_timeout_is_readable() {
  local output
  write_dispatch timeout-prunable timeout
  output="$(MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" "$root/.build/megabrain" orchestrate prune --json)"
  assert_equal "$(printf '%s' "$output" | jq -r '.archived')" 0
  assert_contains "$output" 'timeout-prunable'
  assert_equal "$(jq -r '.state' "$MEGABRAIN_STATE_DIR/dispatches/timeout-prunable/meta.json")" running
  printf 'retired timeout is normalised and remains open\n'
}

# scenario_mark_running_uses_transition_table (originally: a direct call to the retired
# megabrain_spawn_mark_running_if_spawning) is rewritten below: the safety property it tested
# (an orphaned dispatch returns to "running" once its terminal is proven alive) now lives in
# reconcileDecision's terminal-proven branch (src/core/orchestrate-reconcile.ts:54: `state ===
# "spawning" || state === "orphaned"` both map to `state: "running"`), reached through
# `orchestrate reconcile`, not through a standalone mark-running verb. tests/unit/
# orchestrate-stop-reconcile.test.ts covers the "proven"+"alive" -> terminal-proven branch, but
# not with an "orphaned" starting state specifically (its fixture defaults to "running"), so this
# is driven here as a black-box case to prove the exact transition rather than dropped on a
# partial citation.
scenario_orphaned_dispatch_recovers_on_reconcile() {
  local bin_dir="$state_root/reconcile-bin" output
  mkdir -p "$bin_dir"
  # childHost=superset (single "terminals list" call) proves the child terminal directly;
  # parentHost=orca (single "terminal list" call, matched by "handle") proves the parent is
  # alive. Mixing hosts keeps each fake a one-shot command instead of chasing superset's
  # two-step workspaces-then-terminals parent lookup (src/cli/commands/orchestrate-terminal.ts's
  # parentRecords, non-orca branch).
  cat >"$bin_dir/superset" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = terminals ] && [ "${2:-}" = list ]; then
  printf '%s\n' '{"sessions":[{"terminalId":"child-orphan-terminal"}]}'
  exit 0
fi
exit 1
EOF
  chmod +x "$bin_dir/superset"
  cat >"$bin_dir/orca" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = terminal ] && [ "${2:-}" = list ]; then
  printf '%s\n' '{"result":{"terminals":[{"handle":"parent-terminal"}]}}'
  exit 0
fi
exit 1
EOF
  chmod +x "$bin_dir/orca"
  write_dispatch_meta "$MEGABRAIN_STATE_DIR" orphaned-running \
    childHost=superset workspaceId=workspace-test terminalId=child-orphan-terminal \
    parentHost=orca parentSessionId=parent-terminal state=orphaned >/dev/null
  # hasChildIdentityProof (queue-write.ts) treats a "received" child message as proof of a live
  # terminal without needing a real process tree, matching how terminalStatus's own "proven"
  # path is reached in the other reconcile scenarios in this lane.
  append_dispatch_message "$MEGABRAIN_STATE_DIR" orphaned-running child received 'prompt received' child-orphan-terminal >/dev/null
  output="$(PATH="$bin_dir:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" \
    "$root/.build/megabrain" orchestrate reconcile orphaned-running --json)"
  assert_equal "$(printf '%s' "$output" | jq -r '.state')" running
  assert_equal "$(printf '%s' "$output" | jq -r '.stage')" terminal-proven
  assert_equal "$(printf '%s' "$output" | jq -r '.reason')" identity-proven
  printf 'orphaned dispatch returns to running once reconcile proves its terminal\n'
}

# scenario_missing_meta_is_reported (originally: a direct call to the retired
# megabrain_dispatch_health_counts) is dropped per rule 3: `megabrain doctor` forwards
# unconditionally to the compiled binary (lib/module-install.sh:16-25) and
# install-doctor.ts has no "untracked dispatch directory" concept at all (grep for
# "untrack"/"orphan"/"inventory" near dispatch handling in src/cli/commands/install-doctor.ts:
# zero hits) — this was shell-only doctor detail with no production caller left to reach it.

# scenario_launch_failure_rolls_back_owned_objects (originally: megabrain_worktree_create
# --orchestrate, a real shell function with zero production callers now that `megabrain worktree
# create` forwards unconditionally to the binary — lib/module-worktree.sh:410-418) is dropped as
# a shell-only entry point per rule 3. The equivalent modern surface is `megabrain orchestrate
# spawn`, which internally calls executeWorktreeCreate and does clean up the worktree it created
# and the terminal it opened on a launch failure (src/cli/commands/orchestrate-spawn.ts:425-450,
# `cleanup()`). FLAG FOR THE LEAD (inferred from reading cleanup(), not from an executed failing
# test): that function only closes the terminal and, if worktree.ownership === "created", removes
# the git worktree — it never calls a Superset "workspaces delete" or "projects delete" the way
# the old shell contract did (the assertions this test used to make: `assert_missing
# ".../workspace.json"` and `assert_missing ".../project.json"` after a rolled-back launch).
# tests/unit/spawn.test.ts's cleanup coverage (grep for "workspaces.*delete"/"projects.*delete":
# zero hits) does not exercise this either. This may be an intentional scope reduction (the same
# pattern as the install-doctor simplifications already documented in
# tests/test-real-use-defects.sh), but it may also be an unported piece of the old rollback
# contract — recommend the lead check whether a launch failure through `orchestrate spawn` today
# leaves an orphaned Superset workspace/project behind.

case "${SCENARIO:-all}" in
  1) scenario_reply_uses_transition_table ;;
  2) scenario_retired_timeout_is_readable ;;
  3) scenario_orphaned_dispatch_recovers_on_reconcile ;;
  all)
    scenario_reply_uses_transition_table
    scenario_retired_timeout_is_readable
    scenario_orphaned_dispatch_recovers_on_reconcile
    printf 'ok: state guards and reconcile recovery\n'
    ;;
  *)
    fail "unknown scenario: $SCENARIO"
    ;;
esac
