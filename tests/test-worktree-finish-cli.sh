#!/usr/bin/env bash

set -euo pipefail

# Scenarios written before implementation:
# 1. The Node entrypoint handles the worktree finish command.
# 2. A recorded parent supplies the merge base and its source in the JSON answer.
# 3. An unmerged branch is refused with the exact structured message, and --force has the
#    same override semantics as the shell contract.
# 4. A missing recorded parent falls back to the repository default with an exact warning.
# 5. An explicit base is reported as explicit, while a finish without --delete-branch reports
#    null base metadata and accepts a branch selector from another working directory.
# 6. An available Orca remover owns host-specific worktree removal.
# 7. A host remover that deletes the branch is already a successful finish.
# 8. A branch deletion failure reports a partial JSON outcome after removing the worktree.
# 9. A successful finish owns its human-readable output.
# 10. Work that is not committed is refused by the compiled remover.
# 11. A refused removal leaves the worktree and branch alone.
# Falsification: invoke the compiled binary directly for content and assert stdout, stderr,
# exit status, filesystem effects, branch effects, and the host-remover call.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-finish-cli.XXXXXX")"
work="$(cd "$work" && pwd -P)"
node_bin="$work/node-bin"
mkdir -p "$node_bin"
ln -s "$(command -v node)" "$node_bin/node"
trap 'rm -rf "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected '$1' to contain '$2'" ;; esac; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }

setup_repo() {
  local repo="$1" shared="$2" state="$3"
  rm -rf "$repo" "$shared" "$state"
  mkdir -p "$shared" "$state/home"
  git init -q "$repo"
  git -C "$repo" config user.email tester@example.com
  git -C "$repo" config user.name tester
  git -C "$repo" config init.defaultBranch main
  printf 'base\n' >"$repo/base.txt"
  git -C "$repo" add base.txt
  git -C "$repo" commit -qm base
  printf '%s\n' "$shared" >"$state/worktree-root"
}

run_binary() {
  local state="$1"; shift
  env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" PATH="$node_bin:/usr/bin:/bin" \
    "$root/.build/megabrain" "$@"
}

scenario_recorded_parent_controls_base() {
  local repo="$work/recorded-repo" shared="$work/recorded-shared" state="$work/recorded-state"
  local output child parent
  setup_repo "$repo" "$shared" "$state"
  parent="$shared/parent"
  child="$shared/child"
  git -C "$repo" worktree add -q "$parent" -b stack/base main
  printf 'parent\n' >"$parent/parent.txt"
  git -C "$parent" add parent.txt
  git -C "$parent" commit -qm parent
  git -C "$repo" worktree add -q "$child" -b stack/child stack/base
  git -C "$child" config branch.stack/child.megabrain-parent stack/base
  printf 'child\n' >"$child/child.txt"
  git -C "$child" add child.txt
  git -C "$child" commit -qm child
  git -C "$parent" merge -q --ff-only stack/child
  output="$(run_binary "$state" worktree finish "$child" --delete-branch --json)" ||
    fail "recorded-parent finish failed: $output"
  printf '%s' "$output" | jq -e --arg path "$child" \
    '.deleted == true and .branch == "stack/child" and .path == $path and .base == "stack/base" and .baseSource == "recorded-parent" and .baseWarning == null and .branchDeleted == true and .refusal == null' >/dev/null ||
    fail "recorded-parent JSON was not exact: $output"
  [ ! -e "$child" ] || fail 'recorded-parent finish left the worktree'
  git -C "$repo" show-ref --verify --quiet refs/heads/stack/child &&
    fail 'recorded-parent finish left the branch'
  printf 'recorded parent reports its base and source\n'
}

