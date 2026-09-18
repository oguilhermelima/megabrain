#!/usr/bin/env bash

set -euo pipefail

# Scenarios written before the implementation:
# 1. A --repo path selects every worktree belonging to a fixture repository.
# 2. A --repo name resolves through the Orca repository registry to the same entries.
# 3. Both implementations return JSON entries, rather than relying on their exit status.
# Falsification: run each selector through both implementations, compare their JSON output,
# and require the two expected worktree paths in every result.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-list-repo-filter.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

repo="$work/repo"
shared="$work/shared"
state="$work/state"
bin="$work/bin"
expected_one=""
expected_two=""
mkdir -p "$shared" "$state" "$bin" "$work/home"
git init -q "$repo"
git -C "$repo" config user.email tester@example.com
git -C "$repo" config user.name tester
git -C "$repo" branch -M main
printf 'base\n' >"$repo/base.txt"
git -C "$repo" add base.txt
git -C "$repo" commit -qm base
git -C "$repo" worktree add -q "$shared/one" -b feature/one
git -C "$repo" worktree add -q "$shared/two" -b feature/two
expected_one="$(cd "$shared/one" && pwd -P)"
expected_two="$(cd "$shared/two" && pwd -P)"
printf '%s\n' "$shared" >"$state/worktree-root"

cat >"$bin/orca" <<'EOF'
#!/usr/bin/env bash
if [ "$1 ${2:-} ${3:-}" = 'repo list --json' ]; then
  printf '{"result":{"repos":[{"displayName":"fixture-repo","path":"%s"}]}}\n' "$MEGABRAIN_FIXTURE_REPO"
else
  printf '[]\n'
fi
EOF
cat >"$bin/superset" <<'EOF'
#!/usr/bin/env bash
printf '[]\n'
EOF
cat >"$bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '[]\n'
EOF
chmod +x "$bin/orca" "$bin/superset" "$bin/gh"

run_impl() {
  local implementation="$1" selector="$2"
  if [ "$implementation" = shell ]; then
    env -i HOME="$work/home" PATH="$bin:/usr/bin:/bin" \
      MEGABRAIN_STATE_DIR="$state" MEGABRAIN_FIXTURE_REPO="$repo" \
      MEGABRAIN_WORKTREE_LIST_IMPLEMENTATION=shell \
      "$root/megabrain" worktree list --repo "$selector" --json
  else
    env -i HOME="$work/home" PATH="$bin:/usr/bin:/bin" \
      MEGABRAIN_STATE_DIR="$state" MEGABRAIN_FIXTURE_REPO="$repo" \
      "$root/.build/megabrain" worktree list --repo "$selector" --json
  fi
}

run_case() {
  local label="$1" selector="$2" shell_output binary_output shell_status binary_status shell_count binary_count
  set +e
  shell_output="$(cd "$repo" && run_impl shell "$selector" 2>"$work/$label-shell.err")"
  shell_status=$?
  binary_output="$(cd "$repo" && run_impl binary "$selector" 2>"$work/$label-binary.err")"
  binary_status=$?
  set -e
  if [ -n "$shell_output" ]; then
    shell_count="$(printf '%s' "$shell_output" | jq -r 'if type == "array" then length else 0 end' 2>/dev/null || printf '0')"
  else
    shell_count=0
  fi
  if [ -n "$binary_output" ]; then
    binary_count="$(printf '%s' "$binary_output" | jq -r 'if type == "array" then length else 0 end' 2>/dev/null || printf '0')"
  else
    binary_count=0
  fi
  printf '%s: shell entries=%s status=%s, binary entries=%s status=%s\n' \
    "$label" "$shell_count" "$shell_status" "$binary_count" "$binary_status"
  assert_equal "$shell_status" 0
  assert_equal "$binary_status" 0
  assert_equal "$shell_output" "$binary_output"
  assert_equal "$shell_count" 2
  assert_equal "$binary_count" 2
  printf '%s' "$shell_output" | jq -e --arg one "$expected_one" --arg two "$expected_two" \
    'map(.path) | sort == ([$one, $two] | sort)' >/dev/null ||
    fail "$label did not return the fixture worktrees"
}

[ -x "$root/.build/megabrain" ] || fail "compiled worktree list binary is missing at $root/.build/megabrain"
run_case repo-path "$repo"
run_case repo-name fixture-repo
printf 'ok: worktree list repo filters agree by name and path\n'
