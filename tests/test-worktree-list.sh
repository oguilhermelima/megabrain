#!/usr/bin/env bash

set -euo pipefail

# Scenarios written before the implementation:
# 1. The JSON document reports every Git worktree under the shared root, skips a plain
#    directory, preserves detached, and marks an unregistered worktree.
# 2. The --repo filter selects by repository identity, not by a shared path prefix.
# 3. Listing 12 worktrees from one repository does not fork materially more git
#    processes than listing 3 worktrees from that repository.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-list.XXXXXX")"
wrapper_dir="$state_root/bin"
git_log="$state_root/git.log"
real_git="$(command -v git)"

source "$root/lib/common.sh"
source "$root/lib/module-worktree.sh"

cleanup() {
  local rc=$?
  rm -rf "$state_root"
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

setup_common() {
  rm -rf "$state_root/repo-one" "$state_root/repo-two" "$state_root/shared" \
    "$state_root/single-repo" "$state_root/single-shared" "$git_log"
  mkdir -p "$wrapper_dir" "$state_root/shared" "$state_root/single-shared"
  export HOME="$state_root/home"
  export MEGABRAIN_STATE_DIR="$state_root/state"
  mkdir -p "$HOME" "$MEGABRAIN_STATE_DIR"
  fixture_shared_root="$(cd "$state_root/shared" && pwd -P)"
  superset_workspaces='[]'
  superset_available=false
  orca_available=false
}

setup_repo() {
  local repo_path="$1"
  git init -q "$repo_path"
  git -C "$repo_path" config user.email tester@example.com
  git -C "$repo_path" config user.name tester
  git -C "$repo_path" branch -M main
  printf 'base\n' >"$repo_path/base.txt"
  git -C "$repo_path" add base.txt
  git -C "$repo_path" commit -qm base
}

megabrain_worktree_root() {
  printf '%s\n' "$fixture_shared_root"
}

megabrain_repo_from_orca() {
  printf '%s\n' "$fixture_shared_root/one-main"
}

megabrain_context_detect() {
  printf 'unknown\n'
}

megabrain_require_command() {
  case "$1" in
    gh) [ "${gh_available:-false}" = true ] ;;
    orca) [ "${orca_available:-false}" = true ] ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}

megabrain_superset_available() {
  [ "$superset_available" = true ]
}

megabrain_superset_workspaces_json() {
  printf '%s\n' "$superset_workspaces"
}

write_git_wrapper() {
  cat >"$wrapper_dir/git" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MEGABRAIN_TEST_GIT_LOG"
exec "$MEGABRAIN_TEST_GIT_REAL" "$@"
EOF
  chmod +x "$wrapper_dir/git"
  export MEGABRAIN_TEST_GIT_LOG="$git_log"
  export MEGABRAIN_TEST_GIT_REAL="$real_git"
  : >"$git_log"
  PATH="$wrapper_dir:$PATH"
  export PATH
}

setup_listing_fixture() {
  local repo_one repo_two
  setup_common
  repo_one="$state_root/repo-one"
  repo_two="$state_root/repo-two"
  setup_repo "$repo_one"
  setup_repo "$repo_two"
  git -C "$repo_one" worktree add -q "$fixture_shared_root/one-main" -b feature/one
  git -C "$repo_one" worktree add -q "$fixture_shared_root/one-detached" -b feature/detached
  git -C "$fixture_shared_root/one-detached" checkout -q --detach HEAD
  git -C "$repo_two" worktree add -q "$fixture_shared_root/two-main" -b feature/two
  mkdir "$fixture_shared_root/plain-directory"
  superset_workspaces="{\"workspaces\":[{\"worktreePath\":\"$fixture_shared_root/one-main\"}]}"
  superset_available=true
}

setup_count_fixture() {
  local count="$1" index
  setup_common
  fixture_shared_root="$(cd "$state_root/single-shared" && pwd -P)"
  setup_repo "$state_root/single-repo"
  index=1
  while [ "$index" -le "$count" ]; do
    git -C "$state_root/single-repo" worktree add -q \
      "$fixture_shared_root/worktree-$index" -b "feature/worktree-$index"
    index=$((index + 1))
  done
}

scenario_listing_json_and_repo_filter() {
  local output expected filtered filtered_expected
  setup_listing_fixture
  output="$(megabrain_worktree_list --json)"
  expected="$(jq -n \
    --arg detached "$fixture_shared_root/one-detached" \
    --arg one "$fixture_shared_root/one-main" \
    --arg two "$fixture_shared_root/two-main" \
    '[
      {path: $detached, branch: "detached", parent: null, inSuperset: false, pullRequest: null},
      {path: $one, branch: "feature/one", parent: null, inSuperset: true, pullRequest: null},
      {path: $two, branch: "feature/two", parent: null, inSuperset: false, pullRequest: null}
    ]')"
  assert_equal "$output" "$expected"
  assert_contains "$output" "$fixture_shared_root/one-detached"
  assert_contains "$output" "$fixture_shared_root/two-main"
  case "$output" in
    *plain-directory*) fail 'a plain directory was reported as a worktree' ;;
  esac

  filtered="$(megabrain_worktree_list --repo "$fixture_shared_root/one-main" --json)"
  filtered_expected="$(jq -n \
    --arg detached "$fixture_shared_root/one-detached" \
    --arg one "$fixture_shared_root/one-main" \
    '[
      {path: $detached, branch: "detached", parent: null, inSuperset: false, pullRequest: null},
      {path: $one, branch: "feature/one", parent: null, inSuperset: true, pullRequest: null}
    ]')"
  assert_equal "$filtered" "$filtered_expected"
  case "$filtered" in
    *two-main*) fail 'the repository filter selected another repository' ;;
  esac
  printf 'worktree list JSON preserves detached, unregistered, skipped, and repo-filtered entries\n'
}

count_listing_git_calls() {
  local count="$1"
  setup_count_fixture "$count"
  : >"$git_log"
  megabrain_worktree_parent_branch() { return 1; }
  megabrain_worktree_list --json >/dev/null
  awk 'END { print NR + 0 }' "$git_log"
}

scenario_git_fork_count_is_bounded() {
  local three_count twelve_count growth
  write_git_wrapper
  three_count="$(count_listing_git_calls 3)"
  twelve_count="$(count_listing_git_calls 12)"
  growth=$((twelve_count - three_count))
  [ "$growth" -le 2 ] || fail "git fork count grew by $growth (3=$three_count, 12=$twelve_count)"
  [ "$three_count" -gt 0 ] || fail 'the listing did not invoke git'
  printf 'git fork count stays bounded: 3=%s, 12=%s, growth=%s\n' \
    "$three_count" "$twelve_count" "$growth"
}

scenario_listing_json_and_repo_filter
scenario_git_fork_count_is_bounded
printf 'ok: worktree listing output and bounded git process scenarios\n'