scenario_unmerged_refusal_and_force() {
  local repo="$work/unmerged-repo" shared="$work/unmerged-shared" state="$work/unmerged-state"
  local child output error status message
  setup_repo "$repo" "$shared" "$state"
  child="$shared/unmerged"
  git -C "$repo" worktree add -q "$child" -b feat/unmerged main
  printf 'unmerged\n' >"$child/unmerged.txt"
  git -C "$child" add unmerged.txt
  git -C "$child" commit -qm unmerged
  message='refusing to delete unmerged branch: feat/unmerged against base main (use --force to override)'
  set +e
  output="$(run_binary "$state" worktree finish "$child" --delete-branch --json 2>"$work/unmerged.err")"
  status=$?
  set -e
  error="$(cat "$work/unmerged.err")"
  assert_equal "$status" 1
  printf '%s' "$output" | jq -e --arg path "$child" --arg message "$message" \
    '.deleted == false and .branch == "feat/unmerged" and .path == $path and .base == "main" and .baseSource == "repository-default" and .baseWarning == null and .branchDeleted == null and .error == null and .refusal.code == "unmerged-branch" and .refusal.message == $message' >/dev/null ||
    fail "unmerged refusal JSON was not exact: $output"
  assert_equal "$error" "megabrain: $message"
  [ -e "$child" ] || fail 'unmerged refusal removed the worktree'
  git -C "$repo" show-ref --verify --quiet refs/heads/feat/unmerged || fail 'unmerged refusal removed the branch'
  output="$(run_binary "$state" worktree finish "$child" --delete-branch --force --json)" ||
    fail "forced finish failed: $output"
  printf '%s' "$output" | jq -e --arg path "$child" \
    '.deleted == true and .branch == "feat/unmerged" and .path == $path and .base == "main" and .baseSource == "repository-default" and .branchDeleted == true and .refusal == null' >/dev/null ||
    fail "forced finish JSON was not exact: $output"
  [ ! -e "$child" ] || fail 'forced finish left the worktree'
  git -C "$repo" show-ref --verify --quiet refs/heads/feat/unmerged && fail 'forced finish left the branch'
  printf 'unmerged refusal preserves the exact message and --force override\n'
}

scenario_missing_parent_warns_and_refuses() {
  local repo="$work/warning-repo" shared="$work/warning-shared" state="$work/warning-state"
  local child output error status warning
  setup_repo "$repo" "$shared" "$state"
  git -C "$repo" branch stack/missing main
  child="$shared/missing-parent"
  git -C "$repo" worktree add -q "$child" -b feat/missing-parent main
  git -C "$child" config branch.feat/missing-parent.megabrain-parent stack/missing
  printf 'child\n' >"$child/child.txt"
  git -C "$child" add child.txt
  git -C "$child" commit -qm child
  git -C "$repo" branch -D stack/missing >/dev/null
  warning='recorded parent branch no longer exists: stack/missing; judging against repository default base main'
  set +e
  output="$(run_binary "$state" worktree finish "$child" --delete-branch --json 2>"$work/warning.err")"
  status=$?
  set -e
  error="$(cat "$work/warning.err")"
  assert_equal "$status" 1
  printf '%s' "$output" | jq -e --arg path "$child" --arg warning "$warning" \
    '.deleted == false and .branch == "feat/missing-parent" and .path == $path and .base == "main" and .baseSource == "repository-default" and .baseWarning == $warning and .refusal.code == "unmerged-branch"' >/dev/null ||
    fail "missing-parent JSON was not exact: $output"
  assert_contains "$error" "$warning"
  assert_contains "$error" 'refusing to delete unmerged branch: feat/missing-parent against base main (use --force to override)'
  printf 'missing parent reports fallback base and warning\n'
}

scenario_branch_selector_without_delete() {
  local repo="$work/selector-repo" shared="$work/selector-shared" state="$work/selector-state"
  local child output
  setup_repo "$repo" "$shared" "$state"
  child="$shared/no-delete"
  git -C "$repo" worktree add -q "$child" -b feat/no-delete main
  output="$(cd /tmp && run_binary "$state" worktree finish feat/no-delete --json)" ||
    fail "branch selector finish failed: $output"
  printf '%s' "$output" | jq -e --arg path "$child" \
    '.deleted == true and .branch == "feat/no-delete" and .path == $path and .base == null and .baseSource == null and .baseWarning == null and .branchDeleted == null and .error == null and .refusal == null' >/dev/null ||
    fail "no-delete JSON was not exact: $output"
  [ ! -e "$child" ] || fail 'branch selector finish left the worktree'
  git -C "$repo" show-ref --verify --quiet refs/heads/feat/no-delete || fail 'no-delete finish deleted an unrelated branch'
  printf 'branch selector from another cwd preserves null finish metadata\n'
}

