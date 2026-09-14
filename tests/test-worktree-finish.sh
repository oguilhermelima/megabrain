#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-finish.XXXXXX")"
state_dir="$work_dir/state"

cleanup() {
  rm -rf "$work_dir"
  return 0
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
source "$root/lib/common.sh"
source "$root/lib/module-worktree.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected output to contain '$2', got: $1" ;;
  esac
}

# The removal is stubbed to fail the way a real orchestrator does: a non-zero exit
# with its own message on stdout as JSON. That is the shape that used to be swallowed,
# because --json sends that stdout to /dev/null.
megabrain_require_command() {
  case "$1" in
    orca) [ "${finish_uses_orca:-true}" = true ] ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}
megabrain_superset_available() { return 1; }
megabrain_context_detect() { printf 'unknown\n'; }
finish_remover_mode=error
orca() {
  if [ "$finish_remover_mode" = deletes-branch ]; then
    local command="" path="" branch="" arg=""
    command="$1 $2"
    [ "$command" = 'worktree rm' ] || return 1
    shift 2
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --worktree) path="$(printf '%s' "$2" | sed 's/^path://')"; shift 2 ;;
        --json|--force) shift ;;
        *) shift ;;
      esac
    done
    branch="$(command git -C "$path" symbolic-ref --quiet --short HEAD)"
    command git -C "$path" worktree remove "$path"
    command git -C "$work_dir/repo" branch -D "$branch"
    printf '%s\n' '{"deleted":["external-id"],"warnings":[]}'
    return 0
  fi
  printf '{"ok":false,"error":"worktree has uncommitted changes"}\n'
  return 1
}

# The resolver only knows worktrees under the shared root, so the fixture has to live
# there for the test to reach the removal at all. An earlier version of this file did not,
# and passed on an unrelated "worktree not found" without ever exercising the refusal.
megabrain_worktree_root() { printf '%s\n' "${fixture_shared_root:-$work_dir}"; }

megabrain_ensure_superset_project() {
  jq -n '{id: "project-id", created: false}'
}

megabrain_workspace_id_for_target() {
  return 0
}

megabrain_workspace_create() {
  jq -n '{id: "workspace-id", created: true, tagSet: true}'
}

setup_stack_fixture() {
  rm -rf "$work_dir/repo" "$work_dir/shared" "$work_dir/state"
  mkdir -p "$work_dir/shared" "$work_dir/state"
  fixture_shared_root="$work_dir/shared"
  git init -q "$work_dir/repo"
  git -C "$work_dir/repo" config user.email tester@example.com
  git -C "$work_dir/repo" config user.name tester
  printf 'base\n' >"$work_dir/repo/base.txt"
  git -C "$work_dir/repo" add base.txt
  git -C "$work_dir/repo" commit -qm base
  git -C "$work_dir/repo" branch stack/base
  git -C "$work_dir/repo" worktree add -q "$work_dir/shared/parent" stack/base
  printf 'parent\n' >"$work_dir/shared/parent/parent.txt"
  git -C "$work_dir/shared/parent" add parent.txt
  git -C "$work_dir/shared/parent" commit -qm parent
  finish_uses_orca=true
  megabrain_worktree_create --repo "$work_dir/repo" --branch stack/child \
    --base stack/base --parent "path:$work_dir/shared/parent" --name child --json >/dev/null
  finish_uses_orca=false
}

setup_root_fixture() {
  rm -rf "$work_dir/repo" "$work_dir/shared" "$work_dir/state"
  mkdir -p "$work_dir/shared" "$work_dir/state"
  fixture_shared_root="$work_dir/shared"
  git init -q "$work_dir/repo"
  git -C "$work_dir/repo" config user.email tester@example.com
  git -C "$work_dir/repo" config user.name tester
  printf 'base\n' >"$work_dir/repo/base.txt"
  git -C "$work_dir/repo" add base.txt
  git -C "$work_dir/repo" commit -qm base
  git -C "$work_dir/repo" worktree add -q "$work_dir/shared/root" -b stack/root main
  finish_uses_orca=false
}

scenario_stacked_branch_uses_recorded_parent() {
  local output
  setup_stack_fixture
  printf 'child\n' >"$work_dir/shared/child/child.txt"
  git -C "$work_dir/shared/child" add child.txt
  git -C "$work_dir/shared/child" commit -qm child
  git -C "$work_dir/shared/parent" merge -q --no-ff stack/child -m 'merge child'
  output="$(megabrain_worktree_finish "$work_dir/shared/child" --delete-branch --json 2>&1)" ||
    fail "a child merged into its recorded parent was refused: $output"
  assert_contains "$output" '"base":"stack/base"'
  printf '%s' "$output" | jq -e '.branchDeleted == true' >/dev/null ||
    fail "a surviving branch was not reported as deleted: $output"
  [ ! -e "$work_dir/shared/child" ] || fail 'the merged child worktree was not removed'
  ! git -C "$work_dir/repo" branch --list stack/child | grep -q stack/child ||
    fail 'the merged child branch was not deleted'
  printf 'a stacked branch is judged against its recorded parent\n'
}

