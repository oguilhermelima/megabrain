#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-base.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export MEGABRAIN_STATE_DIR="$work/state"
source "$root/tests/fixtures/entrypoint-routing.sh"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected '$1' to contain '$2'" ;; esac; }
json() { printf '%s' "$1" | jq -e "$2" >/dev/null || fail "JSON assertion failed: $2 ($1)"; }

git init -q --bare "$work/origin"
git clone -q "$work/origin" "$work/seed"
git -C "$work/seed" config user.email tester@example.com
git -C "$work/seed" config user.name tester
printf 'v1\n' >"$work/seed/version"
git -C "$work/seed" add version && git -C "$work/seed" commit -qm v1
git -C "$work/seed" branch -M main && git -C "$work/seed" push -q -u origin main
git -C "$work/seed" symbolic-ref HEAD refs/heads/main
printf 'v2\n' >"$work/seed/version"
git -C "$work/seed" commit -qam v2 && git -C "$work/seed" push -q
git clone -q "$work/origin" "$work/repo"
git -C "$work/repo" config user.email tester@example.com
git -C "$work/repo" config user.name tester
git -C "$work/repo" reset -q --hard HEAD~1
git -C "$work/repo" fetch -q origin main
git -C "$work/repo" switch -qc feat/stack
printf 'feature\n' >"$work/repo/feature"
git -C "$work/repo" add feature && git -C "$work/repo" commit -qm feature
git -C "$work/repo" switch -q main
mkdir -p "$work/state" "$work/shared"
printf '%s\n' "$work/shared" >"$work/state/worktree-root"
remote_tip="$(git -C "$work/repo" rev-parse origin/main)"
feature_tip="$(git -C "$work/repo" rev-parse feat/stack)"

run_shell() {
  MEGABRAIN_ROOT="$root" HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state" \
    MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=shell "$root/megabrain" "$@"
}
run_binary() {
  MEGABRAIN_ROOT="$root" HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state" \
    "$root/.build/megabrain" "$@"
}

create_and_assert() {
  local implementation="$1" branch="$2" output path
  if [ "$implementation" = shell ]; then
    output="$(run_shell worktree create --repo "$work/repo" --branch "$branch" --json)"
  else
    output="$(run_binary worktree create --repo "$work/repo" --branch "$branch" --json)"
  fi
  path="$work/shared/${branch//\//-}"
  json "$output" ".base == \"origin/main\" and .baseCommit == \"$remote_tip\" and .baseSource == \"remote\""
  assert_equal "$(git -C "$path" rev-parse HEAD)" "$remote_tip"
  assert_contains "$output" 'origin/main'
  assert_contains "$output" "$remote_tip"
  printf '%s default base output: %s\n' "$implementation" "$output"
}

create_and_assert shell feat/default-shell
create_and_assert binary feat/default-binary
human_output="$(run_binary worktree create --repo "$work/repo" --branch feat/human-binary --from feat/stack)"
assert_contains "$human_output" 'base: feat/stack'
assert_contains "$human_output" "base commit: $feature_tip"
printf 'binary human create output: %s' "$human_output"

from_output="$(run_binary worktree create --repo "$work/repo" --branch feat/from-binary --from feat/stack --json)"
json "$from_output" ".base == \"feat/stack\" and .baseCommit == \"$feature_tip\" and .baseSource == \"explicit\""
assert_equal "$(git -C "$work/shared/feat-from-binary" rev-parse HEAD)" "$feature_tip"
assert_contains "$from_output" 'feat/stack'
assert_contains "$from_output" "$feature_tip"
printf 'binary --from output: %s\n' "$from_output"
from_output="$(run_shell worktree create --repo "$work/repo" --branch feat/from-shell --from feat/stack --json)"
json "$from_output" ".base == \"feat/stack\" and .baseCommit == \"$feature_tip\" and .baseSource == \"explicit\""
assert_equal "$(git -C "$work/shared/feat-from-shell" rev-parse HEAD)" "$feature_tip"
printf 'shell --from output: %s\n' "$from_output"
human_output="$(run_shell worktree create --repo "$work/repo" --branch feat/human-shell --from feat/stack)"
assert_contains "$human_output" 'base: feat/stack'
assert_contains "$human_output" "base commit: $feature_tip"
printf 'human create output: %s' "$human_output"

isolation_fixture="$work/isolation-fixture"
make_binary_isolation_fixture "$root" "$isolation_fixture" 97
output="$(MEGABRAIN_ROOT="$isolation_fixture" HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state" \
  "$isolation_fixture/.build/megabrain" worktree create --repo "$work/repo" --branch feat/stub-proof --from feat/stack --json 2>&1)" ||
  fail 'binary create depends on the shell entrypoint'
json "$output" ".base == \"feat/stack\" and .baseCommit == \"$feature_tip\" and .baseSource == \"explicit\""
assert_contains "$output" 'base'
printf 'binary create remains independent of a failing shell entrypoint\n'

git -C "$work/repo" symbolic-ref --delete refs/remotes/origin/HEAD
printf 'v3\n' >"$work/seed/version"
git -C "$work/seed" commit -qam v3 && git -C "$work/seed" push -q
remote_tip_without_head="$(git -C "$work/seed" rev-parse HEAD)"

create_without_origin_head() {
  local implementation="$1" branch="$2" output path
  if [ "$implementation" = shell ]; then
    output="$(run_shell worktree create --repo "$work/repo" --branch "$branch" --json)"
  else
    output="$(run_binary worktree create --repo "$work/repo" --branch "$branch" --json)"
  fi
  path="$work/shared/${branch//\//-}"
  json "$output" ".base == \"origin/main\" and .baseCommit == \"$remote_tip_without_head\" and .baseSource == \"remote\""
  assert_equal "$(git -C "$path" rev-parse HEAD)" "$remote_tip_without_head"
  printf '%s missing origin HEAD output: %s\n' "$implementation" "$output"
}

create_without_origin_head shell feat/missing-head-shell
create_without_origin_head binary feat/missing-head-binary

git -C "$work/repo" remote set-url origin "$work/missing-origin"
if output="$(run_binary worktree create --repo "$work/repo" --branch feat/fetch-failure --json 2>&1)"; then
  fail 'create succeeded after the default fetch failed'
fi
assert_contains "$output" 'fetch'
[ ! -e "$work/shared/feat-fetch-failure" ] || fail 'fetch failure created a worktree'
printf 'default fetch failure refuses without creating a worktree\n'

printf 'ok: worktree base resolution reaches remote tips and explicit refs\n'
