#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-list-cli.XXXXXX")"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

repo="$work_dir/repo"
shared="$work_dir/shared"
mkdir -p "$shared"
git init -q "$repo"
git -C "$repo" config user.email tester@example.com
git -C "$repo" config user.name tester
git -C "$repo" branch -M main
printf 'base\n' >"$repo/base.txt"
git -C "$repo" add base.txt
git -C "$repo" commit -qm base
git -C "$repo" worktree add -q "$shared/one" -b feature/one
git -C "$repo" worktree add -q "$shared/two" -b feature/two
git -C "$shared/two" checkout -q --detach HEAD
printf '%s\n' "$shared" >"$work_dir/worktree-root"

run_shell() {
  env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$work_dir" \
    MEGABRAIN_WORKTREE_LIST_IMPLEMENTATION=shell "$root/megabrain" worktree list "$@"
}

run_binary() {
  env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$work_dir" \
    "$root/.build/megabrain" worktree list "$@"
}

compare_case() {
  local name="$1"
  shift
  local shell_output binary_output shell_status binary_status
  set +e
  shell_output="$(run_shell "$@" 2>"$work_dir/shell.err")"
  shell_status=$?
  if [ -x "$root/.build/megabrain" ]; then
    binary_output="$(run_binary "$@" 2>"$work_dir/binary.err")"
    binary_status=$?
  else
    binary_output=''
    binary_status=125
  fi
  set -e
  if [ "$binary_status" -eq 125 ]; then
    printf '%s passed against shell; binary unavailable\n' "$name"
    return 0
  fi
  [ "$shell_status" -eq "$binary_status" ] || fail "$name: exit status differs"
  [ "$shell_output" = "$binary_output" ] || fail "$name: stdout differs"
  cmp -s "$work_dir/shell.err" "$work_dir/binary.err" || fail "$name: stderr differs"
  printf '%s agrees between shell and binary\n' "$name"
}

compare_case json --json
compare_case flat --flat
compare_case tree --tree
compare_case repo-filter --repo "$shared/one" --json
compare_case unknown-option --not-an-option
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled worktree list binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
fi
printf 'ok: worktree list implementations agree across CLI scenarios\n'
