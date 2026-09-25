#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-contract.XXXXXX")"

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

make_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git init -q "$repo"
  git -C "$repo" config user.email tester@example.com
  git -C "$repo" config user.name tester
  git -C "$repo" config init.defaultBranch main
  printf 'base\n' >"$repo/base.txt"
  git -C "$repo" add base.txt
  git -C "$repo" commit -qm base
}

write_orchestrator_stubs() {
  mkdir -p "$work_dir/bin"
  cat >"$work_dir/bin/orca" <<'EOF'
#!/usr/bin/env bash
case "${ORCA_MODE:-registry}" in
  unavailable) exit 1 ;;
  set-fail)
    case "$1 ${2:-}" in
      repo\ list) printf '%s\n' '{"result":{"repos":[]}}' ;;
      worktree\ set) exit 1 ;;
      *) exit 1 ;;
    esac
    ;;
  registry)
    if [ "$1 ${2:-} ${3:-}" = 'repo list --json' ]; then
      printf '%s\n' '{"result":{"repos":[{"displayName":"another-repo","path":"/tmp/another-repo"}]}}'
      exit 0
    fi
    exit 1
    ;;
  *)
    if [ "$1 ${2:-} ${3:-}" = 'repo list --json' ]; then
      printf '%s\n' '{"result":{"repos":[]}}'
      exit 0
    fi
    exit 1
    ;;
esac
EOF
  cat >"$work_dir/bin/superset" <<'EOF'
#!/usr/bin/env bash
case "$1 ${2:-}" in
  projects\ list)
    printf '%s\n' '{"result":{"projects":[]}}'
    ;;
  projects\ create)
    if [ "${SUPERSET_MODE:-success}" = project-fail ]; then exit 1; fi
    printf '%s\n' '{"result":{"project":{"id":"project-id"}}}'
    ;;
  workspaces\ list)
    printf '%s\n' '{"result":{"workspaces":[]}}'
    ;;
  workspaces\ create)
    if [ "${SUPERSET_MODE:-success}" = workspace-fail ]; then exit 1; fi
    printf '%s\n' '{"result":{"workspace":{"id":"workspace-id"}}}'
    ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$work_dir/bin/orca" "$work_dir/bin/superset"
}

run_impl() {
  local implementation="$1" state="$2" repo="$3" branch="$4"
  shift 4
  env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary PATH="$work_dir/bin:/usr/bin:/bin" "$root/.build/megabrain" worktree create --repo "$repo" --branch "$branch" "$@"
}

run_no_orchestrator() {
  local implementation="$1" state="$2" repo="$3" branch="$4"
  shift 4
  env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary PATH=/usr/bin:/bin "$root/.build/megabrain" worktree create --repo "$repo" --branch "$branch" "$@"
}

scenario_orchestrator_free_create_and_list() {
  local implementation state repo shared output
  for implementation in shell binary; do
    state="$work_dir/no-host-$implementation/state"
    repo="$work_dir/no-host-$implementation/repo"
    shared="$work_dir/no-host-$implementation/shared"
    mkdir -p "$state" "$shared"
    make_repo "$repo"
    printf '%s\n' "$shared" >"$state/worktree-root"
    output="$(run_no_orchestrator "$implementation" "$state" "$repo" "feat/no-host-$implementation" --json)" ||
      fail "$implementation did not create without an orchestrator: $output"
    assert_equal "$(printf '%s' "$output" | jq -r '.workspace')" null
    [ -d "$shared/feat-no-host-$implementation" ] || fail "$implementation did not create the worktree"
    git -C "$repo" branch --list "feat/no-host-$implementation" | grep -q "feat/no-host-$implementation" ||
      fail "$implementation did not create the branch"
    output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_LIST_IMPLEMENTATION=binary PATH=/usr/bin:/bin "$root/.build/megabrain" worktree list --json)" ||
      fail "$implementation did not list without an orchestrator: $output"
    assert_contains "$output" "feat/no-host-$implementation"
  done
  printf 'orchestrator-free create and list work for both implementations\n'
}

