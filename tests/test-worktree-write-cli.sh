#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-write.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
run_pair() {
  local shell_impl="$1"; shift
  env HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION="$shell_impl" "$root/megabrain" "$@"
}
mkdir -p "$work/home" "$work/state" "$work/repo" "$work/bin"
git init -q "$work/repo"
git -C "$work/repo" config user.email tester@example.com
git -C "$work/repo" config user.name tester
git -C "$work/repo" config init.defaultBranch main
printf base >"$work/repo/base"
git -C "$work/repo" add base
git -C "$work/repo" commit -qm base
printf '%s\n' "$work/shared" >"$work/state/worktree-root"

shell_out="$(run_pair shell worktree create --repo "$work/repo" --branch feat/create --json)"
binary_out="$(run_pair binary worktree create --repo "$work/repo" --branch feat/create2 --json)"
[ -d "$work/shared/feat-create" ] || fail 'shell create did not create its filesystem effect'
[ -d "$work/shared/feat-create2" ] || fail 'binary create did not create its filesystem effect'
printf change >"$work/shared/feat-create/change"
git -C "$work/shared/feat-create" add change && git -C "$work/shared/feat-create" commit -qm change
printf change >"$work/shared/feat-create2/change"
git -C "$work/shared/feat-create2" add change && git -C "$work/shared/feat-create2" commit -qm change

set +e
shell_err="$(run_pair shell worktree finish "$work/shared/feat-create" --delete-branch 2>&1)"; shell_rc=$?
binary_err="$(run_pair binary worktree finish "$work/shared/feat-create2" --delete-branch 2>&1)"; binary_rc=$?
set -e
[ "$shell_rc" -eq "$binary_rc" ] || fail 'finish refusal statuses differ'
case "$shell_err" in *unmerged*) ;; *) fail 'shell finish did not refuse unmerged branch' ;; esac
case "$binary_err" in *unmerged*) ;; *) fail 'binary finish did not refuse unmerged branch' ;; esac
[ -d "$work/shared/feat-create" ] && [ -d "$work/shared/feat-create2" ] || fail 'finish refusal removed a worktree'

printf 'ok: worktree create and finish compare both output, status, and filesystem effects\n'
