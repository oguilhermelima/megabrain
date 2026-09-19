#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then printf 'skip: compiled prune binary is missing; run bun run build\n'; exit 0; fi
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-prune-cli.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
fake_bin="$work/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/tmux" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$fake_bin/tmux"
make_fixture() { local base="$1"; mkdir -p "$base/state/dispatches/old/messages" "$base/state/dispatches/open" "$base/state/dispatches/future"; printf '%s\n' '{"dispatchId":"old","state":"done","runtime":"tmux","tmuxSession":"missing","createdAt":"2020-01-01T00:00:00Z"}' >"$base/state/dispatches/old/meta.json"; printf '%s\n' '{"text":"survive"}' >"$base/state/dispatches/old/messages/1.json"; printf '%s\n' '{"dispatchId":"open","state":"running","createdAt":"2020-01-01T00:00:00Z"}' >"$base/state/dispatches/open/meta.json"; printf '%s\n' '{"dispatchId":"future","state":"future_state","createdAt":"2020-01-01T00:00:00Z"}' >"$base/state/dispatches/future/meta.json"; }
assert_equal() { local actual="$1" expected="$2" message="$3"; [ "$actual" = "$expected" ] || { printf 'FAIL: %s (expected: %s, got: %s)\n' "$message" "$expected" "$actual" >&2; exit 1; }; }
assert_path() { local path="$1" expected="$2" message="$3" actual=false; [ -e "$path" ] && actual=true; assert_equal "$actual" "$expected" "$message: $path"; }
make_fixture "$work/binary"
binary="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$work/binary/state" "$root/.build/megabrain" orchestrate prune --dry-run --json | sed "s#$work/binary#STATE#g")"
printf '%s' "$binary" | jq -e '.mode == "archive" and .dryRun == true and .archivedDispatches[0].dispatchId == "old"' >/dev/null || fail 'compiled prune dry-run content is incomplete'
assert_path "$work/binary/state/dispatches/old/meta.json" true 'dry-run preserves eligible dispatch'
binary="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$work/binary/state" "$root/.build/megabrain" orchestrate prune --json | sed "s#$work/binary#STATE#g")"
archive="$work/binary/state/dispatches/archive/$(date -u +%Y-%m)"
assert_path "$archive/old/messages/1.json" true 'real archive keeps eligible old dispatch'
assert_path "$work/binary/state/dispatches/open/meta.json" true 'real archive preserves open dispatch'
assert_path "$work/binary/state/dispatches/future/meta.json" true 'real archive preserves unrecognised future dispatch'
assert_path "$archive/open" false 'real archive does not archive open dispatch'
assert_path "$archive/future" false 'real archive does not archive unrecognised future dispatch'
printf '%s' "$binary" | jq -e '.archivedDispatches | map(.dispatchId) | index("old") != null' >/dev/null || fail 'compiled prune archive output is incomplete'
printf 'prune compiled content archives only eligible dispatches\n'

make_fixture "$work/binary-delete"
binary_delete="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$work/binary-delete/state" "$root/.build/megabrain" orchestrate prune --delete --json | sed "s#$work\/binary-delete#STATE#g")"
printf '%s' "$binary_delete" | jq -e '.deletedDispatches | index("old") != null' >/dev/null || fail 'compiled prune delete output is incomplete'
assert_path "$work/binary-delete/state/dispatches/old" false 'delete removes eligible old dispatch'
assert_path "$work/binary-delete/state/dispatches/archive/old" false 'delete leaves no reachable archive for old dispatch'
assert_path "$work/binary-delete/state/dispatches/open/meta.json" true 'delete preserves open dispatch'
assert_path "$work/binary-delete/state/dispatches/future/meta.json" true 'delete preserves unrecognised future dispatch'
assert_path "$work/binary-delete/state/dispatches/archive/open" false 'delete does not archive open dispatch'
assert_path "$work/binary-delete/state/dispatches/archive/future" false 'delete does not archive unrecognised future dispatch'
printf 'prune delete removes only eligible dispatches\n'

reconcile_state="$work/reconcile/state"
mkdir -p "$reconcile_state/dispatches/uncertain"
printf '%s\n' '{"dispatchId":"uncertain","state":"running","processState":"abandoned","terminalState":"owned","runtime":"tmux","tmuxSession":"missing","tmuxPane":"%9","createdAt":"2020-01-01T00:00:00Z"}' >"$reconcile_state/dispatches/uncertain/meta.json"
reconciled="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$reconcile_state" "$root/.build/megabrain" orchestrate prune --json)"
assert_path "$reconcile_state/dispatches/archive/$(date -u +%Y-%m)/uncertain/meta.json" true 'prune reconciles terminal-missing dispatch before archive'
printf '%s' "$reconciled" | jq -e '.archivedDispatches | map(.dispatchId) | index("uncertain") != null' >/dev/null || fail 'reconciled dispatch was not reported as archived'
printf 'prune reconciles uncertain dispatches before moving them\n'