scenario_superset_project_failure_keeps_git_work() {
  local state="$work_dir/project-failure-shell/state" repo="$work_dir/project-failure-shell/repo" shared="$work_dir/project-failure-shell/shared" output branch=feat/project-failure-shell
  mkdir -p "$state" "$shared"
  make_repo "$repo"
  printf '%s\n' "$shared" >"$state/worktree-root"
  if output="$(env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=shell SUPERSET_TERMINAL_ID=contract-project SUPERSET_MODE=project-fail PATH="$work_dir/bin:/usr/bin:/bin" "$root/.build/megabrain" worktree create --repo "$repo" --branch "$branch" --json 2>&1)"; then
    fail 'shell fallback accepted a project registration failure'
  fi
  assert_contains "$output" 'shell worktree implementation no longer exists'
  [ ! -e "$shared/${branch//\//-}" ] || fail 'shell fallback created a worktree after removal'
  git -C "$repo" branch --list "$branch" | grep -q "$branch" && fail 'shell fallback created a branch after removal'
  printf 'project registration scenario refuses the removed shell fallback\n'
}

scenario_superset_workspace_failure_keeps_git_work() {
  local state="$work_dir/workspace-failure-shell/state" repo="$work_dir/workspace-failure-shell/repo" shared="$work_dir/workspace-failure-shell/shared" output branch=feat/workspace-failure-shell
  mkdir -p "$state" "$shared"
  make_repo "$repo"
  printf '%s\n' "$shared" >"$state/worktree-root"
  if output="$(env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=shell SUPERSET_TERMINAL_ID=contract-workspace SUPERSET_MODE=workspace-fail PATH="$work_dir/bin:/usr/bin:/bin" "$root/.build/megabrain" worktree create --repo "$repo" --branch "$branch" --json 2>&1)"; then
    fail 'shell fallback accepted a workspace registration failure'
  fi
  assert_contains "$output" 'shell worktree implementation no longer exists'
  [ ! -e "$shared/${branch//\//-}" ] || fail 'shell fallback created a worktree after removal'
  git -C "$repo" branch --list "$branch" | grep -q "$branch" && fail 'shell fallback created a branch after removal'
  printf 'workspace registration scenario refuses the removed shell fallback\n'
}

scenario_compiled_registration_failure_keeps_git_work() {
  local state="$work_dir/compiled-registration/state" repo="$work_dir/compiled-registration/repo" shared="$work_dir/compiled-registration/shared" output branch=feat/compiled-registration
  mkdir -p "$state" "$shared"
  make_repo "$repo"
  printf '%s\n' "$shared" >"$state/worktree-root"
  output="$(env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary ORCA_MODE=set-fail PATH="$work_dir/bin:/usr/bin:/bin" "$root/.build/megabrain" worktree create --repo "$repo" --branch "$branch" --parent "path:$repo" --json)" ||
    fail 'compiled implementation did not keep a worktree after registration failed'
  assert_equal "$(printf '%s' "$output" | jq -r '.parent.lineage.set')" false
  assert_contains "$output" 'Orca parent lineage was not set'
  [ -d "$shared/${branch//\//-}" ] || fail 'compiled implementation removed the worktree after registration failed'
  git -C "$repo" branch --list "$branch" | grep -q "$branch" || fail 'compiled implementation removed the branch after registration failed'
  printf 'compiled registration failure keeps Git work\n'
}

run_failed_create() {
  local implementation="$1" state="$2" repo="$3" shared="$4" branch="$5" output status command slug
  slug="${branch//\//-}"
  touch "$shared/$slug"
  command="$root/.build/megabrain"
  set +e
  output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary PATH=/usr/bin:/bin "$command" worktree create --repo "$repo" --branch "$branch" --base main --json 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "$implementation accepted a failed Git create: $output"
  printf '%s failed create output: %s\n' "$implementation" "$output"
}

