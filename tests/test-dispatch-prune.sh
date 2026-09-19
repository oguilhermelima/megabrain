#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-dispatch-prune.XXXXXX")"
fake_bin="$state_dir/bin"

cleanup() {
  chmod -R u+rwx "$state_dir" 2>/dev/null || true
  rm -rf "$state_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_file() {
  [ -e "$1" ] || fail "expected path to exist: $1"
}

assert_missing() {
  [ ! -e "$1" ] || fail "expected path to be absent: $1"
}

export MEGABRAIN_STATE_DIR="$state_dir/state"
export MEGABRAIN_ROOT="$root"
export MEGABRAIN_ORCHESTRATE_READ_IMPLEMENTATION=shell
export SUPERSET_TERMINAL_ID=child-terminal
unset TMUX TMUX_PANE
mkdir -p "$fake_bin"

fake_bin="$state_dir/bin"
mkdir -p "$fake_bin"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' >"$fake_bin/tmux"
printf '%s\n' '#!/usr/bin/env bash' 'if [ "${1:-}" = terminals ] && [ "${2:-}" = list ]; then exit 1; fi' 'exit 1' >"$fake_bin/megabrain_superset"
chmod +x "$fake_bin/tmux" "$fake_bin/megabrain_superset"
export PATH="$fake_bin:$PATH"

source "$root/lib/common.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"

megabrain_dispatch_meta_write direct-dispatch parent-terminal superset superset workspace child-terminal "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
mkdir -p "$MEGABRAIN_DISPATCH_DIR/unreadable"
printf 'not json\n' >"$MEGABRAIN_DISPATCH_DIR/unreadable/meta.json"
chmod 000 "$MEGABRAIN_DISPATCH_DIR/unreadable/meta.json"
MEGABRAIN_DISPATCH_ID=direct-dispatch
megabrain_dispatch_find_child
assert_equal "$MEGABRAIN_FOUND_DISPATCH" direct-dispatch
printf 'direct dispatch id avoids scanning unreadable metadata\n'

chmod u+r "$MEGABRAIN_DISPATCH_DIR/unreadable/meta.json"
rm -rf "$MEGABRAIN_DISPATCH_DIR/unreadable"
rm -rf "$MEGABRAIN_DISPATCH_DIR/direct-dispatch"
megabrain_dispatch_meta_write fallback-dispatch parent-terminal superset superset workspace child-terminal "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
megabrain_dispatch_meta_write wrong-dispatch parent-terminal superset superset workspace other-terminal "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
MEGABRAIN_DISPATCH_ID=wrong-dispatch
megabrain_dispatch_find_child
assert_equal "$MEGABRAIN_FOUND_DISPATCH" fallback-dispatch
unset MEGABRAIN_DISPATCH_ID
megabrain_dispatch_find_child
assert_equal "$MEGABRAIN_FOUND_DISPATCH" fallback-dispatch
printf 'stale and absent dispatch ids fall back to the identity scan\n'

set_old() {
  local dispatch_id="$1" path tmp
  path="$MEGABRAIN_DISPATCH_DIR/$dispatch_id/meta.json"
  tmp="$(mktemp "$MEGABRAIN_DISPATCH_DIR/$dispatch_id/.old.XXXXXX")"
  jq --arg old '2020-01-01T00:00:00Z' '.createdAt = $old | .updatedAt = $old' "$path" >"$tmp"
  mv -f "$tmp" "$path"
}

megabrain_dispatch_meta_write archive-dispatch parent-terminal superset superset workspace child-terminal "$root" main codex label done gpt-5 true codex tmux-session pane-1 tmux >/dev/null
megabrain_dispatch_message_append archive-dispatch child done 'archived queue message' child-terminal >/dev/null
set_old archive-dispatch
megabrain_dispatch_meta_write running-dispatch parent-terminal superset superset workspace child-terminal "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
set_old running-dispatch
megabrain_dispatch_meta_write unknown-dispatch parent-terminal superset superset workspace child-terminal "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
set_old unknown-dispatch
unknown_path="$MEGABRAIN_DISPATCH_DIR/unknown-dispatch/meta.json"
tmp="$(mktemp "$MEGABRAIN_DISPATCH_DIR/unknown-dispatch/.state.XXXXXX")"
jq '.state = "future_state"' "$unknown_path" >"$tmp"
mv -f "$tmp" "$unknown_path"

dry_run="$(command_orchestrate prune --dry-run --json)"
assert_equal "$(printf '%s' "$dry_run" | jq -r '.dryRun')" true
assert_equal "$(printf '%s' "$dry_run" | jq -r '.archived')" 1
assert_equal "$(printf '%s' "$dry_run" | jq -r '.deleted')" 0
assert_equal "$(printf '%s' "$dry_run" | jq -r '.skipped')" 4
assert_file "$MEGABRAIN_DISPATCH_DIR/archive-dispatch/meta.json"
assert_file "$MEGABRAIN_DISPATCH_DIR/running-dispatch/meta.json"
printf 'prune dry-run reports without moving anything\n'

archive_result="$(command_orchestrate prune --json)"
assert_equal "$(printf '%s' "$archive_result" | jq -r '.archived')" 1
archive_path="$(printf '%s' "$archive_result" | jq -r '.archivedDispatches[0].path')"
assert_file "$archive_path/meta.json"
assert_missing "$MEGABRAIN_DISPATCH_DIR/archive-dispatch"
assert_equal "$(command_orchestrate list --all --json | jq -r 'map(select(.dispatchId == "archive-dispatch")) | length')" 1

cat >"$fake_bin/tmux" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = capture-pane ]; then
  printf 'archived pane output\n'
else
  exit 1
fi
EOF
chmod +x "$fake_bin/tmux"
read_result="$(PATH="$fake_bin:$PATH" SUPERSET_TERMINAL_ID=parent-terminal command_orchestrate read archive-dispatch --json)"
assert_equal "$(printf '%s' "$read_result" | jq -r '.text')" 'archived pane output'
assert_equal "$(jq -r '.text' "$archive_path/messages"/*.json)" 'archived queue message'
printf 'archived dispatch remains readable through list and read\n'

megabrain_dispatch_meta_write delete-dispatch parent-terminal superset superset workspace child-terminal "$root" main codex label failed gpt-5 true codex '' '' host ide >/dev/null
set_old delete-dispatch
delete_result="$(command_orchestrate prune --delete --json)"
assert_equal "$(printf '%s' "$delete_result" | jq -r '.deleted')" 0
assert_equal "$(printf '%s' "$delete_result" | jq -r '.skippedDispatches[] | select(.dispatchId == "delete-dispatch") | .reason')" 'terminal identity is unproven'
assert_file "$MEGABRAIN_DISPATCH_DIR/delete-dispatch/meta.json"
assert_file "$MEGABRAIN_DISPATCH_DIR/running-dispatch/meta.json"
assert_file "$MEGABRAIN_DISPATCH_DIR/unknown-dispatch/meta.json"
assert_equal "$(printf '%s' "$delete_result" | jq -r '.skippedDispatches[] | select(.dispatchId == "unknown-dispatch") | .state')" future_state
printf 'delete removes only the reported terminal dispatch\n'

printf 'ok: direct child lookup and dispatch pruning\n'
