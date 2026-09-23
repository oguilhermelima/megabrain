#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
binary="$root/.build/megabrain"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-create.XXXXXX")"

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

# megabrain_worktree_create (lib/module-worktree.sh) no longer exists anywhere in lib/ (grep:
# zero hits) — deleted with the worktree/spawn TypeScript port (commit 9d24366, "chore(worktree):
# delete the bash spawn and worktree implementations"). `worktree create` is a full binary
# passthrough now (src/cli/commands/worktree-write.ts's executeWorktreeCreate).

bin_dir="$work_dir/bin"
mkdir -p "$bin_dir"
superset_calls="$work_dir/superset-calls"
cat >"$bin_dir/superset" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$superset_calls"
exit 1
EOF
chmod +x "$bin_dir/superset"
cat >"$bin_dir/orca" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = worktree ] && [ "${2:-}" = list ]; then printf '{"worktrees":[]}\n'; exit 0; fi
printf '{}\n'
exit 0
EOF
chmod +x "$bin_dir/orca"

reset_fixture() {
  rm -rf "$work_dir/repo" "$work_dir/shared" "$work_dir/state" "$superset_calls"
  mkdir -p "$work_dir/shared" "$work_dir/state"
  git init -q "$work_dir/repo"
  git -C "$work_dir/repo" config user.email tester@example.com
  git -C "$work_dir/repo" config user.name tester
  git -C "$work_dir/repo" config init.defaultBranch main
  printf 'base\n' >"$work_dir/repo/base.txt"
  git -C "$work_dir/repo" add base.txt
  git -C "$work_dir/repo" commit -qm base
  printf '%s\n' "$work_dir/shared" >"$work_dir/state/worktree-root"
  : >"$superset_calls"
}

run_create() {
  PATH="$bin_dir:$PATH" HOME="$work_dir/home" MEGABRAIN_STATE_DIR="$work_dir/state" \
    "$binary" worktree create --repo "$work_dir/repo" --branch "$1" --json
}

# Scenario: worktree create still makes a real git worktree and reports it, whatever the host.
# Basic shared-root/git-worktree creation is also covered at the unit level by tests/unit/
# worktree-write.test.ts ("creates a missing shared root and uses its resolved but unreal path",
# "creates with the canonical path when the shared root resolves") — this is a black-box
# confirmation the wiring holds end to end through the compiled binary.
reset_fixture
output="$(run_create fix/orca)"
assert_equal "$(printf '%s' "$output" | jq -r '.branch')" fix/orca
[ -d "$work_dir/shared/fix-orca" ] || fail 'git worktree was not created'
printf 'worktree create makes a real git worktree\n'

# FINDING (rule 4, not a test defect — did not touch src/, did not weaken the assertion): the
# shell's megabrain_worktree_create registered a Superset project and workspace when running on a
# Superset host (`superset projects list/create`, `superset workspaces list/create`); the ported
# executeWorktreeCreate (src/cli/commands/worktree-write.ts:633-775, read in full) has no such
# call anywhere in its body — grep for "projects" or "workspaces create" in the file: zero hits.
# Reproduced directly: with a `superset` binary on PATH that would fail loudly if invoked (exits 1
# and logs its call), `worktree create` still exits 0 and reports "workspace": null
# unconditionally, and the call log stays empty — no Superset registration is even attempted,
# regardless of host. This assertion is left failing on purpose; the lead decides whether Superset
# project/workspace registration still needs to exist (e.g. because Superset's own daemon now
# auto-discovers worktrees) or the shell contract this scenario encodes is simply gone.
reset_fixture
output="$(run_create fix/superset)"
assert_equal "$(printf '%s' "$output" | jq -r '.workspace')" workspace-id
calls="$(cat "$superset_calls")"
assert_contains "$calls" 'projects create'
assert_contains "$calls" 'workspaces create'
printf 'Superset registers a project and workspace on worktree create\n'

printf 'ok: worktree creation (one open finding, see report)\n'