scenario_explicit_base_is_reported() {
  local repo="$work/explicit-repo" shared="$work/explicit-shared" state="$work/explicit-state"
  local child output error status message
  setup_repo "$repo" "$shared" "$state"
  child="$shared/explicit"
  git -C "$repo" worktree add -q "$child" -b feat/explicit main
  printf 'explicit\n' >"$child/explicit.txt"
  git -C "$child" add explicit.txt
  git -C "$child" commit -qm explicit
  message='refusing to delete unmerged branch: feat/explicit against base main (use --force to override)'
  set +e
  output="$(run_binary "$state" worktree finish "$child" --delete-branch --base main --json 2>"$work/explicit.err")"
  status=$?
  set -e
  error="$(cat "$work/explicit.err")"
  assert_equal "$status" 1
  printf '%s' "$output" | jq -e --arg path "$child" --arg message "$message" \
    '.deleted == false and .branch == "feat/explicit" and .path == $path and .base == "main" and .baseSource == "explicit" and .baseWarning == null and .refusal.code == "unmerged-branch" and .refusal.message == $message' >/dev/null ||
    fail "explicit-base JSON was not exact: $output"
  assert_equal "$error" "megabrain: $message"
  printf 'explicit base reports the explicit source\n'
}

scenario_invalid_json_refusal() {
  local state="$work/invalid-state" output error status message
  mkdir -p "$state/home"
  message='unknown worktree finish option: --unexpected'
  set +e
  output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" PATH="$node_bin:/usr/bin:/bin" \
    "$root/.build/megabrain" worktree finish --json --unexpected 2>"$work/invalid.err")"
  status=$?
  set -e
  error="$(cat "$work/invalid.err")"
  assert_equal "$status" 2
  printf '%s' "$output" | jq -e --arg message "$message" \
    '.deleted == false and .branch == null and .path == null and .base == null and .baseSource == null and .baseWarning == null and .branchDeleted == null and .error == null and .refusal.code == "invalid-arguments" and .refusal.message == $message' >/dev/null ||
    fail "invalid-arguments JSON was not exact: $output"
  assert_equal "$error" "megabrain: $message"
  printf 'invalid arguments preserve structured JSON and stderr\n'
}

scenario_orca_removal_is_used() {
  local repo="$work/orca-repo" shared="$work/orca-shared" state="$work/orca-state" bin="$work/orca-bin"
  local child output calls
  setup_repo "$repo" "$shared" "$state"
  mkdir -p "$bin"
  cat >"$bin/orca" <<'EOF'
#!/usr/bin/env bash
path=''
printf '%s\n' "$*" >>"$ORCA_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --worktree) path="${2#path:}"; shift 2 ;;
    *) shift ;;
  esac
done
/usr/bin/git -C "$ORCA_REPO" worktree remove "$path"
printf '%s\n' '{"deleted":["fixture"],"warnings":[]}'
EOF
  chmod +x "$bin/orca"
  child="$shared/orca"
  git -C "$repo" worktree add -q "$child" -b feat/orca main
  output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" ORCA_LOG="$work/orca.log" ORCA_REPO="$repo" PATH="$bin:$node_bin:/usr/bin:/bin" \
    "$root/.build/megabrain" worktree finish "$child" --json)" ||
    fail "Orca removal finish failed: $output"
  printf '%s' "$output" | jq -e '.deleted == true and .branch == "feat/orca"' >/dev/null ||
    fail "Orca removal JSON was not successful: $output"
  [ ! -e "$child" ] || fail 'Orca remover left the worktree'
  calls="$(cat "$work/orca.log")"
  assert_contains "$calls" 'worktree rm --worktree path:'
  assert_contains "$calls" '--json'
  printf 'Orca owns removal when available\n'
}

scenario_superset_removal_is_used() {
  local repo="$work/superset-repo" shared="$work/superset-shared" state="$work/superset-state" bin="$work/superset-bin"
  local child output calls
  setup_repo "$repo" "$shared" "$state"
  mkdir -p "$bin"
  cat >"$bin/superset" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SUPERSET_LOG"
case "$1 $2 $3" in
  "workspaces list --local")
    printf '{"result":{"workspaces":[{"id":"workspace-id","branch":"feat/superset","worktreePath":"%s"}]}}\n' "$SUPERSET_PATH"
    ;;
  "workspaces delete workspace-id")
    /usr/bin/git -C "$SUPERSET_REPO" worktree remove "$SUPERSET_PATH"
    printf '%s\n' '{"deleted":["workspace-id"],"warnings":[]}'
    ;;