write_unreadable_branch_check_git() {
  mkdir -p "$work_dir/unreadable-bin"
  cat >"$work_dir/unreadable-bin/git" <<'EOF'
#!/usr/bin/env bash
if [ "$#" -ge 3 ] && [ "$1" = -C ] && [ "$3" = show-ref ] && [ ! -e "$MEGABRAIN_SHOW_REF_MARKER" ]; then
  : >"$MEGABRAIN_SHOW_REF_MARKER"
  exit 128
fi
exec "$MEGABRAIN_REAL_GIT" "$@"
EOF
  chmod +x "$work_dir/unreadable-bin/git"
}

run_unreadable_branch_check() {
  local implementation="$1" state="$2" repo="$3" branch="$4" marker="$5" output status command real_git
  command="$root/.build/megabrain"
  real_git="$(command -v git)"
  set +e
  output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary MEGABRAIN_REAL_GIT="$real_git" MEGABRAIN_SHOW_REF_MARKER="$marker" PATH="$work_dir/unreadable-bin:/usr/bin:/bin" "$command" worktree create --repo "$repo" --branch "$branch" --base main --json 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "$implementation accepted an unreadable branch check: $output"
  UNREADABLE_BRANCH_CHECK_OUTPUT="$output"
  printf '%s unreadable branch check output: %s\n' "$implementation" "$UNREADABLE_BRANCH_CHECK_OUTPUT"
}

scenario_failed_create_removes_only_new_branch() {
  local implementation state repo shared branch before after
  for implementation in shell binary; do
    state="$work_dir/orphan-$implementation/state"
    repo="$work_dir/orphan-$implementation/repo"
    shared="$work_dir/orphan-$implementation/shared"
    branch="probe/orphan-$implementation"
    mkdir -p "$state" "$shared"
    make_repo "$repo"
    printf '%s\n' "$shared" >"$state/worktree-root"
    before="$(git -C "$repo" branch --list)"
    run_failed_create "$implementation" "$state" "$repo" "$shared" "$branch"
    after="$(git -C "$repo" branch --list)"
    printf '%s branches before:\n%s\n' "$implementation" "$before"
    printf '%s branches after:\n%s\n' "$implementation" "$after"
    # Falsification: without rollback, the after listing contains the new branch.
    assert_equal "$before" "$after"
  done
  printf 'failed creates remove branches created by that invocation\n'
}

scenario_existing_branch_survives_failed_create() {
  local implementation state repo shared branch before after
  for implementation in shell binary; do
    state="$work_dir/existing-branch-$implementation/state"
    repo="$work_dir/existing-branch-$implementation/repo"
    shared="$work_dir/existing-branch-$implementation/shared"
    branch="probe/existing-$implementation"
    mkdir -p "$state" "$shared"
    make_repo "$repo"
    git -C "$repo" branch "$branch"
    printf '%s\n' "$shared" >"$state/worktree-root"
    before="$(git -C "$repo" branch --list)"
    run_failed_create "$implementation" "$state" "$repo" "$shared" "$branch"
    after="$(git -C "$repo" branch --list)"
    printf '%s pre-existing branch listings before:\n%s\n' "$implementation" "$before"
    printf '%s pre-existing branch listings after:\n%s\n' "$implementation" "$after"
    assert_equal "$before" "$after"
  done
  printf 'failed creates preserve pre-existing branches\n'
}

scenario_unreadable_branch_check_preserves_existing_branch() {
  local implementation state repo shared branch marker before after
  write_unreadable_branch_check_git
  for implementation in shell binary; do
    state="$work_dir/unreadable-$implementation/state"
    repo="$work_dir/unreadable-$implementation/repo"
    shared="$work_dir/unreadable-$implementation/shared"
    branch="probe/unreadable-$implementation"
    marker="$work_dir/unreadable-$implementation/show-ref-called"
    mkdir -p "$state" "$shared"
    make_repo "$repo"
    git -C "$repo" branch "$branch"
    printf '%s\n' "$shared" >"$state/worktree-root"
    before="$(git -C "$repo" branch --list)"
    run_unreadable_branch_check "$implementation" "$state" "$repo" "$branch" "$marker"
    after="$(git -C "$repo" branch --list)"
    assert_equal "$after" "$before"
    assert_contains "$UNREADABLE_BRANCH_CHECK_OUTPUT" "could not check whether branch exists: $branch"
    printf '%s preserved the branch when show-ref was unreadable\n' "$implementation"
  done
}

