#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-pr.XXXXXX")"

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

setup_fixture() {
  rm -rf "$work_dir/repo" "$work_dir/shared" "$work_dir/state" "$work_dir/bin" "$work_dir/calls.log"
  mkdir -p "$work_dir/shared" "$work_dir/state" "$work_dir/bin"
  repo_dir="$work_dir/repo"
  fixture_shared_root="$work_dir/shared"
  git init -q "$repo_dir"
  git -C "$repo_dir" config user.email tester@example.com
  git -C "$repo_dir" config user.name tester
  git -C "$repo_dir" config init.defaultBranch main
  printf 'base\n' >"$repo_dir/base.txt"
  git -C "$repo_dir" add base.txt
  git -C "$repo_dir" commit -qm base
}

megabrain_worktree_root() { printf '%s\n' "$fixture_shared_root"; }
megabrain_context_detect() { printf 'superset\n'; }
megabrain_project_name_for_path() { printf 'test-project\n'; }

megabrain_require_command() {
  case "$1" in
    orca) [ "${orca_available:-true}" = true ] ;;
    gh) command -v gh >/dev/null 2>&1 ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}

megabrain_superset_available() { [ "${superset_available:-true}" = true ]; }

orca() {
  printf 'orca %s\n' "$*" >>"$work_dir/calls.log"
  case "${1:-}:${2:-}" in
    worktree:show)
      if [ "${orca_parent_branch:-}" ]; then
        printf '%s\n' "{\"result\":{\"worktree\":{\"parentWorktree\":{\"branch\":\"$orca_parent_branch\"}}}}"
      else
        printf '%s\n' '{"result":{"worktree":{}}}'
      fi
      ;;
    worktree:set)
      [ "${orca_mode:-success}" = success ] || return 1
      printf '%s\n' '{"ok":true}'
      ;;
    *) return 1 ;;
  esac
}

megabrain_superset() {
  printf 'superset %s\n' "$*" >>"$work_dir/calls.log"
  case "${1:-}:${2:-}" in
    settings:get) printf '%s\n' "$fixture_shared_root" ;;
    projects:list) printf '%s\n' '{"projects":[]}' ;;
    projects:create) printf '%s\n' '{"result":{"project":{"id":"project-id"}}}' ;;
    workspaces:list) printf '%s\n' '{"workspaces":[]}' ;;
    workspaces:create) printf '%s\n' '{"result":{"workspace":{"id":"workspace-id"}}}' ;;
    workspaces:update) printf '%s\n' '{"ok":true}' ;;
    *) return 1 ;;
  esac
}

write_gh() {
  cat >"$work_dir/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
case "$1 $2" in
  "auth status")
    [ "${GH_AUTH:-yes}" = yes ]
    ;;
  "pr create")
    printf '%s\n' 'https://github.example/pull/7'
    ;;
  "pr list")
    printf '%s\n' '[{"number":7,"state":"OPEN","url":"https://github.example/pull/7"}]'
    ;;
esac
EOF
  chmod +x "$work_dir/bin/gh"
  export GH_LOG="$work_dir/gh.log"
  GH_AUTH=yes
  export GH_AUTH
  : >"$GH_LOG"
  export PATH="$work_dir/bin:/usr/bin:/bin:/opt/homebrew/bin"
}

make_stacked_worktrees() {
  git -C "$repo_dir" worktree add -q "$fixture_shared_root/parent" -b stack/base
  printf 'parent\n' >"$fixture_shared_root/parent/parent.txt"
  git -C "$fixture_shared_root/parent" add parent.txt
  git -C "$fixture_shared_root/parent" commit -qm parent
  git -C "$repo_dir" worktree add -q "$fixture_shared_root/child" -b stack/child stack/base
  printf 'child\n' >"$fixture_shared_root/child/child.txt"
  git -C "$fixture_shared_root/child" add child.txt
  git -C "$fixture_shared_root/child" commit -qm child
  git -C "$fixture_shared_root/child" config branch.stack/child.megabrain-parent stack/base
}

scenario_parent_and_default_bases() {
  local output
  setup_fixture
  make_stacked_worktrees
  git -C "$repo_dir" checkout -qb feat/root
  printf 'root\n' >"$repo_dir/root.txt"
  git -C "$repo_dir" add root.txt
  git -C "$repo_dir" commit -qm root
  write_gh
  output="$(megabrain_worktree_pr "$fixture_shared_root/child" --json)"
  assert_equal "$(printf '%s' "$output" | jq -r '.base')" stack/base
  assert_contains "$(cat "$GH_LOG")" '--base stack/base'
  assert_contains "$(cat "$GH_LOG")" '--title stack/child --body '
  output="$(megabrain_worktree_pr "$repo_dir" --json)"
  assert_equal "$(printf '%s' "$output" | jq -r '.base')" main
  assert_contains "$(cat "$GH_LOG")" '--base main'
  printf 'stacked PRs use their parent and root PRs use the repository default\n'
}

