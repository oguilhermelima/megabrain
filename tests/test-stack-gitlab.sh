#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-stack-gitlab.XXXXXX")"
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
export GLAB_LOG="$work/glab.log"
export GLAB_LIST_MODE=empty
export GLAB_TRAINS=no
export GLAB_MERGED=no

cat >"$work/bin/glab" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GLAB_LOG"
case "${1:-} ${2:-} ${3:-}" in
  "auth status"*) exit 0 ;;
  "mr list"*)
    case "${GLAB_LIST_MODE:-empty}" in
      empty) printf '[]\n' ;;
      stale) printf '[{"iid":1,"source_branch":"stack/base","target_branch":"main","state":"merged","web_url":"https://gitlab.com/group/project/-/merge_requests/1"},{"iid":2,"source_branch":"stack/child","target_branch":"stack/base","state":"opened","web_url":"https://gitlab.com/group/project/-/merge_requests/2"}]\n' ;;
      open) printf '[{"iid":1,"source_branch":"stack/base","target_branch":"main","state":"opened"},{"iid":2,"source_branch":"stack/child","target_branch":"stack/base","state":"opened"}]\n' ;;
    esac
    ;;
  "mr create"*)
    case "$*" in
      *'--source-branch stack/child'*) printf 'https://gitlab.com/group/project/-/merge_requests/2\n' ;;
      *) printf 'https://gitlab.com/group/project/-/merge_requests/1\n' ;;
    esac
    ;;
  "mr update"*) printf '{}\n' ;;
  "mr merge"*) printf '{}\n' ;;
  "mr view"*)
    if [ "${GLAB_MERGED:-no}" = yes ]; then printf '{"iid":%s,"state":"merged","detailed_merge_status":"merged"}\n' "${3:-1}"; else printf '{"iid":%s,"state":"opened","detailed_merge_status":"mergeable"}\n' "${3:-1}"; fi
    ;;
  "api projects/group/project")
    if [ "${GLAB_TRAINS:-no}" = yes ]; then printf '{"id":42,"merge_trains_enabled":true}\n'; else printf '{"id":42,"merge_trains_enabled":false}\n'; fi
    ;;
  "api"*) printf '[]\n' ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$work/bin/glab"
export PATH="$work/bin:$PATH"

setup_fixture() {
  rm -rf "$work/repo" "$work/remote.git" "$work/shared" "$work/state" "$work/glab.log"
  mkdir -p "$work/shared" "$work/state"
  printf '%s\n' "$work/shared" >"$work/state/worktree-root"
  git init -q --bare "$work/remote.git"
  git init -q -b main "$work/repo"
  git -C "$work/repo" config user.email stack@example.com
  git -C "$work/repo" config user.name Stack
  printf 'base\n' >"$work/repo/README"
  git -C "$work/repo" add README
  git -C "$work/repo" commit -qm base
  git -C "$work/repo" remote add origin git@gitlab.com:group/project.git
  git -C "$work/repo" remote set-url --push origin "$work/remote.git"
  git -C "$work/repo" push -qu origin main
  : >"$GLAB_LOG"
  export GLAB_LIST_MODE=empty GLAB_TRAINS=no GLAB_MERGED=no
}
run() { "$root/.build/megabrain" "$@"; }
create_empty_stack() {
  run stack create stack/base --on main --repo "$work/repo" >/dev/null
  cd "$work/repo"
  printf 'parent layer\n' >"$work/shared/stack-base/parent.txt"
  git -C "$work/shared/stack-base" add parent.txt
  git -C "$work/shared/stack-base" commit -qm parent
  git -C "$work/shared/stack-base" push -qu origin stack/base
  run stack create stack/child --on stack/base >/dev/null
  printf 'child layer\n' >"$work/shared/stack-child/child.txt"
  git -C "$work/shared/stack-child" add child.txt
  git -C "$work/shared/stack-child" commit -qm child
  git -C "$work/shared/stack-child" push -qu origin stack/child
}

