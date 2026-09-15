#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-write.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected '$1' to contain '$2'" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) fail "expected '$1' not to contain '$2'" ;; esac; }
run_pair() {
  local shell_impl="$1"; shift
  env HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION="$shell_impl" INVOCATION_LOG="$work/${shell_impl}.calls" GH_MODE="${GH_MODE:-success}" PATH="$work/bin:/usr/bin:/bin" "$root/megabrain" "$@"
}
run_pair_no_gh() {
  local shell_impl="$1"; shift
  env HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION="$shell_impl" INVOCATION_LOG="$work/${shell_impl}.calls" PATH="/usr/bin:/bin" "$root/megabrain" "$@"
}
run_pair_from() {
  local directory="$1" shell_impl="$2"; shift 2
  (cd "$directory" && run_pair "$shell_impl" "$@")
}
write_fakes() {
  cat >"$work/bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'git' >>"$INVOCATION_LOG"
printf ' %s' "$@" >>"$INVOCATION_LOG"
printf '\n' >>"$INVOCATION_LOG"
exec /usr/bin/git "$@"
EOF
  cat >"$work/bin/orca" <<'EOF'
#!/usr/bin/env bash
printf 'orca' >>"$INVOCATION_LOG"
printf ' %s' "$@" >>"$INVOCATION_LOG"
printf '\n' >>"$INVOCATION_LOG"
exit 1
EOF
  cat >"$work/bin/superset" <<'EOF'
#!/usr/bin/env bash
printf 'superset' >>"$INVOCATION_LOG"
printf ' %s' "$@" >>"$INVOCATION_LOG"
printf '\n' >>"$INVOCATION_LOG"
exit 1
EOF
  cat >"$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf 'gh' >>"$INVOCATION_LOG"
printf ' %s' "$@" >>"$INVOCATION_LOG"
printf '\n' >>"$INVOCATION_LOG"
case "${GH_MODE:-success}:$1 $2" in
  missing:*) exit 127 ;;
  unauthenticated:auth\ status) exit 1 ;;
  success:auth\ status) exit 0 ;;
  success:pr\ create) printf '%s\n' 'https://github.example/pull/7' ;;
esac
EOF
  chmod +x "$work/bin/git" "$work/bin/orca" "$work/bin/superset" "$work/bin/gh"
}
assert_invoked() { assert_contains "$(cat "$work/$1.calls")" "$2"; }
scenario_orchestrate_spawn_keeps_shell_path() {
  local output rc
  : >"$work/binary.calls"
  set +e
  output="$(run_pair binary orchestrate spawn --repo "$work/repo" --branch feat/orchestrate \
    --agent codex --model gpt-5 --effort medium --prompt spawn-test --tmux false --json 2>&1)"
  rc=$?
  set -e
  [ "$rc" -ne 2 ] || fail "orchestrate spawn failed during argument parsing: $output"
  assert_invoked binary 'git -C'
  assert_not_contains "$output" 'unknown worktree create option: --orchestrate'
  printf 'orchestrate spawn reaches the shell create path without invoking the binary\n'
}

scenario_orchestrate_spawn_help_uses_own_usage() {
  local output
  output="$(run_pair binary orchestrate spawn --help 2>&1)" ||
    fail "orchestrate spawn help failed: $output"
  assert_contains "$output" 'Usage: megabrain orchestrate spawn'
  assert_not_contains "$output" 'Usage: megabrain worktree create'
  printf 'orchestrate spawn help uses its own usage\n'
}
mkdir -p "$work/home" "$work/state" "$work/repo" "$work/bin"
git init -q "$work/repo"
git -C "$work/repo" config user.email tester@example.com
git -C "$work/repo" config user.name tester
git -C "$work/repo" config init.defaultBranch main
printf base >"$work/repo/base"
git -C "$work/repo" add base
git -C "$work/repo" commit -qm base
git -C "$work/repo" checkout -qb feat/parent
printf parent >"$work/repo/parent"
git -C "$work/repo" add parent
git -C "$work/repo" commit -qm parent
git -C "$work/repo" checkout -q main
printf '%s\n' "$work/shared" >"$work/state/worktree-root"
write_fakes

export SUPERSET_TERMINAL_ID=parent-terminal
scenario_orchestrate_spawn_keeps_shell_path
scenario_orchestrate_spawn_help_uses_own_usage
unset SUPERSET_TERMINAL_ID

shell_out="$(run_pair shell worktree create --repo "$work/repo" --branch feat/create --base feat/parent --json)"
binary_out="$(run_pair binary worktree create --repo "$work/repo" --branch feat/create2 --base feat/parent --json)"
[ -d "$work/shared/feat-create" ] || fail 'shell create did not create its filesystem effect'
[ -d "$work/shared/feat-create2" ] || fail 'binary create did not create its filesystem effect'
assert_invoked shell 'git -C'
assert_invoked binary 'git -C'
printf change >"$work/shared/feat-create/change"
git -C "$work/shared/feat-create" add change && git -C "$work/shared/feat-create" commit -qm change
printf change >"$work/shared/feat-create2/change"
git -C "$work/shared/feat-create2" add change && git -C "$work/shared/feat-create2" commit -qm change
git -C "$work/shared/feat-create" config branch.feat/create.megabrain-parent feat/parent
git -C "$work/shared/feat-create2" config branch.feat/create2.megabrain-parent feat/parent

