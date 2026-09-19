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
  env HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state" MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION="$shell_impl" INVOCATION_LOG="$work/${shell_impl}.calls" REPO_LIST_PATH="$work/repo" GH_MODE="${GH_MODE:-success}" PATH="$work/bin:/usr/bin:/bin" "$root/megabrain" "$@"
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
if [ "$1 ${2:-} ${3:-}" = 'repo list --json' ]; then
  printf '{"result":{"repos":[{"displayName":"megabrain","path":"%s"}]}}\n' "$REPO_LIST_PATH"
  exit 0
fi
if [ "$1 ${2:-}" = 'worktree rm' ]; then
  for arg in "$@"; do
    case "$arg" in path:*) /usr/bin/git -C "$REPO_LIST_PATH" worktree remove "${arg#path:}"; exit $? ;; esac
  done
fi
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
assert_env_files_equal() {
  local shell_path="$1" binary_path="$2" shell_files binary_files file
  shell_files="$(cd "$shell_path" && find . -path './.git' -prune -o \( -type f -o -type l \) \( -name '.env' -o \( -name '.env.*' ! -name '.env.example' \) \) -print | sort)"
  binary_files="$(cd "$binary_path" && find . -path './.git' -prune -o \( -type f -o -type l \) \( -name '.env' -o \( -name '.env.*' ! -name '.env.example' \) \) -print | sort)"
  [ "$shell_files" = "$binary_files" ] || fail "env file sets differ: shell=$shell_files binary=$binary_files"
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    cmp -s "$shell_path/$file" "$binary_path/$file" || fail "env file contents differ: $file"
  done <<EOF
$shell_files
EOF
}
scenario_create_copies_env_files() {
  local label="$1" branch_suffix="$2" shell_out binary_out
  rm -f "$work/repo/.env" "$work/repo/.env.example" "$work/repo/.env.local" "$work/repo/apps/web/.env"
  rm -rf "$work/repo/apps"
  case "$label" in
    root)
      printf '%s\n' 'EXAMPLE=1' >"$work/repo/.env"
      printf '%s\n' 'EXAMPLE=ignored' >"$work/repo/.env.example"
      printf '%s\n' 'EXAMPLE=local' >"$work/repo/.env.local"
      ;;
    nested)
      mkdir -p "$work/repo/apps/web"
      printf '%s\n' 'EXAMPLE=1' >"$work/repo/apps/web/.env"
      ;;
  esac
  shell_out="$(run_pair shell worktree create --repo "$work/repo" --branch "feat/env-$branch_suffix-shell" --json)" ||
    fail "$label shell create failed: $shell_out"
  binary_out="$(run_pair binary worktree create --repo "$work/repo" --branch "feat/env-$branch_suffix-binary" --json)" ||
    fail "$label binary create failed: $binary_out"
  assert_env_files_equal "$work/shared/feat-env-$branch_suffix-shell" "$work/shared/feat-env-$branch_suffix-binary"
  printf '%s env files match between shell and binary\n' "$label"
}
assert_create_json_equal() {
  local shell_json="$1" binary_json="$2" shell_keys binary_keys shell_normalized binary_normalized
  shell_keys="$(printf '%s' "$shell_json" | jq -c 'keys')"
  binary_keys="$(printf '%s' "$binary_json" | jq -c 'keys')"
  [ "$shell_keys" = "$binary_keys" ] || fail "create JSON keys differ: shell=$shell_keys binary=$binary_keys"
  shell_normalized="$(printf '%s' "$shell_json" | jq -S 'del(.worktree, .branch)')"
  binary_normalized="$(printf '%s' "$binary_json" | jq -S 'del(.worktree, .branch)')"
  [ "$shell_normalized" = "$binary_normalized" ] || fail "create JSON differs: shell=$shell_normalized binary=$binary_normalized"
}
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
scenario_repo_name_create() {
  local output
  output="$(run_pair binary worktree create --repo megabrain --branch feat/name-binary --json)" ||
    fail "binary repo-name create failed: $output"
  printf '%s' "$output" | jq -e '.baseSource == "local"' >/dev/null ||
    fail "binary repo-name create reported the wrong base source: $output"
  [ -d "$work/shared/feat-name-binary" ] || fail 'binary repo-name create did not create worktree'
  printf 'repo name resolves for binary create\n'
}
scenario_completed_finish_deletes_branch() {
  local output
  git -C "$work/repo" worktree add -q "$work/shared/feat-completed-binary" -b feat/completed-binary main
  printf merged >"$work/shared/feat-completed-binary/merged"
  git -C "$work/shared/feat-completed-binary" add merged
  git -C "$work/shared/feat-completed-binary" commit -qm merged
  git -C "$work/repo" merge --ff-only -q feat/completed-binary
  git -C "$work/repo" branch --merged main | sed 's/^..//' | grep -Fx 'feat/completed-binary' >/dev/null ||
    fail 'fixture did not merge completed binary branch'
  output="$(run_pair binary worktree finish "$work/shared/feat-completed-binary" --delete-branch --json)" ||
    fail "binary completed finish failed: $output"
  printf '%s' "$output" | jq -e '.deleted == true and .branchDeleted == true' >/dev/null ||
    fail "binary completed finish returned unexpected JSON: $output"
  [ ! -d "$work/shared/feat-completed-binary" ] || fail 'binary completed finish left worktree'
  git -C "$work/repo" show-ref --verify --quiet refs/heads/feat/completed-binary &&
    fail 'binary completed finish left branch'
  printf 'completed binary finish removes worktree and branch\n'
}
mkdir -p "$work/home" "$work/state" "$work/repo" "$work/bin"
git init -q "$work/repo"
git -C "$work/repo" config user.email tester@example.com
git -C "$work/repo" config user.name tester
git -C "$work/repo" config init.defaultBranch main
printf base >"$work/repo/base"
git -C "$work/repo" add base
git -C "$work/repo" commit -qm base
printf '%s\n' '.env' '.env.*' '!.env.example' >"$work/repo/.gitignore"
git -C "$work/repo" add .gitignore
git -C "$work/repo" commit -qm 'ignore env files'
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
scenario_repo_name_create
scenario_completed_finish_deletes_branch
scenario_create_copies_env_files none no-env
scenario_create_copies_env_files root root
scenario_create_copies_env_files nested nested