# Scenario: GitLab creates one MR per branch and each MR targets its parent.
setup_fixture
create_empty_stack
run stack pr --provider gitlab >/dev/null
contains "$(cat "$GLAB_LOG")" 'mr create --source-branch stack/base --target-branch main'
contains "$(cat "$GLAB_LOG")" 'mr create --source-branch stack/child --target-branch stack/base'
printf 'GitLab creates chained merge requests by target branch\n'

# Scenario: after the parent merges, stale target metadata is corrected and the child rebases.
git -C "$work/repo" checkout -q main
git -C "$work/repo" merge --squash -q stack/base
git -C "$work/repo" commit -qm 'merge parent layer'
git -C "$work/repo" push -qu origin main
export GLAB_LIST_MODE=stale
: >"$GLAB_LOG"
run stack sync --yes --provider gitlab >/dev/null
contains "$(cat "$GLAB_LOG")" 'mr update 2 --target-branch main'
parent_tip="$(git -C "$work/repo" rev-parse origin/main)"
child_base="$(git -C "$work/shared/stack-child" merge-base HEAD origin/main)"
[ "$parent_tip" = "$child_base" ] || fail 'child branch was not rebased onto the merged parent target'
printf 'GitLab sync verifies retargeting and rebases after a parent merge\n'

# Scenario: conflicts stop the sync, name the file, and leave the rebase recoverable.
setup_fixture
run stack create stack/base --on main --repo "$work/repo" >/dev/null
cd "$work/repo"
printf 'parent\n' >"$work/shared/stack-base/conflict.txt"
git -C "$work/shared/stack-base" add conflict.txt
git -C "$work/shared/stack-base" commit -qm parent
git -C "$work/shared/stack-base" push -qu origin stack/base
run stack create stack/child --on stack/base >/dev/null
printf 'child\n' >"$work/shared/stack-child/conflict.txt"
git -C "$work/shared/stack-child" add conflict.txt
git -C "$work/shared/stack-child" commit -qm child
git -C "$work/shared/stack-child" push -qu origin stack/child
printf 'main\n' >"$work/repo/conflict.txt"
git -C "$work/repo" add conflict.txt
git -C "$work/repo" commit -qm main-conflict
git -C "$work/repo" push -qu origin main
if output="$(run stack sync --yes --provider gitlab 2>&1)"; then fail 'conflicting rebase unexpectedly succeeded'; fi
contains "$output" 'conflict.txt'
not_contains "$(git -C "$work/shared/stack-base" status --porcelain)
$(git -C "$work/shared/stack-child" status --porcelain)" 'UU conflict.txt'
printf 'GitLab sync stops at conflicts and names files without leaving a conflicted rebase\n'

# Scenario: GitLab merge refuses local commits that have not been pushed.
setup_fixture
create_empty_stack
printf 'not pushed\n' >"$work/shared/stack-child/local.txt"
git -C "$work/shared/stack-child" add local.txt
git -C "$work/shared/stack-child" commit -qm local-only
if output="$(run stack merge --yes --provider gitlab 2>&1)"; then fail 'GitLab merge accepted unpushed commits'; fi
contains "$output" 'unpushed local commits'
not_contains "$(cat "$GLAB_LOG")" 'mr merge'
printf 'GitLab merge refuses local commits that have not been pushed\n'

# Scenario: projects with merge trains use auto-merge and wait for GitLab's merged state.
setup_fixture
create_empty_stack
run stack pr --provider gitlab >/dev/null
export GLAB_LIST_MODE=open GLAB_TRAINS=yes GLAB_MERGED=yes
: >"$GLAB_LOG"
run stack merge --yes --provider gitlab >/dev/null
contains "$(cat "$GLAB_LOG")" 'mr merge 1 --auto-merge --yes'
contains "$(cat "$GLAB_LOG")" 'mr merge 2 --auto-merge --yes'
printf 'GitLab merge queues every layer and waits for the merged state\n'
