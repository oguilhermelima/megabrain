#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-stack-github.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$work/state"
require_megabrain_test_state
trap 'rm -rf "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
contains() { case "$1" in *"$2"*) ;; *) fail "expected '$1' to contain '$2'" ;; esac; }
not_contains() { case "$1" in *"$2"*) fail "expected '$1' not to contain '$2'" ;; *) ;; esac; }

export HOME="$work/home"
mkdir -p "$HOME" "$work/bin" "$work/shared" "$work/state"
printf '%s\n' "$work/shared" >"$work/state/worktree-root"
export GH_LOG="$work/gh.log"
export GH_NATIVE=yes
export GH_UNPUSHED=no

cat >"$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
case "${1:-} ${2:-} ${3:-}" in
  "auth status "*) exit 0 ;;
  "api repos/owner/repo/stacks"*)
    if [ "${GH_NATIVE:-yes}" = yes ]; then printf '[]\n'; else exit 1; fi
    ;;
  "api --method POST"*) printf '{"number":12}\n' ;;
  "pr list"*) printf '[]\n' ;;
  "pr create"*)
    number=12
    case "$*" in *'--head stack/child'*) number=13 ;; esac
    printf 'https://github.com/owner/repo/pull/%s\n' "$number"
    ;;
  "pr view"*) printf '{"number":12,"state":"OPEN","baseRefName":"main","headRefName":"stack/base","url":"https://github.com/owner/repo/pull/12"}\n' ;;
  "pr edit"*) printf '{}\n' ;;
  "pr merge"*) printf '{}\n' ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"

git init -q --bare "$work/remote.git"
git init -q -b main "$work/repo"
git -C "$work/repo" config user.email stack@example.com
git -C "$work/repo" config user.name Stack
printf 'base\n' >"$work/repo/base.txt"
git -C "$work/repo" add base.txt
git -C "$work/repo" commit -qm base
git -C "$work/repo" remote add origin git@github.com:owner/repo.git
git -C "$work/repo" remote set-url --push origin "$work/remote.git"
git -C "$work/repo" push -qu "$work/remote.git" main

run() { "$root/.build/megabrain" "$@"; }

# Scenario: native GitHub capability is detected and the PR chain becomes a native stack.
run stack create stack/base --on main --repo "$work/repo" >/dev/null
cd "$work/repo"
printf 'base change\n' >"$work/shared/stack-base/base.txt"
git -C "$work/shared/stack-base" add base.txt
git -C "$work/shared/stack-base" commit -qm 'base change'
git -C "$work/shared/stack-base" push -qu origin stack/base
run stack create stack/child --on stack/base >/dev/null
printf 'child change\n' >"$work/shared/stack-child/child.txt"
git -C "$work/shared/stack-child" add child.txt
git -C "$work/shared/stack-child" commit -qm 'child change'
git -C "$work/shared/stack-child" push -qu origin stack/child
run stack pr >/dev/null
contains "$(cat "$GH_LOG")" 'POST repos/owner/repo/stacks'
contains "$(cat "$GH_LOG")" 'pull_requests'
printf 'GitHub creates native stacks after opening dependent pull requests\n'

# Scenario: unsupported stacks use chained PR bases and include their position in the body.
export GH_NATIVE=no
: >"$GH_LOG"
run stack pr >/dev/null
contains "$(cat "$GH_LOG")" '--base stack/base'
contains "$(cat "$GH_LOG")" 'Stack: 2/'
not_contains "$(cat "$GH_LOG")" 'POST /repos/owner/repo/stacks'
printf 'GitHub falls back to chained PRs when the stack API is unavailable\n'

# Scenario: sync and merge require explicit confirmation before any mutation.
: >"$GH_LOG"
if run stack sync >"$work/sync.out" 2>&1; then fail 'stack sync without --yes unexpectedly succeeded'; fi
contains "$(cat "$work/sync.out")" '--yes'
if run stack merge >"$work/merge.out" 2>&1; then fail 'stack merge without --yes unexpectedly succeeded'; fi
contains "$(cat "$work/merge.out")" '--yes'
not_contains "$(cat "$GH_LOG")" 'pr merge'
printf 'GitHub sync and merge show a plan and refuse mutation without --yes\n'

# Scenario: never merge a branch with commits that have not been pushed.
export GH_UNPUSHED=yes
printf 'local-only commit\n' >"$work/shared/stack-child/local-only.txt"
git -C "$work/shared/stack-child" add local-only.txt
git -C "$work/shared/stack-child" commit -qm 'local only'
: >"$GH_LOG"
if run stack merge --yes >"$work/unpushed.out" 2>&1; then fail 'stack merge accepted unpushed commits'; fi
contains "$(cat "$work/unpushed.out")" 'unpushed local commits'
not_contains "$(cat "$GH_LOG")" 'pr merge'
printf 'GitHub merge refuses local commits that have not been pushed\n'
