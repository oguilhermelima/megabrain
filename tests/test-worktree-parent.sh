#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-parent.XXXXXX")"

cleanup() {
  rm -rf "$work_dir"
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

export HOME="$work_dir/home"
export MEGABRAIN_STATE_DIR="$work_dir/state"
source "$root/lib/common.sh"
source "$root/lib/module-worktree.sh"

megabrain_superset_available() { return 0; }
megabrain_worktree_root() { printf '%s\n' "$fixture_shared_root"; }
megabrain_context_detect() { printf 'superset\n'; }
megabrain_project_name_for_path() { printf 'test-project\n'; }
megabrain_require_command() {
  case "$1" in
    orca) return 0 ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}

setup_fixture() {
  local branch="${1:-stack/base}"
  orca_mode=success
  tag_mode=success
  rm -rf "$work_dir/repo" "$work_dir/shared" "$work_dir/state" "$work_dir/calls.log"
  mkdir -p "$work_dir/shared" "$work_dir/state"
  repo_dir="$work_dir/repo"
  fixture_shared_root="$work_dir/shared"
  git init -q "$repo_dir"
  git -C "$repo_dir" config user.email tester@example.com
  git -C "$repo_dir" config user.name tester
  printf 'base\n' >"$repo_dir/base.txt"
  git -C "$repo_dir" add base.txt
  git -C "$repo_dir" commit -qm base
  git -C "$repo_dir" worktree add -q "$fixture_shared_root/parent" -b "$branch"
}

orca() {
  printf 'orca %s\n' "$*" >>"$work_dir/calls.log"
  if [ "${orca_mode:-success}" = fail ]; then
    printf '%s\n' '{"ok":false,"error":"lineage unavailable"}'
    return 1
  fi
  printf '%s\n' '{"ok":true,"result":{"worktree":{"parentWorktreeId":"parent-id"}}}'
}

megabrain_superset() {
  local kind="${1:-}" action="${2:-}" tag_present=false arg
  printf 'superset %s\n' "$*" >>"$work_dir/calls.log"
  for arg in "$@"; do
    [ "$arg" = --tag ] && tag_present=true
  done
  case "$kind:$action" in
    settings:get)
      printf '%s\n' "$fixture_shared_root"
      ;;
    projects:list)
      printf '%s\n' '{"projects":[]}'
      ;;
    projects:create)
      printf '%s\n' '{"result":{"project":{"id":"project-id"}}}'
      ;;
    workspaces:list)
      printf '%s\n' '{"workspaces":[]}'
      ;;
    workspaces:create)
      if [ "$tag_present" = true ] && [ "${tag_mode:-success}" = fail ]; then
        return 1
      fi
      printf '%s\n' '{"result":{"workspace":{"id":"workspace-id"}}}'
      ;;
    workspaces:update)
      [ "${tag_mode:-success}" != fail ] || return 1
      printf '%s\n' '{"ok":true}'
      ;;
    *) return 1 ;;
  esac
}

scenario_without_parent_does_not_decorate() {
  local output
  setup_fixture
  orca_mode=success
  tag_mode=success
  output="$(megabrain_worktree_create --repo "$repo_dir" --branch stack/child --json)"
  assert_equal "$(printf '%s' "$output" | jq -r '.parent.requested')" false
  assert_not_contains "$(cat "$work_dir/calls.log")" 'orca worktree set'
  assert_not_contains "$(cat "$work_dir/calls.log")" '--tag'
  printf 'without parent, no lineage or grouping call is made\n'
}