scenario_unmerged_branch_is_still_refused() {
  local output finish_rc finish_err
  setup_stack_fixture
  printf 'child\n' >"$work_dir/shared/child/child.txt"
  git -C "$work_dir/shared/child" add child.txt
  git -C "$work_dir/shared/child" commit -qm child
  set +e
  output="$(megabrain_worktree_finish "$work_dir/shared/child" --delete-branch --json 2>"$work_dir/unmerged.err")"
  finish_rc=$?
  set -e
  [ "$finish_rc" -ne 0 ] || fail 'a branch merged into neither base was deleted'
  printf '%s' "$output" | jq -e '.deleted == false and .refusal.code == "unmerged-branch" and (.refusal.message | contains("stack/child")) and .branch == "stack/child" and .base == "stack/base"' >/dev/null ||
    fail "unmerged refusal did not return a JSON outcome: $output"
  finish_err="$(cat "$work_dir/unmerged.err")"
  assert_contains "$finish_err" 'refusing to delete unmerged branch: stack/child'
  [ -e "$work_dir/shared/child" ] || fail 'the refused branch worktree was removed before the guard'
  git -C "$work_dir/repo" branch --list stack/child | grep -q stack/child ||
    fail 'an unmerged branch was deleted despite the refusal'
  printf 'a branch merged into neither base remains refused\n'
}

scenario_worktree_not_found_returns_json_refusal() {
  local output finish_rc finish_err
  setup_root_fixture
  set +e
  output="$(megabrain_worktree_finish "$work_dir/shared/missing" --json 2>"$work_dir/missing.err")"
  finish_rc=$?
  set -e
  [ "$finish_rc" -ne 0 ] || fail 'a missing worktree was accepted'
  printf '%s' "$output" | jq -e '.deleted == false and .refusal.code == "worktree-not-found" and (.refusal.message | contains("shared/missing")) and .branch == null and .path == null' >/dev/null ||
    fail "missing worktree refusal did not return a JSON outcome: $output"
  finish_err="$(cat "$work_dir/missing.err")"
  assert_contains "$finish_err" 'worktree not found: '
  printf 'a missing worktree returns a JSON refusal\n'
}

scenario_missing_target_returns_json_refusal() {
  local output finish_rc finish_err
  set +e
  output="$(megabrain_worktree_finish --json 2>"$work_dir/missing-target.err")"
  finish_rc=$?
  set -e
  [ "$finish_rc" -eq "$MEGABRAIN_USAGE_ERROR" ] || fail 'a missing target returned the wrong status'
  printf '%s' "$output" | jq -e '.deleted == false and .refusal.code == "invalid-arguments" and (.refusal.message | contains("worktree finish"))' >/dev/null ||
    fail "missing target did not return a JSON refusal: $output"
  finish_err="$(cat "$work_dir/missing-target.err")"
  assert_contains "$finish_err" 'Usage: megabrain worktree finish'
  printf 'a missing target returns a JSON refusal\n'
}

scenario_unknown_option_returns_json_refusal() {
  local output finish_rc finish_err
  set +e
  output="$(megabrain_worktree_finish --json --unexpected 2>"$work_dir/unknown-option.err")"
  finish_rc=$?
  set -e
  [ "$finish_rc" -eq "$MEGABRAIN_USAGE_ERROR" ] || fail 'an unknown option returned the wrong status'
  printf '%s' "$output" | jq -e '.deleted == false and .refusal.code == "invalid-arguments" and (.refusal.message | contains("unknown worktree finish option"))' >/dev/null ||
    fail "unknown option did not return a JSON refusal: $output"
  finish_err="$(cat "$work_dir/unknown-option.err")"
  assert_contains "$finish_err" 'unknown worktree finish option: --unexpected'
  printf 'an unknown option returns a JSON refusal\n'
}