esac
EOF
  chmod +x "$bin/superset"
  child="$shared/superset"
  git -C "$repo" worktree add -q "$child" -b feat/superset main
  output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" SUPERSET_LOG="$work/superset.log" SUPERSET_REPO="$repo" SUPERSET_PATH="$child" PATH="$bin:$node_bin:/usr/bin:/bin" \
    "$root/.build/megabrain" worktree finish "$child" --json)" ||
    fail "Superset removal finish failed: $output"
  printf '%s' "$output" | jq -e '.deleted == true and .branch == "feat/superset"' >/dev/null ||
    fail "Superset removal JSON was not successful: $output"
  [ ! -e "$child" ] || fail 'Superset remover left the worktree'
  calls="$(cat "$work/superset.log")"
  assert_contains "$calls" 'workspaces list --local --json'
  assert_contains "$calls" 'workspaces delete workspace-id --local --json'
  printf 'Superset owns removal when its workspace is registered\n'
}

scenario_host_remover_deletes_branch_successfully() {
  local repo="$work/host-branch-repo" shared="$work/host-branch-shared" state="$work/host-branch-state" bin="$work/host-branch-bin"
  local child output
  setup_repo "$repo" "$shared" "$state"
  mkdir -p "$bin"
  cat >"$bin/orca" <<'EOF'
#!/usr/bin/env bash
path=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --worktree) path="${2#path:}"; shift 2 ;;
    *) shift ;;
  esac
done
/usr/bin/git -C "$ORCA_REPO" worktree remove "$path"
/usr/bin/git -C "$ORCA_REPO" branch -D "$ORCA_BRANCH"
printf '%s\n' '{"deleted":["fixture"],"warnings":[]}'
EOF
  chmod +x "$bin/orca"
  child="$shared/host-branch"
  git -C "$repo" worktree add -q "$child" -b feat/host-branch main
  output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" ORCA_REPO="$repo" ORCA_BRANCH=feat/host-branch PATH="$bin:$node_bin:/usr/bin:/bin" \
    "$root/.build/megabrain" worktree finish "$child" --delete-branch --force --json 2>"$work/host-branch.err")" ||
    fail "host remover that deleted the branch was reported as failure: $output"
  printf '%s' "$output" | jq -e '.deleted == true and .branch == "feat/host-branch" and .branchDeleted == false and .error == null and .refusal == null' >/dev/null ||
    fail "host remover branch deletion was not a successful JSON outcome: $output"
  [ ! -e "$child" ] || fail 'host remover left the worktree'
  git -C "$repo" show-ref --verify --quiet refs/heads/feat/host-branch &&
    fail 'host remover left the branch'
  [ ! -s "$work/host-branch.err" ] || fail "successful host removal wrote an error: $(cat "$work/host-branch.err")"
  printf 'host remover that deletes the branch is already successful\n'
}

scenario_branch_deletion_failure_returns_partial_json() {
  local repo="$work/branch-failure-repo" shared="$work/branch-failure-shared" state="$work/branch-failure-state" bin="$work/branch-failure-bin"
  local child output error rc
  setup_repo "$repo" "$shared" "$state"
  mkdir -p "$bin"
  cat >"$bin/git" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = '-C' ] && [ "${2:-}" = "$FAIL_GIT_REPO" ] &&
  [ "${3:-}" = branch ] && [ "${4:-}" = -D ] && [ "${5:-}" = "$FAIL_GIT_BRANCH" ]; then
  printf '%s\n' 'fatal: simulated branch deletion refusal' >&2
  exit 1