scenario_parent_sets_both_sides() {
  local output calls parent_path child_path
  setup_fixture 'stack/base/branch'
  orca_mode=success
  tag_mode=success
  parent_path="$fixture_shared_root/parent"
  child_path="$fixture_shared_root/stack-child"
  output="$(megabrain_worktree_create --repo "$repo_dir" --branch stack/child --parent "path:$parent_path" --json)"
  calls="$(cat "$work_dir/calls.log")"
  assert_equal "$(printf '%s' "$output" | jq -r '.parent.requested')" true
  assert_equal "$(printf '%s' "$output" | jq -r '.parent.lineage.set')" true
  assert_equal "$(printf '%s' "$output" | jq -r '.parent.grouping.set')" true
  assert_contains "$calls" "orca worktree set --worktree path:$child_path --parent-worktree path:$parent_path --json"
  assert_contains "$calls" 'superset workspaces'
  assert_contains "$calls" '--tag stack-base-branch'
  printf 'parent sets Orca lineage and a canonical Superset tag\n'
}

scenario_unresolvable_parent_is_preflight_error() {
  local output child_path
  setup_fixture
  orca_mode=success
  tag_mode=success
  child_path="$fixture_shared_root/stack-child"
  if output="$(megabrain_worktree_create --repo "$repo_dir" --branch stack/child --parent branch:missing --json 2>&1)"; then
    fail 'unresolvable parent unexpectedly succeeded'
  fi
  assert_contains "$output" 'parent worktree could not be resolved: branch:missing'
  [ ! -e "$child_path" ] || fail 'child worktree was created before parent validation'
  git -C "$repo_dir" branch --list stack/child | grep -q stack/child && fail 'child branch was created before parent validation'
  printf 'unresolvable parent fails before Git or Superset changes\n'
}

scenario_lineage_failure_is_reported_but_non_fatal() {
  local output
  setup_fixture
  orca_mode=fail
  tag_mode=success
  output="$(megabrain_worktree_create --repo "$repo_dir" --branch stack/child --parent branch:stack/base --json)"
  assert_equal "$(printf '%s' "$output" | jq -r '.parent.lineage.set')" false
  assert_equal "$(printf '%s' "$output" | jq -r '.parent.grouping.set')" true
  [ -d "$fixture_shared_root/stack-child" ] || fail 'worktree was not created after Orca decoration failure'
  printf 'Orca failure leaves the worktree and Superset grouping intact\n'
}

scenario_grouping_failure_is_reported_but_non_fatal() {
  local output
  setup_fixture
  orca_mode=success
  tag_mode=fail
  output="$(megabrain_worktree_create --repo "$repo_dir" --branch stack/child --parent branch:stack/base --json)"
  assert_equal "$(printf '%s' "$output" | jq -r '.parent.lineage.set')" true
  assert_equal "$(printf '%s' "$output" | jq -r '.parent.grouping.set')" false
  [ -d "$fixture_shared_root/stack-child" ] || fail 'worktree was not created after Superset decoration failure'
  printf 'Superset grouping failure leaves the worktree and Orca lineage intact\n'
}

scenario_parent_flags_are_mutually_exclusive() {
  local output
  setup_fixture
  orca_mode=success
  tag_mode=success
  if output="$(megabrain_worktree_create --repo "$repo_dir" --branch stack/child --parent branch:stack/base --no-parent --json 2>&1)"; then
    fail '--parent and --no-parent unexpectedly succeeded'
  fi
  assert_contains "$output" '--parent cannot be combined with --no-parent'
  [ ! -e "$fixture_shared_root/stack-child" ] || fail 'worktree was created for an invalid option combination'
  printf 'parent flags reject contradictory input\n'
}

scenario_tag_sanitization_is_pure() {
  assert_equal "$(megabrain_superset_tag_from_branch 'epic/design/parity')" epic-design-parity
  assert_equal "$(megabrain_superset_tag_from_branch 'main')" main
  printf 'Superset tags sanitize branch separators deterministically\n'
}

scenario_without_parent_does_not_decorate
scenario_parent_sets_both_sides
scenario_unresolvable_parent_is_preflight_error
scenario_lineage_failure_is_reported_but_non_fatal
scenario_grouping_failure_is_reported_but_non_fatal
scenario_parent_flags_are_mutually_exclusive
scenario_tag_sanitization_is_pure
printf 'ok: worktree parent lineage and Superset grouping scenarios\n'
