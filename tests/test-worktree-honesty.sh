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

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

run_binary() {
  MEGABRAIN_ROOT="$root" HOME="$work_dir/home" MEGABRAIN_STATE_DIR="$work_dir/state" \
    "$root/.build/megabrain" "$@"
}

setup_git_fixture() {
  local name="$1"
  rm -rf "$work_dir/repo" "$work_dir/shared" "$work_dir/state"
  mkdir -p "$work_dir/shared" "$work_dir/state"
  printf '%s\n' "$work_dir/shared" >"$work_dir/state/worktree-root"
  git init -q "$work_dir/repo"
  git -C "$work_dir/repo" config user.email tester@example.com
  git -C "$work_dir/repo" config user.name tester
  printf 'base\n' >"$work_dir/repo/base.txt"
  git -C "$work_dir/repo" add base.txt
  git -C "$work_dir/repo" commit -qm base
  fixture_branch="fix/$name"
}

# command_terminal (lib/module-worktree.sh) is a full unconditional passthrough for
# create/list/restart/close — no shell fallback remains — so this drives the compiled binary
# directly instead of sourcing lib/ to call it as a shell function.
scenario_subdirectory_selector_is_refused() {
  local output="" subdir=""
  setup_git_fixture subpath
  mkdir -p "$work_dir/repo/apps/web"
  subdir="$work_dir/repo/apps/web"
  if output="$(run_binary terminal create --worktree "$subdir" --command 'run server' 2>&1)"; then
    fail 'terminal create accepted a subdirectory selector'
  fi
  assert_contains "$output" 'worktree root'
  assert_contains "$output" 'cd'

  if output="$(run_binary terminal restart "worktree:$subdir" 2>&1)"; then
    fail 'terminal restart accepted a subdirectory selector'
  fi
  assert_contains "$output" 'worktree root'
  printf 'terminal worktree selectors refuse subdirectories with an actionable hint\n'
}

# megabrain_worktree_create (lib/module-worktree.sh) no longer exists anywhere in lib/*.sh (issue
# 45 phases 6-7 replaced it with executeWorktreeCreate, src/cli/commands/worktree-write.ts,
# reachable only through `worktree create`/`orchestrate spawn`). The env-file copy behaviour is
# real in that file (isEnvFile at worktree-write.ts:589) and has no bun unit-test coverage
# (tests/unit/worktree-write.test.ts has no ".env" scenario at all), so this is a rewrite, not a
# drop: it drives the compiled binary's own `worktree create` — agent-less, so no host/tmux fakes
# are needed.
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

  output="$(run_binary worktree create --repo "$work_dir/repo" --branch "$fixture_branch" --json)"
  destination="$(printf '%s' "$output" | jq -r '.worktree')"
  assert_equal "$(cd "$destination" && pwd -P)" "$(cd "$work_dir/shared/fix-env-copy" && pwd -P)"
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
  output="$(run_binary worktree create --repo "$work_dir/repo" --branch "$fixture_branch" --json)"
  destination="$(printf '%s' "$output" | jq -r '.worktree')"
  assert_equal "$(cd "$destination" && pwd -P)" "$(cd "$work_dir/shared/fix-no-env" && pwd -P)"
  [ ! -e "$destination/.env" ] || fail 'an absent source env file was invented'
  printf 'a repository without env files still creates its worktree\n'
}

scenario_subdirectory_selector_is_refused
scenario_env_files_are_copied_without_contents
scenario_no_env_file_is_normal
printf 'ok: worktree honesty scenarios\n'
