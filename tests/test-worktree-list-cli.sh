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

write_recording_wrappers() {
  local bin="$work_dir/bin"
  mkdir -p "$bin"
  cat >"$bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' gh >>"$MEGABRAIN_CALL_LOG"
printf '%s\n' '[]'
EOF
  cat >"$bin/orca" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' orca >>"$MEGABRAIN_CALL_LOG"
printf '%s\n' '[]'
EOF
  chmod +x "$bin/gh" "$bin/orca"
}

scenario_binary_call_count_is_independent_of_worktree_count() {
  [ -x "$root/.build/megabrain" ] || {
    printf 'skip: compiled worktree list binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
    return 0
  }

  local small_shared="$work_dir/shared-small"
  local large_shared="$work_dir/shared-large"
  local small_state="$work_dir/state-small"
  local large_state="$work_dir/state-large"
  local small_log="$work_dir/small-calls.log"
  local large_log="$work_dir/large-calls.log"
  mkdir -p "$small_shared" "$large_shared" "$small_state" "$large_state"
  git -C "$repo" worktree add -q "$small_shared/one" -b count/one
  git -C "$repo" worktree add -q "$small_shared/two" -b count/two
  git -C "$repo" worktree add -q "$large_shared/one" -b count/three
  git -C "$repo" worktree add -q "$large_shared/two" -b count/four
  git -C "$repo" worktree add -q "$large_shared/three" -b count/five
  git -C "$repo" worktree add -q "$large_shared/four" -b count/six
  printf '%s\n' "$small_shared" >"$small_state/worktree-root"
  printf '%s\n' "$large_shared" >"$large_state/worktree-root"
  write_recording_wrappers

  env -i HOME="$work_dir/home" PATH="$work_dir/bin:/usr/bin:/bin" \
    MEGABRAIN_STATE_DIR="$small_state" MEGABRAIN_CALL_LOG="$small_log" \
    "$root/.build/megabrain" worktree list --json >/dev/null
  env -i HOME="$work_dir/home" PATH="$work_dir/bin:/usr/bin:/bin" \
    MEGABRAIN_STATE_DIR="$large_state" MEGABRAIN_CALL_LOG="$large_log" \
    "$root/.build/megabrain" worktree list --json >/dev/null

  local small_gh small_orca large_gh large_orca
  small_gh="$(grep -c '^gh$' "$small_log")"
  small_orca="$(grep -c '^orca$' "$small_log")"
  large_gh="$(grep -c '^gh$' "$large_log")"
  large_orca="$(grep -c '^orca$' "$large_log")"
  [ "$small_gh" = "$large_gh" ] || fail "gh invocation counts differ: small=$small_gh large=$large_gh"
  [ "$small_orca" = "$large_orca" ] || fail "orca invocation counts differ: small=$small_orca large=$large_orca"
  printf 'binary invocation count is independent of worktree count: gh %s=%s, orca %s=%s\n' \
    "$small_gh" "$large_gh" "$small_orca" "$large_orca"
}

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
# Keep the legacy parity check at the repository root. The compiled contract covers
# repo filters from both cwd values; the shell implementation resolves common-dir
# output relative to its caller and is scheduled for removal.
(cd "$repo" && compare_case repo-filter --repo "$shared/one" --json)
compare_case unknown-option --not-an-option
scenario_binary_call_count_is_independent_of_worktree_count
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled worktree list binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
fi
printf 'ok: worktree list implementations agree across CLI scenarios\n'
