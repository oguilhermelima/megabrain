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
  env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION="$implementation" PATH="$work_dir/bin:/usr/bin:/bin" "$root/megabrain" worktree create --repo "$repo" --branch "$branch" "$@"
}

run_no_orchestrator() {
  local implementation="$1" state="$2" repo="$3" branch="$4"
  shift 4
  env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION="$implementation" PATH=/usr/bin:/bin "$root/megabrain" worktree create --repo "$repo" --branch "$branch" "$@"
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
    output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_LIST_IMPLEMENTATION="$implementation" PATH=/usr/bin:/bin "$root/megabrain" worktree list --json)" ||
      fail "$implementation did not list without an orchestrator: $output"
    assert_contains "$output" "feat/no-host-$implementation"
  done
  printf 'orchestrator-free create and list work for both implementations\n'
}

scenario_superset_project_failure_keeps_git_work() {
  local implementation state repo shared output branch
  for implementation in shell; do
    state="$work_dir/project-failure-$implementation/state"
    repo="$work_dir/project-failure-$implementation/repo"
    shared="$work_dir/project-failure-$implementation/shared"
    branch="feat/project-failure-$implementation"
    mkdir -p "$state" "$shared"
    make_repo "$repo"
    printf '%s\n' "$shared" >"$state/worktree-root"
    if output="$(env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION="$implementation" SUPERSET_TERMINAL_ID=contract-project SUPERSET_MODE=project-fail PATH="$work_dir/bin:/usr/bin:/bin" "$root/megabrain" worktree create --repo "$repo" --branch "$branch" --json 2>&1)"; then
      fail "$implementation accepted a project registration failure"
    fi
    assert_contains "$output" 'could not register Superset project'
    assert_contains "$output" 'kept Git worktree'
    assert_contains "$output" "branch $branch"
    [ -d "$shared/${branch//\//-}" ] || fail "$implementation removed the worktree after project registration failed"
    git -C "$repo" branch --list "$branch" | grep -q "$branch" || fail "$implementation removed the branch after project registration failed"
  done
  printf 'project registration failure keeps Git work\n'
}

scenario_superset_workspace_failure_keeps_git_work() {
  local implementation state repo shared output branch
  for implementation in shell; do
    state="$work_dir/workspace-failure-$implementation/state"
    repo="$work_dir/workspace-failure-$implementation/repo"
    shared="$work_dir/workspace-failure-$implementation/shared"
    branch="feat/workspace-failure-$implementation"
    mkdir -p "$state" "$shared"
    make_repo "$repo"
    printf '%s\n' "$shared" >"$state/worktree-root"
    if output="$(env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION="$implementation" SUPERSET_TERMINAL_ID=contract-workspace SUPERSET_MODE=workspace-fail PATH="$work_dir/bin:/usr/bin:/bin" "$root/megabrain" worktree create --repo "$repo" --branch "$branch" --json 2>&1)"; then
      fail "$implementation accepted a workspace registration failure"
    fi
    assert_contains "$output" 'could not create Superset workspace'
    assert_contains "$output" 'kept Git worktree'
    assert_contains "$output" 'Superset project: registered'
    assert_contains "$output" 'Superset workspace: not registered'
    [ -d "$shared/${branch//\//-}" ] || fail "$implementation removed the worktree after workspace registration failed"
    git -C "$repo" branch --list "$branch" | grep -q "$branch" || fail "$implementation removed the branch after workspace registration failed"
  done
  printf 'workspace registration failure keeps Git work\n'
}

