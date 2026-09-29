#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_real_home="${HOME:-}"
if [ ! -x "$root/.build/megabrain" ]; then printf 'skip: compiled prune binary is missing; run bun run build\n'; exit 0; fi
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-prune-cli.XXXXXX")"
export HOME="$work/home"
mkdir -p "$HOME"
assert_safe_state_dir() {
  [ -n "${MEGABRAIN_STATE_DIR:-}" ] || { printf 'FAIL: MEGABRAIN_STATE_DIR is unset\n' >&2; exit 1; }
  local state_path home_path home_candidate
  state_path="$(cd "$MEGABRAIN_STATE_DIR" && pwd -P)"
  for home_candidate in "$test_real_home" "$HOME"; do
    [ -n "$home_candidate" ] && [ -d "$home_candidate" ] || continue
    home_path="$(cd "$home_candidate" && pwd -P)"
    case "$state_path/" in "$home_path/.megabrain/"*) printf 'FAIL: refusing real-home megabrain state directory\n' >&2; exit 1 ;; esac
  done
}
trap 'rm -rf "$work"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
fake_bin="$work/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/tmux" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$fake_bin/tmux"
make_fixture() { local base="$1"; mkdir -p "$base/state/dispatches/old/messages" "$base/state/dispatches/open"; printf '%s\n' '{"dispatchId":"old","state":"done","runtime":"tmux","tmuxSession":"missing","createdAt":"2020-01-01T00:00:00Z"}' >"$base/state/dispatches/old/meta.json"; printf '%s\n' '{"seq":1,"from":"parent","type":"reply","text":"survive","createdAt":"2020-01-01T00:00:00Z"}' >"$base/state/dispatches/old/messages/1.json"; printf '%s\n' '{"dispatchId":"open","state":"running","createdAt":"2020-01-01T00:00:00Z"}' >"$base/state/dispatches/open/meta.json"; }
assert_equal() { local actual="$1" expected="$2" message="$3"; [ "$actual" = "$expected" ] || { printf 'FAIL: %s (expected: %s, got: %s)\n' "$message" "$expected" "$actual" >&2; exit 1; }; }
db_import() { export MEGABRAIN_STATE_DIR="$1"; assert_safe_state_dir; "$root/.build/megabrain" db import "$1" --replace --json >/dev/null; }
db_show() { MEGABRAIN_STATE_DIR="$1" "$root/.build/megabrain" db show "$2" --json; }
make_fixture "$work/binary"
db_import "$work/binary/state"
binary="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$work/binary/state" "$root/.build/megabrain" orchestrate prune --dry-run --json | sed "s#$work/binary#STATE#g")"
printf '%s' "$binary" | jq -e '.mode == "archive" and .dryRun == true and .archivedDispatches[0].dispatchId == "old"' >/dev/null || fail 'compiled prune dry-run content is incomplete'
assert_equal "$(db_show "$work/binary/state" old | jq -r '.meta.dispatchId')" old 'dry-run preserves eligible dispatch'
binary="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$work/binary/state" "$root/.build/megabrain" orchestrate prune --json | sed "s#$work/binary#STATE#g")"
assert_equal "$(db_show "$work/binary/state" old | jq -r '.archived')" true 'real archive marks eligible dispatch archived'
assert_equal "$(db_show "$work/binary/state" old | jq -r '.messages[0].text')" survive 'real archive keeps dispatch messages'
assert_equal "$(db_show "$work/binary/state" open | jq -r '.archived')" false 'real archive preserves open dispatch'
printf '%s' "$binary" | jq -e '.archivedDispatches | map(.dispatchId) | index("old") != null' >/dev/null || fail 'compiled prune archive output is incomplete'
printf 'prune compiled content archives only eligible dispatches\n'

make_fixture "$work/binary-delete"
db_import "$work/binary-delete/state"
binary_delete="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$work/binary-delete/state" "$root/.build/megabrain" orchestrate prune --delete --json | sed "s#$work\/binary-delete#STATE#g")"
printf '%s' "$binary_delete" | jq -e '.deletedDispatches | index("old") != null' >/dev/null || fail 'compiled prune delete output is incomplete'
if db_show "$work/binary-delete/state" old >/dev/null 2>&1; then fail 'delete retained the eligible dispatch row'; fi
assert_equal "$(db_show "$work/binary-delete/state" open | jq -r '.meta.dispatchId')" open 'delete preserves open dispatch'
printf 'prune delete removes only eligible dispatches\n'

reconcile_state="$work/reconcile/state"
mkdir -p "$reconcile_state/dispatches/uncertain"
printf '%s\n' '{"dispatchId":"uncertain","state":"running","processState":"abandoned","terminalState":"owned","runtime":"tmux","tmuxSession":"missing","tmuxPane":"%9","createdAt":"2020-01-01T00:00:00Z"}' >"$reconcile_state/dispatches/uncertain/meta.json"
db_import "$reconcile_state"
reconciled="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$reconcile_state" "$root/.build/megabrain" orchestrate prune --json)"
assert_equal "$(db_show "$reconcile_state" uncertain | jq -r '.meta.state')" failed 'prune reconciles terminal-missing dispatch'
printf '%s' "$reconciled" | jq -e '.skippedDispatches | any(.[]; .dispatchId == "uncertain" and (.reason | contains("younger")))' >/dev/null || fail 'reconciled dispatch was not reported as skipped safely'
printf 'prune reconciles uncertain dispatches before applying age policy\n'

timeout_state="$work/timeout/state"
mkdir -p "$timeout_state/dispatches/legacy-timeout"
printf '%s\n' '{"dispatchId":"legacy-timeout","state":"running","createdAt":"2020-01-01T00:00:00Z"}' >"$timeout_state/dispatches/legacy-timeout/meta.json"
db_import "$timeout_state"
PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$timeout_state" "$root/.build/megabrain" orchestrate prune --dry-run --json >/dev/null
assert_equal "$(db_show "$timeout_state" legacy-timeout | jq -r '.meta.state')" running 'normalized legacy timeout state stays open'
printf 'prune keeps the normalized legacy timeout state open\n'
