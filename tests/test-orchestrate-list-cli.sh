#!/usr/bin/env bash
set -euo pipefail

# Agent sessions inherit caller markers from the host. Keep each identity scenario isolated;
# scenarios that exercise a specific identity set their intended markers inline.
unset MEGABRAIN_SESSION_ID MEGABRAIN_SESSION_HOST CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID \
  ORCA_STRUCTURED_SESSION ORCA_AGENT_SESSION_SPAWN_TOKEN ORCA_TERMINAL_HANDLE SUPERSET_TERMINAL_ID

# Scenarios written before implementation: archived records are hidden by default and included
# with an explicit marker when requested, alongside plain/JSON parity, selection flags, malformed
# records, and an empty inventory.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_real_home="${HOME:-}"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-orchestrate-list.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$state_dir/.megabrain-test-state"
require_megabrain_test_state

export HOME="$state_dir/home"
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
trap 'rm -rf "$state_dir"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
db_import() { export MEGABRAIN_STATE_DIR="$1"; assert_safe_state_dir; "$root/.build/megabrain" db import "$1" --replace --json >/dev/null; }
write_fixture() {
  local root_dir="$1"
  mkdir -p "$root_dir/dispatches/owned" "$root_dir/dispatches/other" "$root_dir/dispatches/orphan" "$root_dir/dispatches/uncertain" "$root_dir/dispatches/archive/2026-09-14/archived"
  printf '%s\n' '{"dispatchId":"owned","parentSessionId":"caller","parentHost":"host","state":"running","processState":"running","terminalState":"owned","worktreePath":"/owned","reconcileOutcome":null}' >"$root_dir/dispatches/owned/meta.json"
  printf '%s\n' '{"dispatchId":"other","parentSessionId":"other-session","parentHost":"host","state":"running","processState":"running","terminalState":"owned","worktreePath":"/other"}' >"$root_dir/dispatches/other/meta.json"
  printf '%s\n' '{"dispatchId":"orphan","parentSessionId":"caller","parentHost":"host","state":"orphaned","processState":"running","terminalState":"owned","worktreePath":"/orphan"}' >"$root_dir/dispatches/orphan/meta.json"
  printf '%s\n' '{"dispatchId":"uncertain","parentSessionId":"caller","parentHost":"host","state":"running","processState":"exited","terminalState":"owned","worktreePath":"/uncertain"}' >"$root_dir/dispatches/uncertain/meta.json"
  printf '%s\n' '{"dispatchId":"archived","parentSessionId":"caller","parentHost":"host","state":"done","processState":"succeeded","terminalState":"released","worktreePath":"/archived"}' >"$root_dir/dispatches/archive/2026-09-14/archived/meta.json"
}
run_side() {
  local executable="$1" root_dir="$2" args="$3"
  export MEGABRAIN_STATE_DIR="$root_dir"
  assert_safe_state_dir
  MEGABRAIN_STATE_DIR="$root_dir" MEGABRAIN_SESSION_ID=caller MEGABRAIN_SESSION_HOST=host "$executable" orchestrate list $args
}
write_fixture "$state_dir"
db_import "$state_dir"
for args in "" "--json" "--all" "--all --json" "--archived" "--archived --json" "--all --archived --json" "--orphans --json" "--uncertain --json"; do
  binary_output="$(run_side "$root/.build/megabrain" "$state_dir" "$args" 2>"$state_dir/binary.err")"
  [ -n "$binary_output" ] || fail "compiled binary produced no output for args: $args"
  if [ -x "$root/.build/megabrain" ]; then
    [ -n "$binary_output" ] || fail "compiled binary produced no output for args: $args"
  fi
done
default_json="$(run_side "$root/.build/megabrain" "$state_dir" "--all --json")"
printf '%s' "$default_json" | jq -e 'all(.[]; .dispatchId != "archived" and .archived != true)' >/dev/null ||
  fail "default list included an archived dispatch: $default_json"
archived_json="$(run_side "$root/.build/megabrain" "$state_dir" "--archived --json")"
printf '%s' "$archived_json" | jq -e 'any(.[]; .dispatchId == "archived" and .archived == true)' >/dev/null ||
  fail "--archived did not include an explicitly marked archived dispatch: $archived_json"