scenario_explicit_base_wins() {
  local output
  setup_fixture
  make_stacked_worktrees
  git -C "$repo_dir" branch release
  write_gh
  output="$(megabrain_worktree_pr "$fixture_shared_root/child" --base release --title custom --body details --json)"
  assert_equal "$(printf '%s' "$output" | jq -r '.base')" release
  assert_contains "$(cat "$GH_LOG")" '--base release'
  assert_contains "$(cat "$GH_LOG")" '--title custom --body details'
  printf 'an explicit PR base overrides stack and repository defaults\n'
}

scenario_gh_failures_are_distinct() {
  local output
  setup_fixture
  make_stacked_worktrees
  write_gh
  rm -f "$work_dir/bin/gh"
  PATH="/usr/bin:/bin"
  export PATH
  if output="$(megabrain_worktree_pr "$fixture_shared_root/child" 2>&1)"; then
    fail 'missing gh unexpectedly opened a pull request'
  fi
  assert_contains "$output" 'gh CLI is not installed'
  write_gh
  GH_AUTH=no
  export GH_AUTH
  if output="$(megabrain_worktree_pr "$fixture_shared_root/child" 2>&1)"; then
    fail 'unauthenticated gh unexpectedly opened a pull request'
  fi
  assert_contains "$output" 'gh CLI is not authenticated'
  assert_not_contains "$(cat "$GH_LOG")" 'pr create'
  printf 'missing and unauthenticated gh fail before PR creation with distinct errors\n'
}

scenario_no_commits_ahead_is_refused() {
  local output
  setup_fixture
  write_gh
  if output="$(megabrain_worktree_pr "$repo_dir" --base main 2>&1)"; then
    fail 'a branch with no commits ahead unexpectedly opened a pull request'
  fi
  assert_contains "$output" 'no commits ahead of base main'
  assert_not_contains "$(cat "$GH_LOG")" 'pr create'
  printf 'a branch with no commits ahead is refused before gh pr create\n'
}

scenario_issue_links_are_non_fatal() {
  local output calls
  setup_fixture
  orca_mode=success
  output="$(megabrain_worktree_create --repo "$repo_dir" --branch feat/links --issue 42 --linear-issue ENG-7 --json)"
  calls="$(cat "$work_dir/calls.log")"
  assert_contains "$calls" '--issue 42 --linear-issue ENG-7'
  assert_equal "$(printf '%s' "$output" | jq -r '.links.set')" true
  setup_fixture
  orca_mode=fail
  output="$(megabrain_worktree_create --repo "$repo_dir" --branch feat/links --issue 42 --linear-issue ENG-7 --json)"
  assert_equal "$(printf '%s' "$output" | jq -r '.links.set')" false
  [ -d "$fixture_shared_root/feat-links" ] || fail 'worktree was lost after link failure'
  printf 'issue links reach Orca and a link failure does not lose the checkout\n'
}

scenario_pr_is_passed_to_superset() {
  local calls
  setup_fixture
  megabrain_worktree_create --repo "$repo_dir" --branch review/pr-7 --pr 7 --json >/dev/null
  calls="$(cat "$work_dir/calls.log")"
  assert_contains "$calls" 'workspaces create'
  assert_contains "$calls" '--pr 7'
  printf 'PR review requests reach Superset workspace creation\n'
}

scenario_tree_listing_has_no_orchestrator_dependency() {
  local output json
  setup_fixture
  make_stacked_worktrees
  superset_available=false
  orca_available=false
  output="$(megabrain_worktree_list)"
  assert_contains "$output" 'stack/base'
  assert_contains "$output" '  stack/child'
  json="$(megabrain_worktree_list --json)"
  assert_equal "$(printf '%s' "$json" | jq -r '.[] | select(.branch == "stack/child") | .parent')" stack/base
  printf 'the stack is visible without gh, Orca, or Superset\n'
}

scenario_parent_and_default_bases
scenario_explicit_base_wins
scenario_gh_failures_are_distinct
scenario_no_commits_ahead_is_refused
scenario_issue_links_are_non_fatal
scenario_pr_is_passed_to_superset
scenario_tree_listing_has_no_orchestrator_dependency
printf 'ok: pull requests, issue links, PR review creation, and stack listing scenarios\n'
