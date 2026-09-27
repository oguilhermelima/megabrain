#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-prune-unproven-host.XXXXXX")"
trap 'rm -rf "$work"' EXIT
state="$work/state"
fake_bin="$work/bin"
mkdir -p "$state/dispatches/archive-me" "$fake_bin"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_file() { [ -e "$1" ] || fail "expected file: $1"; }
assert_missing() { [ ! -e "$1" ] || fail "expected path to be absent: $1"; }

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

before="$(cat "$state/dispatches/archive-me/meta.json")"
dry_json="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" orchestrate prune --dry-run --json)"
assert_equal "$(printf '%s' "$dry_json" | jq -r '.archived')" 0
assert_equal "$(printf '%s' "$dry_json" | jq -r '.terminalNotProvenGone')" 1
assert_equal "$(printf '%s' "$dry_json" | jq -r '.terminalNotProvenGoneDispatches[0].dispatchId')" archive-me
assert_equal "$(cat "$state/dispatches/archive-me/meta.json")" "$before"
text_output="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" orchestrate prune --dry-run)"
case "$text_output" in *"kept: terminal not proven gone"*"kept: archive-me (terminal is absent from the host listing)"*) ;; *) fail "text output omitted unproven host terminal: $text_output" ;; esac

archive_result="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" orchestrate prune --json)"
assert_equal "$(printf '%s' "$archive_result" | jq -r '.archived')" 0
assert_equal "$(printf '%s' "$archive_result" | jq -r '.terminalNotProvenGoneDispatches[0].reason')" 'terminal is absent from the host listing'
assert_file "$state/dispatches/archive-me/meta.json"
assert_equal "$(jq -r '.terminalState' "$state/dispatches/archive-me/meta.json")" retained
assert_equal "$(jq -r '.terminalReason' "$state/dispatches/archive-me/meta.json")" 'terminal is absent from the host listing'

write_dispatch delete-me
delete_result="$(PATH="$fake_bin:$PATH" MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" orchestrate prune --delete --json)"
assert_equal "$(printf '%s' "$delete_result" | jq -r '.deleted')" 0
assert_equal "$(printf '%s' "$delete_result" | jq -r '.terminalNotProvenGoneDispatches[0].dispatchId')" delete-me
assert_file "$state/dispatches/delete-me/meta.json"
assert_missing "$state/dispatches/archive/$(date -u '+%Y-%m')/delete-me"

printf 'ok: valid host listing absence keeps prune targets\n'