archived_text="$(run_side "$root/.build/megabrain" "$state_dir" "--archived")"
case "$archived_text" in
  *'archived'*) ;;
  *) fail "text list did not visibly mark the archived dispatch: $archived_text" ;;
esac
mkdir -p "$state_dir/dispatches/broken"
printf '%s\n' '{not json' >"$state_dir/dispatches/broken/meta.json"
list_without_legacy_file="$(run_side "$root/.build/megabrain" "$state_dir" "--all --json")"
printf '%s' "$list_without_legacy_file" | jq -e '. as $rows | ($rows | length) == 4 and ($rows | map(select(.dispatchId == "broken")) | length) == 0' >/dev/null || fail 'listing consulted a malformed legacy JSON file after database import'
empty="$state_dir/empty"
mkdir -p "$empty"
[ "$(run_side "$root/.build/megabrain" "$empty" "--json")" = '[]' ] || fail 'empty compiled JSON inventory differs'
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled orchestrate list binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
else
  printf 'orchestrate list compiled content covers all selection forms\n'
fi
printf 'malformed metadata was skipped without corrupting stdout\n'

tmux_bin="$state_dir/tmux-bin"
mkdir -p "$tmux_bin"
cat >"$tmux_bin/tmux" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = display-message ]; then
  printf 'tmux-session\n'
  exit 0
fi
exit 1
EOF
chmod +x "$tmux_bin/tmux"
tmux_state="$state_dir/tmux-state"
mkdir -p "$tmux_state/dispatches/tmux-owned"
printf '%s\n' '{"dispatchId":"tmux-owned","parentSessionId":"tmux-session:%7","parentHost":"tmux","state":"running","processState":"running","terminalState":"owned","worktreePath":"/tmux"}' >"$tmux_state/dispatches/tmux-owned/meta.json"
db_import "$tmux_state"
tmux_output="$(env PATH="$tmux_bin:$PATH" MEGABRAIN_STATE_DIR="$tmux_state" TMUX=1 TMUX_PANE=%7 \
  "$root/.build/megabrain" orchestrate list --json)"
printf '%s' "$tmux_output" | jq -e 'length == 1 and .[0].dispatchId == "tmux-owned" and .[0].ownedByCaller == true' >/dev/null ||
  fail "tmux caller identity was not selected: $tmux_output"
printf 'tmux caller identity is selected when no session override is set\n'

precedence_state="$state_dir/precedence"
mkdir -p "$precedence_state/dispatches/superset-owned"
printf '%s\n' '{"dispatchId":"superset-owned","parentSessionId":"caller","parentHost":"superset","state":"running","processState":"running","terminalState":"owned","worktreePath":"/superset"}' >"$precedence_state/dispatches/superset-owned/meta.json"
db_import "$precedence_state"
precedence_output="$(env -u MEGABRAIN_SESSION_ID -u MEGABRAIN_SESSION_HOST MEGABRAIN_STATE_DIR="$precedence_state" SUPERSET_TERMINAL_ID=caller ORCA_TERMINAL_HANDLE=other "$root/.build/megabrain" orchestrate list --json)"
printf '%s' "$precedence_output" | jq -e 'length == 1 and .[0].dispatchId == "superset-owned" and .[0].ownedByCaller == true' >/dev/null ||
  fail "Superset identity did not win over Orca identity when no session override is set: $precedence_output"
printf 'Superset identity wins over Orca identity when no session override is set\n'

override_state="$state_dir/override"
mkdir -p "$override_state/dispatches/override-owned"
printf '%s\n' '{"dispatchId":"override-owned","parentSessionId":"override-caller","parentHost":"override-host","state":"running","processState":"running","terminalState":"owned","worktreePath":"/override"}' >"$override_state/dispatches/override-owned/meta.json"
db_import "$override_state"
override_output="$(MEGABRAIN_STATE_DIR="$override_state" MEGABRAIN_SESSION_ID=override-caller MEGABRAIN_SESSION_HOST=override-host SUPERSET_TERMINAL_ID=live-superset-terminal "$root/.build/megabrain" orchestrate list --json)"
printf '%s' "$override_output" | jq -e 'length == 1 and .[0].dispatchId == "override-owned" and .[0].ownedByCaller == true' >/dev/null ||
  fail "an explicit session override did not win over a live Superset marker: $override_output"
printf 'an explicit session override wins over a live Superset marker\n'

