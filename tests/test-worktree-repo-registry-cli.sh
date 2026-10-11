#!/usr/bin/env bash
set -euo pipefail

# Scenarios: create resolves a registry-recorded repo name without Orca and when Orca fails;
# an unknown name reports both lookup sources and creates nothing.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-repo-registry.XXXXXX")"
work="$(cd "$work" && pwd -P)"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$work/state"
require_megabrain_test_state
mkdir -p "$work/state" "$work/home" "$work/shared" "$work/bin"
ln -s "$(command -v node)" "$work/bin/node"
trap 'rm -rf "$work"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
repo="$work/repo"
git init -q "$repo"
git -C "$repo" config user.email tester@example.com
git -C "$repo" config user.name tester
git -C "$repo" branch -M main
printf 'base\n' >"$repo/base.txt"
git -C "$repo" add base.txt
git -C "$repo" commit -qm base
git -C "$repo" worktree add -q "$work/shared/known" -b feature/known
printf '%s\n' "$work/shared" >"$work/state/worktree-root"

MEGABRAIN_STATE_DIR="$work/state" REPO="$repo" bun -e '
  import { openDatabase } from "./src/db/db.js";
  import { insertWorktree } from "./src/db/queries/worktrees.js";
  const result = openDatabase({ MEGABRAIN_STATE_DIR: process.env.MEGABRAIN_STATE_DIR });
  if (result.kind !== "ok") throw new Error(result.error);
  insertWorktree(result.value.db, { path: `${process.env.MEGABRAIN_STATE_DIR}/../shared/known`, repo: process.env.REPO, repoName: "Canto", branch: "feature/known", createdAt: "2026-10-01T00:00:00.000Z", createdBy: null, purpose: "registry source", origin: "created", finishedAt: null });
  result.value.db.run("UPDATE worktrees SET repo_name = ?", ["Canto"]);
  result.value.close();
'

run_create() {
  local branch="$1"
  env -i HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state" MEGABRAIN_SESSION_ID=registry-test PATH="$work/bin:/usr/bin:/bin" \
    "$root/.build/megabrain" worktree create --repo Canto --branch "$branch" --json
}

output="$(run_create feature/no-orca)" || fail "repo name did not resolve without Orca: $output"
printf '%s' "$output" | jq -e --arg path "$work/shared/feature-no-orca" '.worktree == $path' >/dev/null || fail "wrong worktree was created: $output"
printf 'create resolves a repo name from the registry without Orca\n'

cat >"$work/bin/orca" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'Orca repository lookup unavailable' >&2
exit 1
EOF
chmod +x "$work/bin/orca"
output="$(run_create feature/orca-fails)" || fail "repo name did not resolve after Orca failed: $output"
printf '%s' "$output" | jq -e --arg path "$work/shared/feature-orca-fails" '.worktree == $path' >/dev/null || fail "wrong worktree was created after Orca failed: $output"
printf 'create resolves a repo name from the registry when Orca fails\n'

set +e
unknown="$(env -i HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state" PATH="$work/bin:/usr/bin:/bin" "$root/.build/megabrain" worktree create --repo UnknownRepo --branch feature/unknown --json 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail 'unknown repository name unexpectedly succeeded'
case "$unknown" in *Orca*registry*) ;; *) fail "error did not name both lookup sources: $unknown" ;; esac
[ ! -e "$work/shared/feature-unknown" ] || fail 'unknown repo lookup left a worktree behind'
printf 'unknown repo errors name Orca and the worktree registry\n'
