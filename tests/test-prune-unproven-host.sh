#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_real_home="${HOME:-}"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-prune-unproven-host.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$work/.megabrain-test-state"
require_megabrain_test_state

trap 'rm -rf "$work"' EXIT
state="$work/state"
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
fake_bin="$work/bin"
mkdir -p "$state/dispatches/archive-me" "$fake_bin"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_file() { [ -e "$1" ] || fail "expected file: $1"; }
assert_missing() { [ ! -e "$1" ] || fail "expected path to be absent: $1"; }
db_import() { export MEGABRAIN_STATE_DIR="$1"; assert_safe_state_dir; "$root/.build/megabrain" db import "$1" --replace --json >/dev/null; }
db_show() { MEGABRAIN_STATE_DIR="$1" "$root/.build/megabrain" db show "$2" --json; }

cat >"$fake_bin/superset" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = terminals ] && [ "${2:-}" = list ]; then
  printf '%s\n' '[]'
  exit 0
fi
if [ "${1:-}" = terminals ] && [ "${2:-}" = close ]; then
  printf '%s\n' 'terminal close denied' >&2
  exit 1
fi
exit 1
EOF
chmod +x "$fake_bin/superset"

write_dispatch() {
  local id="$1"
  mkdir -p "$state/dispatches/$id/messages"
  jq -n --arg id "$id" '{
    dispatchId: $id, state: "done", processState: "succeeded", terminalState: "owned",
    terminalReason: null, runtime: "host", childHost: "superset", workspaceId: "workspace",
    terminalId: "child-terminal", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z"
  }' >"$state/dispatches/$id/meta.json"
}
write_dispatch archive-me
db_import "$state"

before="$(db_show "$state" archive-me)"
dry_json="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" orchestrate prune --dry-run --json)"
assert_equal "$(printf '%s' "$dry_json" | jq -r '.archived')" 0
assert_equal "$(printf '%s' "$dry_json" | jq -r '.terminalNotProvenGone')" 1
assert_equal "$(printf '%s' "$dry_json" | jq -r '.terminalNotProvenGoneDispatches[0].dispatchId')" archive-me
assert_equal "$(db_show "$state" archive-me)" "$before"
text_output="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" orchestrate prune --dry-run)"
case "$text_output" in *"kept: terminal not proven gone"*"kept: archive-me (terminal is absent from the host listing)"*) ;; *) fail "text output omitted unproven host terminal: $text_output" ;; esac

archive_result="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" orchestrate prune --json)"
assert_equal "$(printf '%s' "$archive_result" | jq -r '.archived')" 0
assert_equal "$(printf '%s' "$archive_result" | jq -r '.terminalNotProvenGoneDispatches[0].reason')" 'terminal is absent from the host listing'
assert_equal "$(jq -r '.meta.terminalState' <<<"$(db_show "$state" archive-me)")" retained
assert_equal "$(jq -r '.meta.terminalReason' <<<"$(db_show "$state" archive-me)")" 'terminal is absent from the host listing'

state="$work/delete-state"
mkdir -p "$state/dispatches/delete-me"
write_dispatch delete-me
db_import "$state"
delete_result="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" orchestrate prune --delete --json)"
assert_equal "$(printf '%s' "$delete_result" | jq -r '.deleted')" 0
assert_equal "$(printf '%s' "$delete_result" | jq -r '.terminalNotProvenGoneDispatches[0].dispatchId')" delete-me
assert_equal "$(db_show "$state" delete-me | jq -r '.meta.dispatchId')" delete-me

printf 'ok: valid host listing absence keeps prune targets\n'