scenario_root_branch_uses_repository_default() {
  local output
  setup_root_fixture
  printf 'root\n' >"$work_dir/shared/root/root.txt"
  git -C "$work_dir/shared/root" add root.txt
  git -C "$work_dir/shared/root" commit -qm root
  git -C "$work_dir/repo" merge -q --no-ff stack/root -m 'merge root'
  output="$(megabrain_worktree_finish "$work_dir/shared/root" --delete-branch --json 2>&1)" ||
    fail "a root branch was not judged against the repository default: $output"
  assert_contains "$output" '"base":"main"'
  printf 'a branch without a parent uses the repository default\n'
}

scenario_missing_parent_falls_back_loudly() {
  local output
  setup_stack_fixture
  printf 'child\n' >"$work_dir/shared/child/child.txt"
  git -C "$work_dir/shared/child" add child.txt
  git -C "$work_dir/shared/child" commit -qm child
  git -C "$work_dir/shared/parent" merge -q --no-ff stack/child -m 'merge child'
  git -C "$work_dir/repo" merge -q --no-ff stack/base -m 'merge parent'
  git -C "$work_dir/repo" worktree remove "$work_dir/shared/parent"
  git -C "$work_dir/repo" branch -d stack/base >/dev/null
  output="$(megabrain_worktree_finish "$work_dir/shared/child" --delete-branch --json 2>&1)" ||
    fail "a child whose parent was merged and removed was refused: $output"
  assert_contains "$output" 'recorded parent branch no longer exists: stack/base'
  assert_contains "$output" '"base":"main"'
  printf 'a missing parent falls back to the repository default with a warning\n'
}

scenario_explicit_base_overrides_recorded_parent() {
  local output
  setup_stack_fixture
  printf 'child\n' >"$work_dir/shared/child/child.txt"
  git -C "$work_dir/shared/child" add child.txt
  git -C "$work_dir/shared/child" commit -qm child
  git -C "$work_dir/shared/parent" merge -q --no-ff stack/child -m 'merge child'
  output="$(megabrain_worktree_finish "$work_dir/shared/child" --base stack/base --delete-branch --json 2>&1)" ||
    fail "an explicit base did not override the recorded parent: $output"
  assert_contains "$output" '"base":"stack/base"'
  printf 'an explicit base overrides recorded lineage\n'
}

scenario_remover_already_deleted_branch_succeeds() {
  local output finish_rc finish_err
  setup_root_fixture
  finish_uses_orca=true
  finish_remover_mode=deletes-branch
  set +e
  output="$(megabrain_worktree_finish "$work_dir/shared/root" --delete-branch --force --json 2>"$work_dir/already-absent.err")"
  finish_rc=$?
  set -e
  finish_err="$(cat "$work_dir/already-absent.err")"
  [ "$finish_rc" -eq 0 ] || fail "remover that deleted the branch was reported as failure: $output"
  printf '%s' "$output" | jq -e '.deleted == true and .branchDeleted == false and .error == null and .branch == "stack/root"' >/dev/null ||
    fail "already absent branch did not return a successful JSON outcome: $output"
  [ -z "$finish_err" ] || fail "already absent branch wrote an error: $finish_err"
  [ ! -e "$work_dir/shared/root" ] || fail 'the host remover did not remove the worktree'
  ! git -C "$work_dir/repo" branch --list stack/root | grep -q stack/root ||
    fail 'the host remover did not remove the branch'
  finish_remover_mode=error
  printf 'a host remover that deletes the branch is already successful\n'
}

branch_delete_mode=false
git() {
  local arg="" saw_branch=false
  if [ "$branch_delete_mode" = true ]; then
    for arg in "$@"; do
      [ "$arg" = branch ] && saw_branch=true
      if [ "$saw_branch" = true ] && [ "$arg" = -D ]; then
        printf 'fatal: simulated branch deletion refusal\n' >&2
        return 1
      fi
    done
  fi
  command git "$@"
}

scenario_branch_delete_failure_returns_json() {
  local output finish_rc finish_err
  setup_root_fixture
  branch_delete_mode=true
  set +e
  output="$(megabrain_worktree_finish "$work_dir/shared/root" --delete-branch --force --json 2>"$work_dir/branch-delete.err")"
  finish_rc=$?
  set -e
  finish_err="$(cat "$work_dir/branch-delete.err")"
  [ "$finish_rc" -ne 0 ] || fail 'a simulated branch deletion failure succeeded'
  printf '%s' "$output" | jq -e '.deleted == true and .branchDeleted == false and .branch == "stack/root" and (.error | contains("simulated branch deletion refusal"))' >/dev/null ||
    fail "partial finish did not return a JSON outcome: $output"
  assert_contains "$finish_err" 'simulated branch deletion refusal'
  [ ! -e "$work_dir/shared/root" ] || fail 'the worktree survived a successful removal'
  git -C "$work_dir/repo" branch --list stack/root | grep -q stack/root ||
    fail 'the branch disappeared despite the simulated deletion failure'
  branch_delete_mode=false
  printf 'branch deletion failure returns a partial JSON outcome\n'
}