set +e
shell_err="$(run_pair shell worktree finish "$work/shared/feat-create" --delete-branch 2>&1)"; shell_rc=$?
binary_err="$(run_pair binary worktree finish "$work/shared/feat-create2" --delete-branch 2>&1)"; binary_rc=$?
set -e
[ "$shell_rc" -eq "$binary_rc" ] || fail 'finish refusal statuses differ'
case "$shell_err" in *unmerged*) ;; *) fail 'shell finish did not refuse unmerged branch' ;; esac
case "$binary_err" in *unmerged*) ;; *) fail 'binary finish did not refuse unmerged branch' ;; esac
[ -d "$work/shared/feat-create" ] && [ -d "$work/shared/feat-create2" ] || fail 'finish refusal removed a worktree'
assert_invoked shell 'git -C'
assert_invoked binary 'git -C'

rm -f "$work/state/worktree-root"
set +e
shell_err="$(run_pair shell worktree pr nao-existe 2>&1)"; shell_rc=$?
binary_err="$(run_pair binary worktree pr nao-existe 2>&1)"; binary_rc=$?
set -e
assert_equal "$shell_rc" "$binary_rc"
assert_equal "$shell_err" "$binary_err"
assert_equal "$shell_err" 'megabrain: worktree not found: nao-existe'

set +e
shell_err="$(run_pair shell worktree finish nao-existe 2>&1)"; shell_rc=$?
binary_err="$(run_pair binary worktree finish nao-existe 2>&1)"; binary_rc=$?
set -e
assert_equal "$shell_rc" "$binary_rc"
assert_equal "$shell_err" "$binary_err"
assert_equal "$shell_err" 'megabrain: worktree not found: nao-existe'

printf '%s\n' "$work/shared" >"$work/state/worktree-root"
set +e
shell_err="$(run_pair shell worktree pr nao-existe 2>&1)"; shell_rc=$?
binary_err="$(run_pair binary worktree pr nao-existe 2>&1)"; binary_rc=$?
set -e
assert_equal "$shell_rc" 1
assert_equal "$binary_rc" 1
assert_equal "$shell_err" "$binary_err"
assert_equal "$shell_err" 'megabrain: worktree not found: nao-existe'

set +e
shell_err="$(run_pair shell worktree pr "$work/shared/feat-create" --base nao-existe 2>&1)"; shell_rc=$?
binary_err="$(run_pair binary worktree pr "$work/shared/feat-create2" --base nao-existe 2>&1)"; binary_rc=$?
set -e
assert_equal "$shell_rc" 1
assert_equal "$binary_rc" 1
assert_equal "$shell_err" "$binary_err"
assert_equal "$shell_err" 'megabrain: pull request base does not exist: nao-existe'

shell_out="$(run_pair_from /tmp shell worktree pr feat/create --json)"
binary_out="$(run_pair_from /tmp binary worktree pr feat/create2 --json)"
assert_equal "$(printf '%s' "$shell_out" | jq -r '.base')" feat/parent
assert_equal "$(printf '%s' "$binary_out" | jq -r '.base')" feat/parent

mv "$work/bin/gh" "$work/bin/gh.missing"
set +e
shell_err="$(run_pair shell worktree pr "$work/shared/feat-create" 2>&1)"; shell_rc=$?
binary_err="$(run_pair binary worktree pr "$work/shared/feat-create2" 2>&1)"; binary_rc=$?
set -e
assert_equal "$shell_rc" 1
assert_equal "$binary_rc" 1
assert_equal "$shell_err" "$binary_err"
assert_equal "$shell_err" 'megabrain: gh CLI is not installed'
mv "$work/bin/gh.missing" "$work/bin/gh"

GH_MODE=unauthenticated
export GH_MODE
set +e
shell_err="$(run_pair shell worktree pr "$work/shared/feat-create" 2>&1)"; shell_rc=$?
binary_err="$(run_pair binary worktree pr "$work/shared/feat-create2" 2>&1)"; binary_rc=$?
set -e
assert_equal "$shell_rc" 1
assert_equal "$binary_rc" 1
assert_equal "$shell_err" "$binary_err"
assert_equal "$shell_err" 'megabrain: gh CLI is not authenticated'

GH_MODE=success
export GH_MODE
shell_out="$(run_pair shell worktree pr "$work/shared/feat-create" --json)"
binary_out="$(run_pair binary worktree pr "$work/shared/feat-create2" --json)"
assert_equal "$(printf '%s' "$shell_out" | jq -r '.branch')" feat/create
assert_equal "$(printf '%s' "$binary_out" | jq -r '.branch')" feat/create2
assert_invoked shell 'gh auth status'
assert_invoked shell 'gh pr create --base feat/parent --head feat/create'
assert_invoked binary 'gh auth status'
assert_invoked binary 'gh pr create --base feat/parent --head feat/create2'

printf 'ok: worktree create and finish compare both output, status, and filesystem effects\n'
