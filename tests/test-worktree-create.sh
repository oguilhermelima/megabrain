#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-create.XXXXXX")"

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

fixture_host=orca
superset_available=false
superset_calls_file="$work_dir/superset-calls"

megabrain_context_detect() {
  printf '%s\n' "$fixture_host"
}

megabrain_worktree_root() {
  printf '%s\n' "$work_dir/shared"
}

megabrain_repo_from_orca() {
  printf '%s\n' "$work_dir/repo"
}

megabrain_superset_available() {
  [ "$superset_available" = true ]
}

megabrain_project_name_for_path() {
  printf 'test-project\n'
}

megabrain_superset() {
  printf '%s\n' "$*" >>"$superset_calls_file"
  case "${1:-}:${2:-}" in
    projects:list)
      printf '%s\n' '{"projects":[]}'
      ;;
    projects:create)
      if [ "${superset_project_mode:-success}" = fail ]; then
        printf '%s\n' '{"error":{"message":"project registration denied"}}'
        return 1
      fi
      printf '%s\n' '{"result":{"project":{"id":"project-id"}}}'
      ;;
    workspaces:list)
      printf '%s\n' '{"workspaces":[]}'
      ;;
    workspaces:create)
      printf '%s\n' '{"result":{"workspace":{"id":"workspace-id"}}}'
      ;;
    *)
      return 1
      ;;
  esac
}

reset_fixture() {
  rm -rf "$work_dir/repo" "$work_dir/shared" "$work_dir/state" "$superset_calls_file"
  mkdir -p "$work_dir/shared" "$work_dir/state"
  git init -q "$work_dir/repo"
  git -C "$work_dir/repo" config user.email tester@example.com
  git -C "$work_dir/repo" config user.name tester
  git -C "$work_dir/repo" config init.defaultBranch main
  printf 'base\n' >"$work_dir/repo/base.txt"
  git -C "$work_dir/repo" add base.txt
  git -C "$work_dir/repo" commit -qm base
  fixture_host=orca
  superset_available=false
  superset_project_mode=success
  : >"$superset_calls_file"
}

scenario_orca_without_superset_creates_git_worktree() {
  local output
  reset_fixture
  output="$(megabrain_worktree_create --repo megabrain --branch fix/orca --json)"
  assert_equal "$(printf '%s' "$output" | jq -r '.worktree')" "$work_dir/shared/fix-orca"
  assert_equal "$(printf '%s' "$output" | jq -r '.workspace')" null
  assert_equal "$(wc -l <"$superset_calls_file" | tr -d ' ')" 0
  [ -d "$work_dir/shared/fix-orca" ] || fail 'Orca worktree was not created'
  printf 'Orca creates a worktree without Superset\n'
}

scenario_superset_registers_project_and_workspace() {
  local output calls
  reset_fixture
  fixture_host=superset
  superset_available=true
  output="$(megabrain_worktree_create --repo megabrain --branch fix/superset --json)"
  calls="$(cat "$superset_calls_file")"
  assert_equal "$(printf '%s' "$output" | jq -r '.workspace')" workspace-id
  assert_contains "$calls" 'projects list --json'
  assert_contains "$calls" 'projects create --local --import '
  assert_contains "$calls" 'workspaces list --local --json'
  assert_contains "$calls" 'workspaces create --local --project project-id --branch fix/superset --name fix-superset --json'
  printf 'Superset creates the project and workspace\n'
}

scenario_superset_registration_failure_keeps_git_work() {
  local output
  reset_fixture
  fixture_host=superset
  superset_available=true
  superset_project_mode=fail
  if output="$(megabrain_worktree_create --repo megabrain --branch fix/failure --json 2>&1)"; then
    fail 'Superset registration failure unexpectedly succeeded'
  fi
  assert_contains "$output" "could not register Superset project on host 'superset'"
  assert_contains "$output" 'kept Git worktree'
  assert_not_contains "$output" 'rolled back:'
  [ -d "$work_dir/shared/fix-failure" ] || fail 'failed worktree was removed'
  git -C "$work_dir/repo" branch --list fix/failure | grep -q fix/failure || fail 'failed branch was removed'
  printf 'Superset registration failure keeps Git changes\n'
}

scenario_registration_failure_names_current_host() {
  local output
  reset_fixture
  fixture_host=superset
  superset_available=true
  superset_project_mode=fail
  if output="$(megabrain_worktree_create --repo megabrain --branch fix/host-error --json 2>&1)"; then
    fail 'registration failure unexpectedly succeeded'
  fi
  assert_contains "$output" "host 'superset'"
  printf 'registration failure names the current host\n'
}

case "${1:-all}" in
  orca) scenario_orca_without_superset_creates_git_worktree ;;
  superset) scenario_superset_registers_project_and_workspace ;;
  rollback) scenario_superset_registration_failure_keeps_git_work ;;
  host-error) scenario_registration_failure_names_current_host ;;
  all)
    scenario_orca_without_superset_creates_git_worktree
    scenario_superset_registers_project_and_workspace
    scenario_superset_registration_failure_keeps_git_work
    scenario_registration_failure_names_current_host
    printf 'ok: worktree creation is host-aware\n'
    ;;
  *) fail "unknown scenario: $1" ;;
esac