# Dispatch ownership is tied to the creating agent session, not whichever terminal
# currently invokes the command. Each session sees exactly its own records by default.
ownership_state="$state_dir/ownership"
mkdir -p "$ownership_state/dispatches/session-a" "$ownership_state/dispatches/session-b" "$ownership_state/dispatches/legacy"
printf '%s\n' '{"dispatchId":"session-a","parentSessionId":"claude:session-a","parentHost":"claude","state":"running"}' >"$ownership_state/dispatches/session-a/meta.json"
printf '%s\n' '{"dispatchId":"session-b","parentSessionId":"codex:session-b","parentHost":"codex","state":"running"}' >"$ownership_state/dispatches/session-b/meta.json"
printf '%s\n' '{"dispatchId":"legacy","parentSessionId":"old-terminal","parentHost":"orca","state":"running"}' >"$ownership_state/dispatches/legacy/meta.json"
db_import "$ownership_state"
session_a="$(env -u MEGABRAIN_SESSION_ID -u MEGABRAIN_SESSION_HOST -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID \
  MEGABRAIN_STATE_DIR="$ownership_state" MEGABRAIN_SESSION_HOST=claude CLAUDE_CODE_SESSION_ID=session-a "$root/.build/megabrain" orchestrate list --json)"
printf '%s' "$session_a" | jq -e 'length == 1 and .[0].dispatchId == "session-a" and .[0].owner == "mine"' >/dev/null ||
  fail "session A did not see exactly its dispatch with mine ownership: $session_a"
session_b="$(env -u MEGABRAIN_SESSION_ID -u MEGABRAIN_SESSION_HOST -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID \
  MEGABRAIN_STATE_DIR="$ownership_state" MEGABRAIN_SESSION_HOST=codex CODEX_THREAD_ID=session-b "$root/.build/megabrain" orchestrate list --json)"
printf '%s' "$session_b" | jq -e 'length == 1 and .[0].dispatchId == "session-b" and .[0].owner == "mine"' >/dev/null ||
  fail "session B did not see exactly its dispatch with mine ownership: $session_b"
session_empty="$(env -u MEGABRAIN_SESSION_ID -u MEGABRAIN_SESSION_HOST -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID \
  MEGABRAIN_STATE_DIR="$ownership_state" MEGABRAIN_SESSION_HOST=claude CLAUDE_CODE_SESSION_ID=session-empty "$root/.build/megabrain" orchestrate list --json)"
[ "$session_empty" = '[]' ] || fail "a session with no dispatches saw other owners' records: $session_empty"
all_owners="$(env -u MEGABRAIN_SESSION_ID -u MEGABRAIN_SESSION_HOST -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID \
  MEGABRAIN_STATE_DIR="$ownership_state" MEGABRAIN_SESSION_HOST=claude CLAUDE_CODE_SESSION_ID=session-a "$root/.build/megabrain" orchestrate list --all --json)"
printf '%s' "$all_owners" | jq -e '([.[] | select(.owner == "mine")] | length) == 1 and ([.[] | select(.owner == "foreign")] | length) == 1 and ([.[] | select(.dispatchId == "legacy" and .owner == "unknown")] | length) == 1' >/dev/null ||
  fail "owner classifications are incorrect, especially for a legacy handle: $all_owners"
all_owners_text="$(env -u MEGABRAIN_SESSION_ID -u MEGABRAIN_SESSION_HOST -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID \
  MEGABRAIN_STATE_DIR="$ownership_state" MEGABRAIN_SESSION_HOST=claude CLAUDE_CODE_SESSION_ID=session-a "$root/.build/megabrain" orchestrate list --all)"
printf '%s\n' "$all_owners_text" | awk '
  NR == 1 { if ($0 !~ /OWNER/) exit 1; next }
  $1 == "session-a" { if ($5 != "mine") exit 1; seen_a = 1 }
  $1 == "session-b" { if ($5 != "foreign") exit 1; seen_b = 1 }
  $1 == "legacy" { if ($5 != "unknown") exit 1; seen_legacy = 1 }
  END { if (!seen_a || !seen_b || !seen_legacy) exit 1 }
' || fail "text output did not expose owner classifications by dispatch: $all_owners_text"
printf 'dispatch lists show mine, foreign, and unknown ownership by agent session\n'
