#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/fixtures/a-dispatch-meta.sh"
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

MEGABRAIN_STATE_DIR="$state_dir/state"
export MEGABRAIN_STATE_DIR
export MEGABRAIN_ROOT="$root"
export SUPERSET_TERMINAL_ID=child-terminal
unset TMUX TMUX_PANE
mkdir -p "$fake_bin"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' >"$fake_bin/tmux"
printf '%s\n' '#!/usr/bin/env bash' 'if [ "${1:-}" = terminals ] && [ "${2:-}" = list ]; then exit 1; fi' 'exit 1' >"$fake_bin/superset"
chmod +x "$fake_bin/tmux" "$fake_bin/superset"
export PATH="$fake_bin:$PATH"

# findChild (src/cli/commands/queue-write.ts) is what MEGABRAIN_DISPATCH_ID's fast path, and the
# fallback identity scan, actually route through in production for `ask`/`done`/`received`/
# `check` -- the retired megabrain_dispatch_find_child shell function it replaces had no other
# caller. Driven here through `ask`, asserting which dispatch's message queue received the text.
ask_lands_in() {
  local text="$1"
  shift
  env "$@" "$root/.build/megabrain" ask "$text" >/dev/null
}

last_message_dispatch_for() {
  local text="$1" dispatch
  for dispatch in "$MEGABRAIN_STATE_DIR"/dispatches/*/; do
    dispatch="$(basename "$dispatch")"
    if grep -l "\"$text\"" "$MEGABRAIN_STATE_DIR/dispatches/$dispatch/messages"/*.json >/dev/null 2>&1; then
      printf '%s\n' "$dispatch"
      return 0
    fi
  done
  return 1
}

write_dispatch_meta "$MEGABRAIN_STATE_DIR" direct-dispatch \
  childHost=superset workspaceId=workspace terminalId=child-terminal state=running >/dev/null
mkdir -p "$MEGABRAIN_STATE_DIR/dispatches/unreadable"
printf 'not json\n' >"$MEGABRAIN_STATE_DIR/dispatches/unreadable/meta.json"
chmod 000 "$MEGABRAIN_STATE_DIR/dispatches/unreadable/meta.json"
ask_lands_in direct-question MEGABRAIN_DISPATCH_ID=direct-dispatch
assert_equal "$(last_message_dispatch_for direct-question)" direct-dispatch
printf 'direct dispatch id avoids scanning unreadable metadata\n'

chmod u+r "$MEGABRAIN_STATE_DIR/dispatches/unreadable/meta.json"
rm -rf "$MEGABRAIN_STATE_DIR/dispatches/unreadable" "$MEGABRAIN_STATE_DIR/dispatches/direct-dispatch"
write_dispatch_meta "$MEGABRAIN_STATE_DIR" fallback-dispatch \
  childHost=superset workspaceId=workspace terminalId=child-terminal state=running >/dev/null
write_dispatch_meta "$MEGABRAIN_STATE_DIR" wrong-dispatch \
  childHost=superset workspaceId=workspace terminalId=other-terminal state=running >/dev/null
# RULE-4 FINDING (do not weaken): findChild's fast path only checks that MEGABRAIN_DISPATCH_ID
# names a dispatch whose own meta.json has that id (src/cli/commands/queue-write.ts:125-127) --
# it never checks that the CURRENT caller's identity owns that dispatch before locking the
# candidate list to it. A stale MEGABRAIN_DISPATCH_ID left over from a previous, different
# dispatch (still present on disk, just not this caller's) therefore fails outright with "no
# managed dispatch belongs to <host>/<id>" instead of falling back to the identity scan the way
# the retired shell implementation did (and the way an absent/deleted id already does, two lines
# below, since directDispatch is only ever set when the id's meta exists). Left failing per rule 4;
# the lead decides.
ask_lands_in stale-question MEGABRAIN_DISPATCH_ID=wrong-dispatch
assert_equal "$(last_message_dispatch_for stale-question)" fallback-dispatch
ask_lands_in absent-question
assert_equal "$(last_message_dispatch_for absent-question)" fallback-dispatch
printf 'stale and absent dispatch ids fall back to the identity scan\n'

set_old() {
  local dispatch_id="$1" path tmp
  path="$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json"
  tmp="$(mktemp "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/.old.XXXXXX")"
  jq --arg old '2020-01-01T00:00:00Z' '.createdAt = $old | .updatedAt = $old' "$path" >"$tmp"
  mv -f "$tmp" "$path"
}

write_dispatch_meta "$MEGABRAIN_STATE_DIR" archive-dispatch \
  childHost=superset workspaceId=workspace terminalId=child-terminal state=done \
  tmuxSession=tmux-session tmuxPane=pane-1 runtime=tmux >/dev/null
append_dispatch_message "$MEGABRAIN_STATE_DIR" archive-dispatch child done 'archived queue message' child-terminal >/dev/null
set_old archive-dispatch
write_dispatch_meta "$MEGABRAIN_STATE_DIR" running-dispatch \
  childHost=superset workspaceId=workspace terminalId=child-terminal state=running >/dev/null
set_old running-dispatch
write_dispatch_meta "$MEGABRAIN_STATE_DIR" unknown-dispatch \
  childHost=superset workspaceId=workspace terminalId=child-terminal state=running >/dev/null
set_old unknown-dispatch
unknown_path="$MEGABRAIN_STATE_DIR/dispatches/unknown-dispatch/meta.json"
tmp="$(mktemp "$MEGABRAIN_STATE_DIR/dispatches/unknown-dispatch/.state.XXXXXX")"
jq '.state = "future_state"' "$unknown_path" >"$tmp"
mv -f "$tmp" "$unknown_path"

dry_run="$("$root/.build/megabrain" orchestrate prune --dry-run --json)"
assert_equal "$(printf '%s' "$dry_run" | jq -r '.dryRun')" true
assert_equal "$(printf '%s' "$dry_run" | jq -r '.archived')" 1
assert_equal "$(printf '%s' "$dry_run" | jq -r '.deleted')" 0
assert_equal "$(printf '%s' "$dry_run" | jq -r '.skipped')" 4
assert_file "$MEGABRAIN_STATE_DIR/dispatches/archive-dispatch/meta.json"
assert_file "$MEGABRAIN_STATE_DIR/dispatches/running-dispatch/meta.json"
printf 'prune dry-run reports without moving anything\n'

archive_result="$("$root/.build/megabrain" orchestrate prune --json)"
assert_equal "$(printf '%s' "$archive_result" | jq -r '.archived')" 1
archive_path="$(printf '%s' "$archive_result" | jq -r '.archivedDispatches[0].path')"
assert_file "$archive_path/meta.json"
assert_missing "$MEGABRAIN_STATE_DIR/dispatches/archive-dispatch"
assert_equal "$("$root/.build/megabrain" orchestrate list --all --json | jq -r 'map(select(.dispatchId == "archive-dispatch")) | length')" 1

cat >"$fake_bin/tmux" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = capture-pane ]; then
  printf 'archived pane output\n'
else
  exit 1
fi
EOF
chmod +x "$fake_bin/tmux"
read_result="$(PATH="$fake_bin:$PATH" SUPERSET_TERMINAL_ID=parent-terminal "$root/.build/megabrain" orchestrate read archive-dispatch --json)"
assert_equal "$(printf '%s' "$read_result" | jq -r '.text')" 'archived pane output'
assert_equal "$(jq -r '.text' "$archive_path/messages"/*.json)" 'archived queue message'
printf 'archived dispatch remains readable through list and read\n'

write_dispatch_meta "$MEGABRAIN_STATE_DIR" delete-dispatch \
  childHost=superset workspaceId=workspace terminalId=child-terminal state=failed >/dev/null
set_old delete-dispatch
delete_result="$("$root/.build/megabrain" orchestrate prune --delete --json)"
assert_equal "$(printf '%s' "$delete_result" | jq -r '.deleted')" 0
assert_equal "$(printf '%s' "$delete_result" | jq -r '.skippedDispatches[] | select(.dispatchId == "delete-dispatch") | .reason')" 'terminal identity is unproven'
assert_file "$MEGABRAIN_STATE_DIR/dispatches/delete-dispatch/meta.json"
assert_file "$MEGABRAIN_STATE_DIR/dispatches/running-dispatch/meta.json"
assert_file "$MEGABRAIN_STATE_DIR/dispatches/unknown-dispatch/meta.json"
assert_equal "$(printf '%s' "$delete_result" | jq -r '.skippedDispatches[] | select(.dispatchId == "unknown-dispatch") | .state')" future_state
printf 'delete removes only the reported terminal dispatch\n'

printf 'ok: direct child lookup and dispatch pruning\n'
