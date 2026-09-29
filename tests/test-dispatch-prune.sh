#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_real_home="${HOME:-}"
source "$root/tests/fixtures/a-dispatch-meta.sh"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-dispatch-prune.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$state_dir/.megabrain-test-state"
require_megabrain_test_state

export HOME="$state_dir/home"
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
mkdir -p "$HOME" "$MEGABRAIN_STATE_DIR"
assert_safe_state_dir() {
  [ -n "${MEGABRAIN_STATE_DIR:-}" ] || fail 'MEGABRAIN_STATE_DIR is unset'
  local state_path home_path home_candidate
  state_path="$(cd "$MEGABRAIN_STATE_DIR" && pwd -P)"
  for home_candidate in "$test_real_home" "$HOME"; do
    [ -n "$home_candidate" ] && [ -d "$home_candidate" ] || continue
    home_path="$(cd "$home_candidate" && pwd -P)"
    case "$state_path/" in "$home_path/.megabrain/"*) fail 'refusing real-home megabrain state directory' ;; esac
  done
}
db_import() { assert_safe_state_dir; "$root/.build/megabrain" db import "$MEGABRAIN_STATE_DIR" --replace --json >/dev/null; }
db_show() { "$root/.build/megabrain" db show "$1" --json; }
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
  local text="$1" dispatch found
  for dispatch in direct-dispatch fallback-dispatch wrong-dispatch; do
    found="$(db_show "$dispatch" | jq -r --arg text "$text" '[.messages[] | select(.text == $text)] | length' 2>/dev/null || true)"
    if [ "$found" = 1 ]; then printf '%s\n' "$dispatch"; return 0; fi
  done
  return 1
}

write_dispatch_meta "$MEGABRAIN_STATE_DIR" fallback-dispatch \
  childHost=superset workspaceId=workspace terminalId=child-terminal state=running >/dev/null
write_dispatch_meta "$MEGABRAIN_STATE_DIR" wrong-dispatch \
  childHost=superset workspaceId=workspace terminalId=other-terminal state=running >/dev/null
db_import
ask_lands_in direct-question MEGABRAIN_DISPATCH_ID=missing-dispatch
assert_equal "$(last_message_dispatch_for direct-question)" fallback-dispatch
printf 'absent direct dispatch id falls back to terminal identity\n'
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
  db_import
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
jq '.state = "running"' "$unknown_path" >"$tmp"
mv -f "$tmp" "$unknown_path"
db_import

dry_run="$("$root/.build/megabrain" orchestrate prune --dry-run --json)"
assert_equal "$(printf '%s' "$dry_run" | jq -r '.dryRun')" true
assert_equal "$(printf '%s' "$dry_run" | jq -r '.archived')" 1
assert_equal "$(printf '%s' "$dry_run" | jq -r '.deleted')" 0
assert_equal "$(printf '%s' "$dry_run" | jq -r '.skipped')" 4
assert_equal "$(db_show archive-dispatch | jq -r '.meta.dispatchId')" archive-dispatch
assert_equal "$(db_show running-dispatch | jq -r '.meta.dispatchId')" running-dispatch
printf 'prune dry-run reports without moving anything\n'

archive_result="$("$root/.build/megabrain" orchestrate prune --json)"
assert_equal "$(printf '%s' "$archive_result" | jq -r '.archived')" 1
assert_equal "$(db_show archive-dispatch | jq -r '.archived')" true
assert_equal "$("$root/.build/megabrain" orchestrate list --all --archived --json | jq -r 'map(select(.dispatchId == "archive-dispatch")) | length')" 1

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
assert_equal "$(db_show archive-dispatch | jq -r '.messages[0].text')" 'archived queue message'
printf 'archived dispatch remains readable through list and read\n'

write_dispatch_meta "$MEGABRAIN_STATE_DIR" delete-dispatch \
  childHost=superset workspaceId=workspace terminalId=child-terminal state=failed >/dev/null
set_old delete-dispatch
delete_result="$("$root/.build/megabrain" orchestrate prune --delete --json)"
assert_equal "$(printf '%s' "$delete_result" | jq -r '.deleted')" 0
assert_equal "$(printf '%s' "$delete_result" | jq -r '.skippedDispatches[] | select(.dispatchId == "delete-dispatch") | .reason')" 'terminal identity is unproven'
assert_equal "$(db_show delete-dispatch | jq -r '.meta.dispatchId')" delete-dispatch
assert_equal "$(db_show running-dispatch | jq -r '.meta.dispatchId')" running-dispatch
assert_equal "$(db_show unknown-dispatch | jq -r '.meta.dispatchId')" unknown-dispatch
assert_equal "$(printf '%s' "$delete_result" | jq -r '.skippedDispatches[] | select(.dispatchId == "unknown-dispatch") | .state')" running
printf 'delete removes only the reported terminal dispatch\n'

printf 'ok: direct child lookup and dispatch pruning\n'