if [ -n "${FINISH_SCENARIO:-}" ]; then
  "$FINISH_SCENARIO"
  exit $?
fi

scenario_stacked_branch_uses_recorded_parent
scenario_unmerged_branch_is_still_refused
scenario_worktree_not_found_returns_json_refusal
scenario_missing_target_returns_json_refusal
scenario_unknown_option_returns_json_refusal
scenario_root_branch_uses_repository_default
scenario_missing_parent_falls_back_loudly
scenario_explicit_base_overrides_recorded_parent
scenario_remover_already_deleted_branch_succeeds
scenario_branch_delete_failure_returns_json

(
  rm -rf "$work_dir/repo" "$work_dir/shared" "$work_dir/state"
  mkdir -p "$work_dir/shared" "$work_dir/state"
  fixture_shared_root="$work_dir/shared"
  git init -q "$work_dir/repo"
  git -C "$work_dir/repo" config user.email tester@example.com
  git -C "$work_dir/repo" config user.name tester
  printf 'base\n' >"$work_dir/repo/base.txt"
  git -C "$work_dir/repo" add base.txt
  git -C "$work_dir/repo" commit -qm base
  git -C "$work_dir/repo" worktree add -q "$work_dir/shared/output" -b feat/output
  output_path="$(cd "$work_dir/shared/output" && pwd -P)"
  finish_uses_orca=true
  orca() {
    local command="" path=""
    command="$1 $2"
    [ "$command" = 'worktree rm' ] || return 1
    shift 2
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --worktree) path="$(printf '%s' "$2" | sed 's/^path://')"; shift 2 ;;
        --json|--force) shift ;;
        *) shift ;;
      esac
    done
    git -C "$work_dir/repo" worktree remove "$path"
    printf '%s\n' '{"deleted":["external-id"],"warnings":[]}'
  }
  output="$(megabrain_worktree_finish "$work_dir/shared/output" 2>&1)" ||
    fail "a removable worktree was refused: $output"
  assert_contains "$output" "removed: $output_path"
  case "$output" in
    *'"deleted"'*) fail 'the remover JSON was printed as megabrain output' ;;
  esac
  [ ! -e "$work_dir/shared/output" ] || fail 'the successful finish kept the worktree'
  printf 'successful finish owns its human-readable output\n'
)

rm -rf "$work_dir/repo" "$work_dir/shared" "$work_dir/state"
finish_uses_orca=true
git init -q "$work_dir/repo"
git -C "$work_dir/repo" config user.email tester@example.com
git -C "$work_dir/repo" config user.name tester
printf 'base\n' >"$work_dir/repo/base.txt"
git -C "$work_dir/repo" add base.txt
git -C "$work_dir/repo" commit -qm 'base'
git -C "$work_dir/repo" worktree add -q "$work_dir/wt" -b feat/unfinished
printf 'work that is not committed\n' >"$work_dir/wt/dirty.txt"

# WHY: a refusal that says nothing is indistinguishable from a crash. The removal used to
# fail with an empty stdout and an empty stderr, because --json sent the underlying tool's
# own message to /dev/null and megabrain added none of its own, so the caller was left with
# an exit code and no way to tell an unmerged branch from a broken install.
set +e
finish_out="$(megabrain_worktree_finish "$work_dir/wt" --json 2>"$work_dir/finish.err")"
finish_rc=$?
set -e

[ "$finish_rc" -ne 0 ] || fail 'removing a worktree with uncommitted work succeeded'
finish_err="$(cat "$work_dir/finish.err")"
[ -n "$finish_err" ] || fail "the refusal reported nothing: stdout was '$finish_out'"
assert_contains "$finish_err" 'megabrain:'
case "$finish_err" in
  *'worktree not found'*) fail 'the test never reached the removal; it failed while resolving the target' ;;
esac
assert_contains "$finish_err" 'uncommitted changes'
printf 'a refused removal says why on stderr\n'

# WHY: refusing has to mean the work is still there. This is the only assertion that
# distinguishes a refusal from a partial removal that reported an error afterwards.
[ -f "$work_dir/wt/dirty.txt" ] || fail 'the worktree was removed despite the refusal'
git -C "$work_dir/repo" branch --list feat/unfinished | grep -q feat/unfinished ||
  fail 'the branch was deleted despite the refusal'
printf 'a refused removal leaves the worktree and the branch alone\n'

printf 'ok: worktree finish refuses loudly and destroys nothing\n'
