#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
binary="$root/.build/megabrain"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-parent.XXXXXX")"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

[ -x "$binary" ] || {
  printf 'skip: compiled binary is missing at %s; run bun run build\n' "$binary"
  exit 0
}

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

# megabrain_worktree_create and megabrain_superset_tag_from_branch (lib/module-worktree.sh) no
# longer exist anywhere in lib/ (grep: zero hits) — deleted with the worktree/spawn TypeScript
# port. `worktree create` (including --parent handling) is a full binary passthrough
# (src/cli/commands/worktree-write.ts's executeWorktreeCreate/resolveParent).

bin_dir="$work_dir/bin"
mkdir -p "$bin_dir"
calls_log="$work_dir/calls.log"
orca_mode=success

setup_fixture() {
  local branch="${1:-stack/base}" branch_worktree_name
  orca_mode=success
  rm -rf "$work_dir/repo" "$work_dir/shared" "$work_dir/state" "$calls_log"
  mkdir -p "$work_dir/shared" "$work_dir/state"
  repo_dir="$work_dir/repo"
  git init -q "$repo_dir"
  git -C "$repo_dir" config user.email tester@example.com
  git -C "$repo_dir" config user.name tester
  git -C "$repo_dir" config init.defaultBranch main
  printf 'base\n' >"$repo_dir/base.txt"
  git -C "$repo_dir" add base.txt
  git -C "$repo_dir" commit -qm base
  # resolveParent resolves `branch:X` against `git worktree list`, so the parent branch needs a
  # real attached worktree, not just a dangling branch ref -- otherwise the selector can never
  # genuinely resolve and a scenario would only pass by accident (see the fixed defect below).
  branch_worktree_name="$(printf '%s' "$branch" | tr '/' '-')"
  git -C "$repo_dir" worktree add -q "$work_dir/shared/$branch_worktree_name" -b "$branch" 2>/dev/null || true
  printf '%s\n' "$work_dir/shared" >"$work_dir/state/worktree-root"
  : >"$calls_log"
}

run_create() {
  printf '%s\n' "$orca_mode" >"$bin_dir/orca-mode"
  PATH="$bin_dir:$PATH" HOME="$work_dir/home" MEGABRAIN_STATE_DIR="$work_dir/state" \
    "$binary" worktree create --repo "$repo_dir" --branch stack/child "$@" --json
}
# orca reads its mode from a file rather than this script's $orca_mode variable, since each
# run_create call execs a fresh subprocess that cannot see shell variables set here.
cat >"$bin_dir/orca" <<EOF
#!/usr/bin/env bash
printf 'orca %s\n' "\$*" >>"$calls_log"
if [ "\${1:-}" = worktree ] && [ "\${2:-}" = list ]; then printf '{"worktrees":[]}\n'; exit 0; fi
if [ "\${1:-}" = worktree ] && [ "\${2:-}" = set ]; then
  if [ "\$(cat "$bin_dir/orca-mode" 2>/dev/null)" = fail ]; then printf '{"ok":false,"error":"lineage unavailable"}\n'; exit 1; fi
  printf '{"ok":true,"result":{"worktree":{"parentWorktreeId":"parent-id"}}}\n'
  exit 0
fi
printf '{}\n'
exit 0
EOF
chmod +x "$bin_dir/orca"
# Only reached by the Superset-grouping scenario below, which sets SUPERSET_TERMINAL_ID; every
# other scenario has no Superset-hosted identity, so executeWorktreeCreate never calls this.
cat >"$bin_dir/superset" <<EOF
#!/usr/bin/env bash
printf 'superset %s\n' "\$*" >>"$calls_log"
case "\${1:-}:\${2:-}" in
  projects:list) printf '%s\n' '{"projects":[]}' ;;
  projects:create) printf '%s\n' '{"result":{"project":{"id":"project-id"}}}' ;;
  workspaces:list) printf '%s\n' '{"workspaces":[]}' ;;
  workspaces:create) printf '%s\n' '{"result":{"workspace":{"id":"workspace-id"}}}' ;;
  workspaces:update) printf '%s\n' '{"ok":true}' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$bin_dir/superset"

# Scenario: without --parent, no Orca lineage call is made.
# Falsification: a lineage call fires even though nothing requested it.
setup_fixture
output="$(run_create)"
assert_equal "$(printf '%s' "$output" | jq -r '.parent.requested')" false
assert_not_contains "$(cat "$calls_log")" 'orca worktree set'
printf 'without parent, no lineage call is made\n'