scenario_worktree_create_routes_binary() {
  local fixture="$work_dir/orphan-routing" state="$work_dir/orphan-routing-state" repo="$work_dir/orphan-routing-repo" shared="$work_dir/orphan-routing-shared" output status
  source "$root/tests/fixtures/entrypoint-routing.sh"
  make_entrypoint_routing_fixture "$root" "$fixture" 97
  mkdir -p "$state" "$shared"
  make_repo "$repo"
  printf '%s\n' "$shared" >"$state/worktree-root"
  set +e
  output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary PATH=/usr/bin:/bin "$fixture/.build/megabrain" worktree create --repo "$repo" --branch feat/orphan-routing --base main --json 2>&1)"
  status=$?
  set -e
  assert_equal "$status" 97
  printf 'worktree create binary route reaches the compiled entrypoint\n'
}

refusal_output() {
  local implementation="$1" mode="$2" state output status
  state="$work_dir/refusal-$implementation-$mode/state"
  mkdir -p "$state" "$work_dir/refusal-$implementation-$mode/shared"
  printf '%s\n' "$work_dir/refusal-$implementation-$mode/shared" >"$state/worktree-root"
  set +e
  output="$(env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary ORCA_MODE="$mode" PATH="$work_dir/bin:/usr/bin:/bin" "$root/.build/megabrain" worktree create --repo selector-that-does-not-match --branch "feat/refusal-$implementation-$mode" --json 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "$implementation accepted $mode repository refusal"
  printf '%s\n' "$output"
}

scenario_repo_selector_refusal_causes() {
  local implementation absent unresponsive unmatched
  write_orchestrator_stubs
  for implementation in shell binary; do
    mkdir -p "$work_dir/absent-$implementation/state" "$work_dir/absent-$implementation/shared"
    printf '%s\n' "$work_dir/absent-$implementation/shared" >"$work_dir/absent-$implementation/state/worktree-root"
    absent="$(env HOME="$work_dir/absent-$implementation/home" MEGABRAIN_STATE_DIR="$work_dir/absent-$implementation/state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary PATH=/usr/bin:/bin "$root/.build/megabrain" worktree create --repo selector-that-does-not-match --branch feat/refusal-absent --json 2>&1 || true)"
    unresponsive="$(refusal_output "$implementation" unavailable)"
    unmatched="$(refusal_output "$implementation" registry)"
    assert_contains "$absent" 'when orca is not installed'
    assert_contains "$unresponsive" 'orca did not respond'
    assert_contains "$unmatched" 'repo not found: selector-that-does-not-match'
    assert_not_contains "$unresponsive" 'orca is not installed'
    assert_not_contains "$unmatched" 'orca did not respond'
    assert_not_contains "$absent" 'repo not found: selector-that-does-not-match'
    [ "$absent" != "$unresponsive" ] || fail "$implementation collapsed absent and unresponsive refusals"
    [ "$unresponsive" != "$unmatched" ] || fail "$implementation collapsed unresponsive and unmatched refusals"
  done
  printf 'repo selector refusal causes are distinct in both implementations\n'
}

write_orchestrator_stubs
scenario_orchestrator_free_create_and_list
scenario_superset_project_failure_keeps_git_work
scenario_superset_workspace_failure_keeps_git_work
scenario_compiled_registration_failure_keeps_git_work
scenario_failed_create_removes_only_new_branch
scenario_existing_branch_survives_failed_create
scenario_unreadable_branch_check_preserves_existing_branch
scenario_worktree_create_routes_binary
scenario_repo_selector_refusal_causes
printf 'ok: worktree create contract scenarios\n'