fi
exec /usr/bin/git "$@"
EOF
  chmod +x "$bin/git"
  child="$shared/branch-failure"
  git -C "$repo" worktree add -q "$child" -b feat/branch-failure main
  set +e
  output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" FAIL_GIT_REPO="$repo" FAIL_GIT_BRANCH=feat/branch-failure PATH="$bin:$node_bin:/usr/bin:/bin" \
    "$root/.build/megabrain" worktree finish "$child" --delete-branch --force --json 2>"$work/branch-failure.err")"
  rc=$?
  set -e
  error="$(cat "$work/branch-failure.err")"
  assert_equal "$rc" 1
  printf '%s' "$output" | jq -e '.deleted == true and .branch == "feat/branch-failure" and .branchDeleted == false and (.error | contains("simulated branch deletion refusal")) and .refusal == null' >/dev/null ||
    fail "branch deletion failure did not return a partial JSON outcome: $output"
  assert_contains "$error" 'could not delete branch: feat/branch-failure'
  [ ! -e "$child" ] || fail 'branch deletion failure left the worktree'
  git -C "$repo" show-ref --verify --quiet refs/heads/feat/branch-failure ||
    fail 'branch deletion failure removed the branch'
  printf 'branch deletion failure returns a partial JSON outcome\n'
}

scenario_successful_finish_owns_human_output() {
  local repo="$work/human-repo" shared="$work/human-shared" state="$work/human-state"
  local child output
  setup_repo "$repo" "$shared" "$state"
  child="$shared/human"
  git -C "$repo" worktree add -q "$child" -b feat/human main
  output="$(run_binary "$state" worktree finish "$child")" ||
    fail "successful human-readable finish failed: $output"
  assert_equal "$output" "removed: $child"
  [ ! -e "$child" ] || fail 'human-readable finish left the worktree'
  printf 'successful finish owns its human-readable output\n'
}

scenario_uncommitted_work_is_refused() {
  local repo="$work/uncommitted-repo" shared="$work/uncommitted-shared" state="$work/uncommitted-state"
  local child output error rc
  setup_repo "$repo" "$shared" "$state"
  child="$shared/uncommitted"
  git -C "$repo" worktree add -q "$child" -b feat/uncommitted main
  printf 'work that is not committed\n' >"$child/uncommitted.txt"
  set +e
  output="$(run_binary "$state" worktree finish "$child" --json 2>"$work/uncommitted.err")"
  rc=$?
  set -e
  error="$(cat "$work/uncommitted.err")"
  [ "$rc" -ne 0 ] || fail 'work that is not committed was removed successfully'
  printf '%s' "$output" | jq -e '.deleted == false and (.error | contains("modified or untracked files"))' >/dev/null ||
    fail "uncommitted work did not return a refusal outcome: $output"
  assert_contains "$error" 'contains modified or untracked files'
  printf 'work that is not committed is refused by the compiled remover\n'
}

scenario_refused_removal_preserves_worktree_and_branch() {
  local repo="$work/preserve-repo" shared="$work/preserve-shared" state="$work/preserve-state"
  local child output rc
  setup_repo "$repo" "$shared" "$state"
  child="$shared/preserve"
  git -C "$repo" worktree add -q "$child" -b feat/preserve main
  printf 'work that is not committed\n' >"$child/uncommitted.txt"
  set +e
  output="$(run_binary "$state" worktree finish "$child" --json 2>"$work/preserve.err")"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail 'a refused removal returned success'
  [ -f "$child/uncommitted.txt" ] || fail 'a refused removal removed the worktree'
  git -C "$repo" show-ref --verify --quiet refs/heads/feat/preserve ||
    fail 'a refused removal deleted the branch'
  printf 'a refused removal leaves the worktree and branch alone\n'
}

[ -x "$root/.build/megabrain" ] || { printf 'skip: compiled finish binary is missing at %s; run bun run build\n' "$root/.build/megabrain"; exit 0; }
scenario_recorded_parent_controls_base
scenario_unmerged_refusal_and_force
scenario_missing_parent_warns_and_refuses
scenario_branch_selector_without_delete
scenario_explicit_base_is_reported
scenario_invalid_json_refusal
scenario_orca_removal_is_used
scenario_superset_removal_is_used
scenario_host_remover_deletes_branch_successfully
scenario_branch_deletion_failure_returns_partial_json
scenario_successful_finish_owns_human_output
scenario_uncommitted_work_is_refused
scenario_refused_removal_preserves_worktree_and_branch
printf 'ok: compiled worktree finish contract scenarios\n'
