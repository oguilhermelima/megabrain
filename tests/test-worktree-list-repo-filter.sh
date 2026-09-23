#!/usr/bin/env bash

set -euo pipefail

# Scenarios written before the implementation:
# 1. A --repo path selects every worktree belonging to a fixture repository, including the
#    repository's own checkout.
# 2. A --repo name resolves through the Orca repository registry to the same entries.
# 3. The compiled implementation returns the same entries from the repository root and a worktree.
# Falsification: run both selectors from both working directories and require the repo's own
# checkout plus the two linked worktree paths in every result.
#
# --repo now also returns the repository's own checkout, not just worktrees under the shared
# root: 46b1a10 (fix(worktree): ask git for a named repo) dropped the inSharedRoot filter
# whenever --repo is given (src/cli/commands/worktree-list.ts), so `git worktree list` for the
# selected repository is returned in full rather than intersected with the shared root.

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
repo="$(cd "$repo" && pwd -P)"
shared="$(cd "$shared" && pwd -P)"
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

run_binary() {
  local cwd="$1" selector="$2"
  (cd "$cwd" && env -i HOME="$work/home" PATH="$bin:/usr/bin:/bin" \
    MEGABRAIN_STATE_DIR="$state" MEGABRAIN_FIXTURE_REPO="$repo" \
    "$root/.build/megabrain" worktree list --repo "$selector" --json)
}

run_case() {
  local label="$1" cwd="$2" selector="$3" output status count
  set +e
  output="$(run_binary "$cwd" "$selector" 2>"$work/$label-binary.err")"
  status=$?
  set -e
  if [ -n "$output" ]; then
    count="$(printf '%s' "$output" | jq -r 'if type == "array" then length else 0 end' 2>/dev/null || printf '0')"
  else
    count=0
  fi
  printf '%s: entries=%s status=%s\n' "$label" "$count" "$status"
  assert_equal "$status" 0
  assert_equal "$count" 3
  printf '%s' "$output" | jq -e --arg repo "$repo" --arg one "$expected_one" --arg two "$expected_two" \
    'map(.path) | sort == ([$repo, $one, $two] | sort)' >/dev/null ||
    fail "$label did not return the fixture repo checkout and its worktrees"
}

[ -x "$root/.build/megabrain" ] || fail "compiled worktree list binary is missing at $root/.build/megabrain"
run_case root-repo-path "$repo" "$repo"
run_case worktree-repo-path "$shared/one" "$repo"
run_case root-repo-name "$repo" fixture-repo
run_case worktree-repo-name "$shared/one" fixture-repo
printf 'ok: compiled worktree list repo filters are independent of cwd\n'
