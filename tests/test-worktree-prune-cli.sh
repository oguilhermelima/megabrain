#!/usr/bin/env bash
set -euo pipefail

# Scenarios: dry-run is the default; dirty, unpushed, unmerged and open-dispatch trees are
# refused; --yes removes only an old, clean, pushed branch merged into its base.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-prune.XXXXXX")"
work="$(cd "$work" && pwd -P)"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$work/state"
require_megabrain_test_state
node_bin="$(dirname "$(command -v node)")"
mkdir -p "$work/state" "$work/home" "$work/shared" "$work/bin"
cat >"$work/bin/orca" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = worktree ] && [ "${2:-}" = rm ]; then
  git -C "$PRUNE_REPO" worktree remove "${4#path:}"
  exit $?
fi
printf '%s\n' '[]'
EOF
chmod +x "$work/bin/orca"
cat >"$work/bin/du" <<'EOF'
#!/usr/bin/env bash
if mkdir "$PRUNE_ACTIVE_DU" 2>/dev/null; then
  sleep 0.25
  rmdir "$PRUNE_ACTIVE_DU"
else
  : >"$PRUNE_DU_OVERLAP"
fi
exec /usr/bin/du -sk "$@"
EOF
chmod +x "$work/bin/du"
cat >"$work/bin/git" <<'EOF'
#!/usr/bin/env bash
if [ "${PRUNE_DELAY_GIT:-0}" = "1" ] && [[ " $* " == *" worktree list --porcelain "* ]]; then
  exec /bin/sleep 6
fi
exec /usr/bin/git "$@"
EOF
chmod +x "$work/bin/git"
trap 'remove_test_dir "$work"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
repo="$work/repo"
git init -q --bare "$work/remote.git"
git init -q "$repo"
git -C "$repo" config user.email tester@example.com
git -C "$repo" config user.name tester
git -C "$repo" branch -M main
printf 'base\n' >"$repo/base.txt"
git -C "$repo" add base.txt
git -C "$repo" commit -qm base
git -C "$repo" remote add origin "$work/remote.git"
git -C "$repo" push -qu origin main
git -C "$repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
printf '%s\n' "$work/shared" >"$work/state/worktree-root"

add_tree() {
  local name="$1" branch="$2"
  git -C "$repo" worktree add -q "$work/shared/$name" -b "$branch" main
  git -C "$work/shared/$name" push -qu -u origin "$branch"
}
add_tree eligible prune/eligible
printf 'merged\n' >"$work/shared/eligible/eligible.txt"
git -C "$work/shared/eligible" add eligible.txt
git -C "$work/shared/eligible" commit -qm eligible
git -C "$work/shared/eligible" push -qu origin prune/eligible
git -C "$repo" merge -q --ff-only prune/eligible
git -C "$repo" push -qu origin main
git -C "$work/shared/eligible" merge -q --ff-only main
git -C "$work/shared/eligible" push -qu origin prune/eligible

add_tree eligible2 prune/eligible2
printf 'merged two\n' >"$work/shared/eligible2/eligible2.txt"
git -C "$work/shared/eligible2" add eligible2.txt
git -C "$work/shared/eligible2" commit -qm eligible2
git -C "$work/shared/eligible2" push -qu origin prune/eligible2
git -C "$repo" merge -q --ff-only prune/eligible2
git -C "$repo" push -qu origin main
git -C "$work/shared/eligible2" merge -q --ff-only main
git -C "$work/shared/eligible2" push -qu origin prune/eligible2

add_tree dirty prune/dirty
printf 'dirty\n' >>"$work/shared/dirty/base.txt"
add_tree unpushed prune/unpushed
printf 'unpushed\n' >"$work/shared/unpushed/unpushed.txt"
git -C "$work/shared/unpushed" add unpushed.txt
git -C "$work/shared/unpushed" commit -qm unpushed
add_tree unmerged prune/unmerged
printf 'unmerged\n' >"$work/shared/unmerged/unmerged.txt"
git -C "$work/shared/unmerged" add unmerged.txt
git -C "$work/shared/unmerged" commit -qm unmerged
git -C "$work/shared/unmerged" push -qu origin prune/unmerged
add_tree open prune/open

