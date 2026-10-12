#!/usr/bin/env bash
set -euo pipefail

# Scenarios: create records purpose and caller identity; adopt records adopted provenance;
# finish retains the registry entry and timestamps it instead of deleting history.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worktree-registry.XXXXXX")"
work="$(cd "$work" && pwd -P)"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$work/state"
require_megabrain_test_state
mkdir -p "$work/state" "$work/home" "$work/shared" "$work/bin"
node_bin="$(dirname "$(command -v node)")"
trap 'remove_test_dir "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
repo="$work/repo"
git init -q "$repo"
git -C "$repo" config user.email tester@example.com
git -C "$repo" config user.name tester
git -C "$repo" branch -M main
printf 'base\n' >"$repo/base.txt"
git -C "$repo" add base.txt
git -C "$repo" commit -qm base
printf '%s\n' "$work/shared" >"$work/state/worktree-root"

cat >"$work/bin/superset" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "workspaces list --local --json") printf '%s\n' '[]' ;;
  "projects list --json") printf '%s\n' '{"result":{"projects":[{"id":"project-id","path":"'"$REGISTRY_REPO"'"}]}}' ;;
  "workspaces create --local --project project-id --branch feature/adopted --name adopted --json") printf '%s\n' '{"result":{"workspace":{"id":"workspace-id"}}}' ;;
  *) printf 'unexpected superset call: %s\n' "$*" >&2; exit 1 ;;
esac
EOF
cat >"$work/bin/orca" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = worktree ] && [ "${2:-}" = rm ]; then
  target="${4#path:}"
  git -C "$REGISTRY_REPO" worktree remove "$target"
  exit $?
fi
printf '%s\n' '[]'
EOF
chmod +x "$work/bin/superset" "$work/bin/orca"
run() { env -i HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state" MEGABRAIN_SESSION_ID=session-registry REGISTRY_REPO="$repo" PATH="$work/bin:$node_bin:/usr/bin:/bin" "$root/.build/megabrain" "$@"; }
assert_db() {
  MEGABRAIN_STATE_DIR="$work/state" EXPECTED="$1" bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env.MEGABRAIN_STATE_DIR + "/megabrain.db"); const rows = db.query("SELECT path, repo, branch, purpose, origin, created_by, finished_at FROM worktrees ORDER BY path").all(); const expected = JSON.parse(process.env.EXPECTED); if (JSON.stringify(rows) !== JSON.stringify(expected)) { console.error(JSON.stringify(rows)); process.exit(1); } db.close();' || fail 'registry contents did not match expected lifecycle state'
}

run worktree create --repo "$repo" --branch feature/created --label 'Registry feature' --json >/dev/null
created="$work/shared/feature-created"
expected="$(jq -cn --arg path "$created" --arg repo "$repo" '[{path:$path,repo:$repo,branch:"feature/created",purpose:"Registry feature",origin:"created",created_by:"session-registry",finished_at:null}]')"
assert_db "$expected"
printf 'worktree create writes purpose, origin and session identity\n'

adopted="$work/shared/adopted"
git -C "$repo" worktree add -q "$adopted" -b feature/adopted
run worktree adopt "$adopted" --json >/dev/null
expected="$(jq -cn --arg created "$created" --arg adopted "$adopted" --arg repo "$repo" '[{path:$adopted,repo:$repo,branch:"feature/adopted",purpose:null,origin:"adopted",created_by:"session-registry",finished_at:null},{path:$created,repo:$repo,branch:"feature/created",purpose:"Registry feature",origin:"created",created_by:"session-registry",finished_at:null}] | sort_by(.path)')"
assert_db "$expected"
printf 'worktree adopt records adopted provenance\n'

run worktree finish "$created" --json >/dev/null
expected="$(jq -cn --arg created "$created" --arg adopted "$adopted" --arg repo "$repo" '[{path:$adopted,repo:$repo,branch:"feature/adopted",purpose:null,origin:"adopted",created_by:"session-registry",finished_at:null},{path:$created,repo:$repo,branch:"feature/created",purpose:"Registry feature",origin:"created",created_by:"session-registry",finished_at:"set"}] | sort_by(.path)')"
MEGABRAIN_STATE_DIR="$work/state" EXPECTED="$expected" bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env.MEGABRAIN_STATE_DIR + "/megabrain.db"); const rows = db.query("SELECT path, repo, branch, purpose, origin, created_by, finished_at FROM worktrees ORDER BY path").all(); const expected = JSON.parse(process.env.EXPECTED); if (rows.length !== expected.length || rows[1].finished_at === null || rows[1].finished_at.length === 0) process.exit(1); for (let i=0;i<rows.length;i++) { for (const key of Object.keys(expected[i])) if (key !== "finished_at" && rows[i][key] !== expected[i][key]) process.exit(1); } db.close();' || fail 'finish did not preserve and timestamp its registry entry'
printf 'worktree finish timestamps the retained registry entry\n'