shell_out="$(run_pair shell worktree create --repo "$work/repo" --branch feat/create --base feat/parent --json)"
binary_out="$(run_pair binary worktree create --repo "$work/repo" --branch feat/create2 --base feat/parent --json)"
printf '%s' "$shell_out" | jq -e '.baseSource == "explicit"' >/dev/null || fail "shell explicit base source was not reported: $shell_out"
printf '%s' "$binary_out" | jq -e '.baseSource == "explicit"' >/dev/null || fail "binary explicit base source was not reported: $binary_out"
[ -d "$work/shared/feat-create" ] || fail 'shell create did not create its filesystem effect'
[ -d "$work/shared/feat-create2" ] || fail 'binary create did not create its filesystem effect'
assert_create_json_equal "$shell_out" "$binary_out"
assert_invoked shell 'git -C'
assert_invoked binary 'git -C'

shell_out="$(run_pair shell worktree create --repo "$work/repo" --branch feat/create-parent --base feat/parent --parent "path:$work/repo" --json)"
binary_out="$(run_pair binary worktree create --repo "$work/repo" --branch feat/create-parent2 --base feat/parent --parent "path:$work/repo" --json)"
assert_create_json_equal "$shell_out" "$binary_out"

shell_out="$(run_pair shell worktree create --repo "$work/repo" --branch feat/create-issue --base feat/parent --issue 42 --json)"
binary_out="$(run_pair binary worktree create --repo "$work/repo" --branch feat/create-issue2 --base feat/parent --issue 42 --json)"
assert_create_json_equal "$shell_out" "$binary_out"
printf change >"$work/shared/feat-create/change"
git -C "$work/shared/feat-create" add change && git -C "$work/shared/feat-create" commit -qm change
printf change >"$work/shared/feat-create2/change"
git -C "$work/shared/feat-create2" add change && git -C "$work/shared/feat-create2" commit -qm change
git -C "$work/shared/feat-create" config branch.feat/create.megabrain-parent feat/parent
git -C "$work/shared/feat-create2" config branch.feat/create2.megabrain-parent feat/parent
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

printf 'ok: worktree create compares output, status, and filesystem effects\n'
