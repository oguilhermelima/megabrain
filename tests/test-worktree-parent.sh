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
  local branch="${1:-stack/base}"
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
  git -C "$repo_dir" branch "$branch" 2>/dev/null || true
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
# Run from a non-git cwd, deliberately: resolveParent (worktree-write.ts:532-579) falls back to
# the *calling process's own* cwd via `git -C "" rev-parse --show-toplevel` when a branch selector
# matches no registered worktree (path stays "" and is used unchecked) — from inside any git
# checkout (this repo included) that silently "resolves" the selector against the caller's
# unrelated current branch instead of refusing it at all. See the FINDING below, which covers this
# precisely and also covers the fact that (even once correctly refused) the worktree it "fails" on
# was already created before the refusal — this scenario only checks the message.
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

# FINDING (rule 4, not a test defect — did not touch src/, did not weaken the assertion):
# consistent with the same gap found in tests/test-worktree-create.sh (no Superset project/
# workspace registration at all any more), executeWorktreeCreate also never calls `superset
# workspaces update --tag ...` to group a child worktree's Superset workspace under its parent's —
# megabrain_superset_tag_from_branch (the shell's tag-sanitizing helper) no longer exists at all
# (grep: zero hits), and grep for "--tag"/"workspaces update" in worktree-write.ts: zero hits. The
# JSON output always reports parent.grouping as {set: false, error: null}. Left failing on
# purpose; the lead decides whether Superset workspace grouping is meant to be gone too. Placed
# last so every other scenario above still runs and reports.
setup_fixture
output="$(run_create --parent "branch:stack/base")"
assert_equal "$(printf '%s' "$output" | jq -r '.parent.grouping.set')" true
printf 'parent sets Superset workspace grouping\n'

# FINDING (rule 4, not a test defect — did not touch src/, did not weaken any assertion): two
# related defects in resolveParent / executeWorktreeCreate (worktree-write.ts, read in full).
#
# (a) resolveParent (lines 532-579) resolves `--parent branch:X` by searching `git worktree list
# --porcelain` for a worktree whose branch matches X; if none match, `path` is left as the empty
# string "" and used unchecked in `git -C "" rev-parse --show-toplevel` / `git -C "" symbolic-ref
# --short HEAD`. Git treats `-C ""` as no -C at all, so both commands run against the *calling
# process's own* cwd instead of failing — from inside any git checkout (this repo included, or the
# caller's own worktree in real use) an unresolvable selector silently "resolves" to whatever
# branch that unrelated repo is on. Reproduced directly: from inside this repo's own checkout,
# `megabrain worktree create --repo <repo> --branch x --parent branch:definitely-missing --json`
# exits 0 with parent.branch/parent.tag set to this checkout's own current branch, not a refusal.
#
# (b) even once genuinely refused (e.g. from a non-git cwd, as the scenario above does),
# executeWorktreeCreate calls `git worktree add` (line ~659) before it ever looks at
# `value.parent` (the `if (value.parent !== undefined)` branch starts at line ~700) — so an
# unresolvable --parent leaves the git worktree (and branch) behind instead of failing before any
# change, unlike the shell's preflight-validated contract this file used to assert.
#
# Left failing on purpose; the lead decides whether these need an explicit empty-path guard and a
# parent-preflight-before-worktree-add reorder.
setup_fixture
if output="$(run_create --parent branch:definitely-missing 2>&1)"; then
  fail "unresolvable parent succeeded when run from inside a git checkout: $output"
fi
[ ! -e "$work_dir/shared/stack-child" ] || fail 'child worktree was created before parent validation'
printf 'unresolvable parent is refused even from inside a git checkout, before any change\n'

printf 'ok: worktree parent lineage (open findings, see report)\n'
