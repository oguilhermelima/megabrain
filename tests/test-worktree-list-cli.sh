#!/usr/bin/env bash

set -euo pipefail

# Scenarios written before implementation:
# 1. The compiled command reports JSON, flat, and tree output for every fixture worktree.
# 2. The compiled command preserves --repo content when called from the repository root.
# 3. An unknown option remains a usage error.
# Falsification: assert the real paths and status/content of each compiled invocation; a route
# marker or a successful exit without the expected worktrees does not satisfy these scenarios.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-list-cli.XXXXXX")"
work_dir="$(cd "$work_dir" && pwd -P)"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$1' to contain '$2'" ;;
  esac
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
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" gh >>"$MEGABRAIN_CALL_LOG"\nprintf "%%s\\n" '\''[]'\''\n' >"$bin/gh"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" orca >>"$MEGABRAIN_CALL_LOG"\nprintf "%%s\\n" '\''[]'\''\n' >"$bin/orca"
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

run_binary() {
  env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$work_dir" \
    "$root/.build/megabrain" worktree list "$@"
}

[ -x "$root/.build/megabrain" ] || {
  printf 'skip: compiled worktree list binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
}

json_output="$(run_binary --json)"
printf '%s' "$json_output" | jq -e --arg one "$shared/one" --arg two "$shared/two" \
  'map(.path) | sort == ([$one, $two] | sort)' >/dev/null ||
  fail "compiled JSON did not report the fixture worktrees: $json_output"
printf 'compiled JSON output reports both fixture worktrees\n'

flat_output="$(run_binary --flat)"
assert_contains "$flat_output" 'PATH'
assert_contains "$flat_output" "$shared/one"
assert_contains "$flat_output" "$shared/two"
printf 'compiled flat output reports both fixture worktrees\n'

tree_output="$(run_binary --tree)"
assert_contains "$tree_output" 'BRANCH'
assert_contains "$tree_output" "$shared/one"
assert_contains "$tree_output" "$shared/two"
printf 'compiled tree output reports both fixture worktrees\n'

(cd "$repo" && repo_output="$(run_binary --repo "$shared/one" --json)" &&
  # A --repo filter deliberately includes the repository's own main checkout alongside its
  # shared-root worktrees (src/cli/commands/worktree-list.ts:142: entries outside the shared root
  # are skipped only when no --repo filter is given) — the prior version of this assertion
  # expected only the two shared worktrees and failed against the binary's real, intentional
  # output, which is this scenario's actual point ("preserves content from the repository root").
  printf '%s' "$repo_output" | jq -e --arg one "$shared/one" --arg two "$shared/two" --arg repo "$(cd "$repo" && pwd -P)" \
    'map(.path) | sort == ([$one, $two, $repo] | sort)' >/dev/null)
printf 'compiled repo filter preserves content from the repository root\n'

set +e
unknown_output="$(run_binary --not-an-option 2>&1)"
unknown_status=$?
set -e
[ "$unknown_status" -eq 2 ] || fail "unknown option returned $unknown_status"
assert_contains "$unknown_output" 'unknown worktree list option'
printf 'compiled unknown-option handling preserves the usage error\n'

scenario_binary_call_count_is_independent_of_worktree_count
printf 'ok: compiled worktree list CLI scenarios\n'
