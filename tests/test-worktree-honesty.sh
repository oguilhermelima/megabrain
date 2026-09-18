#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-honesty.XXXXXX")"

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
    *) fail "expected output to contain '$2'" ;;
  esac
}

assert_json() {
  printf '%s' "$1" | jq -e "$2" >/dev/null || fail "JSON assertion failed: $2"
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

export MEGABRAIN_STATE_DIR="$work_dir/state"
source "$root/lib/common.sh"
source "$root/lib/module-worktree.sh"

megabrain_superset_available() { return 0; }
megabrain_context_detect() { printf 'superset\n'; }
megabrain_workspace_id_for_target() { printf 'workspace-test\n'; }
megabrain_worktree_root() { printf '%s\n' "$fixture_shared_root"; }

host_records='{"sessions":[]}'
host_calls=0
megabrain_superset() {
  if [ "${1:-}" = terminals ] && [ "${2:-}" = list ]; then
    host_calls=$((host_calls + 1))
    printf '%s\n' "$host_records"
    return 0
  fi
  if [ "${1:-}" = terminals ] && [ "${2:-}" = create ]; then
    host_calls=$((host_calls + 1))
    printf '%s\n' '{"terminalId":"created-terminal","pid":777}'
    return 0
  fi
  return 1
}

setup_git_fixture() {
  local name="$1"
  rm -rf "$work_dir/repo" "$work_dir/shared" "$MEGABRAIN_STATE_DIR"
  mkdir -p "$work_dir/shared" "$MEGABRAIN_STATE_DIR"
  fixture_shared_root="$work_dir/shared"
  git init -q "$work_dir/repo"
  git -C "$work_dir/repo" config user.email tester@example.com
  git -C "$work_dir/repo" config user.name tester
  printf 'base\n' >"$work_dir/repo/base.txt"
  git -C "$work_dir/repo" add base.txt
  git -C "$work_dir/repo" commit -qm base
  fixture_branch="fix/$name"
}

scenario_subdirectory_selector_is_refused() {
  local output="" subdir=""
  setup_git_fixture subpath
  mkdir -p "$work_dir/repo/apps/web"
  subdir="$work_dir/repo/apps/web"
  host_calls=0
  if output="$(MEGABRAIN_ROOT="$root" command_terminal create --worktree "$subdir" --command 'run server' 2>&1)"; then
    fail 'terminal create accepted a subdirectory selector'
  fi
  assert_contains "$output" 'worktree root'
  assert_contains "$output" 'cd'
  assert_equal "$host_calls" 0

  if output="$(MEGABRAIN_ROOT="$root" command_terminal restart "worktree:$subdir" 2>&1)"; then
    fail 'terminal restart accepted a subdirectory selector'
  fi
  assert_contains "$output" 'worktree root'
  assert_equal "$host_calls" 0
  printf 'terminal worktree selectors refuse subdirectories with an actionable hint\n'
}

scenario_env_files_are_copied_without_contents() {
  local output="" destination="" root_mode="" local_mode="" symlink_target=""
  setup_git_fixture env-copy
  mkdir -p "$work_dir/repo/apps/web" "$work_dir/repo/apps/mobile"
  printf 'root-secret-for-test\n' >"$work_dir/repo/.env"
  chmod 600 "$work_dir/repo/.env"
  printf 'local-secret-for-test\n' >"$work_dir/repo/apps/web/.env.local"
  chmod 640 "$work_dir/repo/apps/web/.env.local"
  printf 'example\n' >"$work_dir/repo/.env.example"
  ln -s ../../.env "$work_dir/repo/apps/mobile/.env"
  git -C "$work_dir/repo" add .env.example
  git -C "$work_dir/repo" commit -qm 'add env example'

  megabrain_workspace_id_for_target() { :; }
  megabrain_ensure_superset_project() { printf '%s\n' '{"id":"project-id","created":false}'; }
  megabrain_workspace_create() { printf '%s\n' '{"id":"workspace-id","created":true}'; }
  output="$(megabrain_worktree_create --repo "$work_dir/repo" --branch "$fixture_branch" --json)"
  destination="$fixture_shared_root/fix-env-copy"
  assert_json "$output" '.worktree == "'"$destination"'"'
  [ -f "$destination/.env" ] || fail 'root .env was not copied'
  [ -f "$destination/apps/web/.env.local" ] || fail 'nested .env.local was not copied'
  cmp -s "$work_dir/repo/.env" "$destination/.env" || fail 'root .env bytes changed'
  cmp -s "$work_dir/repo/apps/web/.env.local" "$destination/apps/web/.env.local" || fail 'nested .env.local bytes changed'
  root_mode="$(file_mode "$destination/.env")"
  local_mode="$(file_mode "$destination/apps/web/.env.local")"
  assert_equal "$root_mode" 600
  assert_equal "$local_mode" 640
  [ -L "$destination/apps/mobile/.env" ] || fail 'env symlink was not preserved'
  symlink_target="$(readlink "$destination/apps/mobile/.env")"
  assert_equal "$symlink_target" '../../.env'
  case "$output" in
    *root-secret-for-test*|*local-secret-for-test*) fail 'env contents appeared in create output' ;;
  esac
  printf 'private env files are copied with paths, modes and links intact\n'
}

scenario_no_env_file_is_normal() {
  local output="" destination=""
  setup_git_fixture no-env
  megabrain_workspace_id_for_target() { :; }
  megabrain_ensure_superset_project() { printf '%s\n' '{"id":"project-id","created":false}'; }
  megabrain_workspace_create() { printf '%s\n' '{"id":"workspace-id","created":true}'; }
  output="$(megabrain_worktree_create --repo "$work_dir/repo" --branch "$fixture_branch" --json)"
  destination="$fixture_shared_root/fix-no-env"
  assert_json "$output" '.worktree == "'"$destination"'"'
  [ ! -e "$destination/.env" ] || fail 'an absent source env file was invented'
  printf 'a repository without env files still creates its worktree\n'
}

scenario_subdirectory_selector_is_refused
scenario_env_files_are_copied_without_contents
scenario_no_env_file_is_normal
printf 'ok: worktree honesty scenarios\n'