MEGABRAIN_STATE_DIR="$work/state" REPO="$repo" ROOT="$work/shared" bun -e '
  import { guardedOpenDatabase } from "./tests/unit/state-db-guard.js";
  import { insertWorktree } from "./src/db/queries/worktrees.js";
  import { insertDispatch } from "./src/db/queries/dispatches.js";
  const handle = guardedOpenDatabase({ MEGABRAIN_STATE_DIR: process.env.MEGABRAIN_STATE_DIR });
  if (handle.kind !== "ok") throw new Error(handle.error);
  const db = handle.value.db;
  for (const [name, branch] of [["eligible", "prune/eligible"], ["eligible2", "prune/eligible2"], ["dirty", "prune/dirty"], ["unpushed", "prune/unpushed"], ["unmerged", "prune/unmerged"], ["open", "prune/open"]]) {
    const path = `${process.env.ROOT}/${name}`;
    insertWorktree(db, { path, repo: process.env.REPO, repoName: "repo", branch, createdAt: "2020-01-01T00:00:00.000Z", createdBy: "test", purpose: `purpose ${name}`, origin: "created", finishedAt: null });
  }
  insertDispatch(db, { dispatchId: "open-worktree-dispatch", state: "running", worktreePath: `${process.env.ROOT}/open` });
  handle.value.close();
'

run() { env -i HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state" PRUNE_REPO="$repo" PRUNE_ACTIVE_DU="$work/active-du" PRUNE_DU_OVERLAP="$work/du-overlap" PRUNE_DELAY_GIT="${PRUNE_DELAY_GIT:-0}" PATH="$work/bin:$node_bin:/usr/bin:/bin" "$root/.build/megabrain" worktree prune "$@"; }
before="$(git -C "$repo" worktree list --porcelain | shasum -a 256)"
dry="$(run --older-than 1 --json)" || fail 'default prune dry-run failed'
printf '%s' "$dry" | jq -e '
  .dryRun == true and .removed == [] and
  ([.candidates[] | select(.path | endswith("/eligible"))][0] | .eligible == true and .purpose == "purpose eligible" and .sizeBytes > 0) and
  ([.candidates[] | select(.path | endswith("/dirty"))][0].reason | contains("uncommitted")) and
  ([.candidates[] | select(.path | endswith("/unpushed"))][0].reason | contains("unpushed")) and
  ([.candidates[] | select(.path | endswith("/unmerged"))][0].reason | contains("merged")) and
  ([.candidates[] | select(.path | endswith("/open"))][0].reason | contains("dispatch"))
' >/dev/null || fail "dry-run candidate report was incomplete: $dry"
after="$(git -C "$repo" worktree list --porcelain | shasum -a 256)"
[ "$before" = "$after" ] || fail 'default prune changed the worktree set'
[ -f "$work/du-overlap" ] || fail 'candidate assessment did not overlap independent size checks'
printf 'dry-run reports each candidate and preserves all worktrees\n'

removed="$(run --older-than 1 --yes --json)" || fail 'confirmed prune failed'
printf '%s' "$removed" | jq -e '(.removed | length) == 2 and ([.removed[].path | endswith("/eligible") or endswith("/eligible2")] | all)' >/dev/null || fail "prune removed the wrong candidates: $removed"
for name in eligible eligible2; do
  [ ! -e "$work/shared/$name" ] || fail "$name worktree still exists after prune"
  git -C "$repo" show-ref --verify --quiet "refs/heads/prune/$name" && fail "$name merged branch was not deleted"
done
for name in dirty unpushed unmerged open; do [ -d "$work/shared/$name" ] || fail "$name worktree was removed despite being ineligible"; done
printf 'confirmed prune removes only eligible worktrees and merged branches\n'

started="$(date +%s)"
if delayed="$(PRUNE_DELAY_GIT=1 run --repo "$repo" --json 2>&1)"; then fail 'a timed-out Git worktree query succeeded'; fi
elapsed=$(( $(date +%s) - started ))
[[ "$delayed" == *"timed out"* ]] || fail "timed-out Git query did not report its deadline: $delayed"
[ "$elapsed" -lt 5 ] || fail "Git worktree query exceeded its deadline: ${elapsed}s"
printf 'prune stops a slow Git query at its deadline\n'
