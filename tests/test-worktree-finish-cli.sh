#!/usr/bin/env bash

set -euo pipefail

# Scenarios written before implementation:
# 1. The worktree finish wrapper routes to the compiled entrypoint.
# 2. A recorded parent supplies the merge base and its source in the JSON answer.
# 3. An unmerged branch is refused with the exact structured message, and --force has the
#    same override semantics as the shell contract.
# 4. A missing recorded parent falls back to the repository default with an exact warning.
# 5. An explicit base is reported as explicit, while a finish without --delete-branch reports
#    null base metadata and accepts a branch selector from another working directory.
# 6. An available Orca remover owns host-specific worktree removal.
# Falsification: invoke the compiled binary directly for content and assert stdout, stderr,
# exit status, filesystem effects, branch effects, and the host-remover call.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-finish-cli.XXXXXX")"
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
  env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" PATH="/usr/bin:/bin" \
    "$root/.build/megabrain" "$@"
}

scenario_routes_finish_to_binary() {
  local fixture="$work/routing" state="$work/routing-state" output status
  source "$root/tests/fixtures/entrypoint-routing.sh"
  make_entrypoint_routing_fixture "$root" "$fixture" 97
  mkdir -p "$state/home"
  set +e
  output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary PATH=/usr/bin:/bin \
    "$fixture/megabrain" worktree finish missing --json 2>&1)"
  status=$?
  set -e
  assert_equal "$status" 97
  assert_contains "$output" 'installed skill source is missing'
  printf 'finish route reaches the compiled entrypoint: status=%s\n' "$status"
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
  output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" PATH="/usr/bin:/bin" \
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
  output="$(env -i HOME="$state/home" MEGABRAIN_STATE_DIR="$state" ORCA_LOG="$work/orca.log" ORCA_REPO="$repo" PATH="$bin:/usr/bin:/bin" \
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

[ -x "$root/.build/megabrain" ] || { printf 'skip: compiled finish binary is missing at %s; run bun run build\n' "$root/.build/megabrain"; exit 0; }
scenario_routes_finish_to_binary
scenario_recorded_parent_controls_base
scenario_unmerged_refusal_and_force
scenario_missing_parent_warns_and_refuses
scenario_branch_selector_without_delete
scenario_explicit_base_is_reported
scenario_invalid_json_refusal
scenario_orca_removal_is_used
printf 'ok: compiled worktree finish contract scenarios\n'