scenario_compiled_registration_failure_keeps_git_work() {
  local state="$work_dir/compiled-registration/state" repo="$work_dir/compiled-registration/repo" shared="$work_dir/compiled-registration/shared" output branch=feat/compiled-registration
  mkdir -p "$state" "$shared"
  make_repo "$repo"
  printf '%s\n' "$shared" >"$state/worktree-root"
  output="$(env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary ORCA_MODE=set-fail PATH="$work_dir/bin:/usr/bin:/bin" "$root/megabrain" worktree create --repo "$repo" --branch "$branch" --parent "path:$repo" --json)" ||
    fail 'compiled implementation did not keep a worktree after registration failed'
  assert_equal "$(printf '%s' "$output" | jq -r '.parent.lineage.set')" false
  assert_contains "$output" 'Orca parent lineage was not set'
  [ -d "$shared/${branch//\//-}" ] || fail 'compiled implementation removed the worktree after registration failed'
  git -C "$repo" branch --list "$branch" | grep -q "$branch" || fail 'compiled implementation removed the branch after registration failed'
  printf 'compiled registration failure keeps Git work\n'
}

refusal_output() {
  local implementation="$1" mode="$2" state output status
  state="$work_dir/refusal-$implementation-$mode/state"
  mkdir -p "$state"
  set +e
  output="$(env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION="$implementation" ORCA_MODE="$mode" PATH="$work_dir/bin:/usr/bin:/bin" "$root/megabrain" worktree create --repo selector-that-does-not-match --branch "feat/refusal-$implementation-$mode" --json 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "$implementation accepted $mode repository refusal"
  printf '%s\n' "$output"
}

scenario_repo_selector_refusal_causes() {
  local implementation absent unresponsive unmatched
  write_orchestrator_stubs
  for implementation in shell binary; do
    absent="$(env HOME="$work_dir/absent-$implementation/home" MEGABRAIN_STATE_DIR="$work_dir/absent-$implementation/state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION="$implementation" PATH=/usr/bin:/bin "$root/megabrain" worktree create --repo selector-that-does-not-match --branch feat/refusal-absent --json 2>&1 || true)"
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

scenario_routing_deleted_and_restored() {
  local fixture="$work_dir/routing" state="$work_dir/routing-state" repo="$work_dir/routing-repo" shared="$work_dir/routing-shared" output status backup modified
  source "$root/tests/fixtures/entrypoint-routing.sh"
  make_entrypoint_routing_fixture "$root" "$fixture" 97
  mkdir -p "$state" "$shared"
  make_repo "$repo"
  printf '%s\n' "$shared" >"$state/worktree-root"

  set +e
  output="$(env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary PATH=/usr/bin:/bin "$fixture/megabrain" worktree create --repo "$repo" --branch feat/routing-marker --json 2>&1)"
  status=$?
  set -e
  assert_equal "$status" 97
  printf 'routing restored: status=%s output=%s\n' "$status" "$output"

  backup="$work_dir/module-worktree.sh.saved"
  modified="$work_dir/module-worktree.sh.modified"
  cp "$fixture/lib/module-worktree.sh" "$backup"
  awk '
    /if \[ "\$orchestrate_requested" = false \] && megabrain_should_use_typescript_binary/ { skip = 1; next }
    skip && /^  fi$/ { skip = 0; next }
    !skip { print }
  ' "$backup" >"$modified"
  mv "$modified" "$fixture/lib/module-worktree.sh"
  output="$(env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary PATH=/usr/bin:/bin "$fixture/megabrain" worktree create --repo "$repo" --branch feat/routing-deleted --json)" ||
    fail 'deleting the binary route did not expose the shell implementation'
  [ -d "$shared/feat-routing-deleted" ] || fail 'shell implementation did not create after route deletion'
  printf 'routing deleted: shell create succeeded\n'

  cp "$backup" "$fixture/lib/module-worktree.sh"
  set +e
  output="$(env HOME="$state/home" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary PATH=/usr/bin:/bin "$fixture/megabrain" worktree create --repo "$repo" --branch feat/routing-restored --json 2>&1)"
  status=$?
  set -e
  assert_equal "$status" 97
  printf 'routing restored: status=%s output=%s\n' "$status" "$output"
}

write_orchestrator_stubs
scenario_orchestrator_free_create_and_list
scenario_superset_project_failure_keeps_git_work
scenario_superset_workspace_failure_keeps_git_work
scenario_compiled_registration_failure_keeps_git_work
scenario_repo_selector_refusal_causes
scenario_routing_deleted_and_restored
printf 'ok: worktree create contract scenarios\n'