# Scenario: --parent sets Orca lineage (git config on the child branch, plus `orca worktree set
# --parent-worktree`) and reports it in the JSON output.
# Falsification: the git config is missing, or the orca call is never made.
setup_fixture
child_path="$work_dir/shared/stack-child"
output="$(run_create --parent "branch:stack/base")"
assert_equal "$(printf '%s' "$output" | jq -r '.parent.requested')" true
assert_equal "$(printf '%s' "$output" | jq -r '.parent.lineage.set')" true
assert_contains "$(cat "$calls_log")" "worktree set --worktree path:$(cd -P "$child_path" && pwd) --parent-worktree branch:stack/base --json"
git -C "$child_path" config --get "branch.stack/child.megabrain-parent" >/dev/null || fail 'parent metadata was not recorded in git config'
printf 'parent sets Orca lineage and records git config metadata\n'

# Scenario: an unresolvable --parent selector is refused with the right message.
# Falsification: the command succeeds, or refuses with a different reason.
# Run from a non-git cwd: resolveParent used to fall back to the *calling process's own* cwd via
# `git -C "" rev-parse --show-toplevel` when a branch selector matched no registered worktree
# (path stayed "" and was used unchecked) — from inside any git checkout that silently "resolved"
# the selector against the caller's unrelated current branch instead of refusing it. Fixed by an
# explicit empty-path guard; the scenario near the end of this file covers the same defect from
# inside a git checkout, plus the worktree-created-before-validation ordering defect.
setup_fixture
non_git_cwd="$work_dir/non-git-cwd"
mkdir -p "$non_git_cwd"
if output="$(cd "$non_git_cwd" && run_create --parent branch:missing 2>&1)"; then
  fail 'unresolvable parent unexpectedly succeeded'
fi
assert_contains "$output" 'parent worktree could not be resolved: branch:missing'
printf 'unresolvable parent is refused with the expected message\n'

# Scenario: an Orca lineage failure is reported but does not block worktree creation.
# Falsification: the worktree is not created, or the failure is silently swallowed.
setup_fixture
orca_mode=fail
output="$(run_create --parent branch:stack/base)"
assert_equal "$(printf '%s' "$output" | jq -r '.parent.lineage.set')" false
[ -d "$work_dir/shared/stack-child" ] || fail 'worktree was not created after Orca decoration failure'
printf 'Orca lineage failure leaves the worktree intact\n'

# Scenario: --parent and --no-parent are mutually exclusive, rejected before any change.
# Falsification: the combination is silently accepted, or a worktree is created anyway.
setup_fixture
if output="$(run_create --parent branch:stack/base --no-parent 2>&1)"; then
  fail '--parent and --no-parent unexpectedly succeeded'
fi
assert_contains "$output" '--parent cannot be combined with --no-parent'
[ ! -e "$work_dir/shared/stack-child" ] || fail 'worktree was created for an invalid option combination'
printf 'parent flags reject contradictory input\n'

# Scenario: a caller running inside a Superset terminal tags the new worktree's Superset
# workspace into its parent's grouping, restoring what the retired shell's
# megabrain_superset_tag_from_branch/megabrain_workspace_create did.
# Falsification: parent.grouping.set stays false, or no `workspaces update --tag` call is made.
setup_fixture
output="$(SUPERSET_TERMINAL_ID=parent-terminal run_create --parent "branch:stack/base")"
assert_equal "$(printf '%s' "$output" | jq -r '.parent.grouping.set')" true
assert_contains "$(cat "$calls_log")" 'workspaces update'
printf 'parent sets Superset workspace grouping\n'

# Scenario: an unresolvable --parent is refused before any change, even from inside a git
# checkout (unlike the scenario above, this cwd genuinely is a git repository, so the fix must be
# the explicit empty-path guard and not an accident of running from a non-git directory).
# Falsification: the command succeeds by resolving against this checkout's own branch instead of
# refusing, or the child worktree/branch exist after the refusal.
setup_fixture
if output="$(run_create --parent branch:definitely-missing 2>&1)"; then
  fail "unresolvable parent succeeded when run from inside a git checkout: $output"
fi
assert_contains "$output" 'parent worktree could not be resolved: branch:definitely-missing'
[ ! -e "$work_dir/shared/stack-child" ] || fail 'child worktree was created before parent validation'
printf 'unresolvable parent is refused even from inside a git checkout, before any change\n'

printf 'ok: worktree parent lineage\n'
