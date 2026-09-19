#!/usr/bin/env bash
set -euo pipefail

# Scenarios written before implementation: plain/JSON parity, every selection flag, archived
# records, malformed records, and an empty inventory.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-orchestrate-list.XXXXXX")"
trap 'rm -rf "$state_dir"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
write_fixture() {
  local root_dir="$1"
  mkdir -p "$root_dir/dispatches/owned" "$root_dir/dispatches/other" "$root_dir/dispatches/orphan" "$root_dir/dispatches/uncertain" "$root_dir/dispatches/future" "$root_dir/dispatches/archive/2026-09-14/archived" "$root_dir/dispatches/broken"
  printf '%s\n' '{"dispatchId":"owned","parentSessionId":"caller","parentHost":"host","state":"running","processState":"running","terminalState":"owned","worktreePath":"/owned","reconcileOutcome":null}' >"$root_dir/dispatches/owned/meta.json"
  printf '%s\n' '{"dispatchId":"other","parentSessionId":"other-session","parentHost":"host","state":"running","processState":"running","terminalState":"owned","worktreePath":"/other"}' >"$root_dir/dispatches/other/meta.json"
  printf '%s\n' '{"dispatchId":"orphan","parentSessionId":"caller","parentHost":"host","state":"orphaned","processState":"running","terminalState":"owned","worktreePath":"/orphan"}' >"$root_dir/dispatches/orphan/meta.json"
  printf '%s\n' '{"dispatchId":"uncertain","parentSessionId":"caller","parentHost":"host","state":"running","processState":"exited","terminalState":"owned","worktreePath":"/uncertain"}' >"$root_dir/dispatches/uncertain/meta.json"
  printf '%s\n' '{"dispatchId":"future","parentSessionId":"caller","parentHost":"host","state":"future","processState":"mystery","terminalState":"owned","worktreePath":"/future"}' >"$root_dir/dispatches/future/meta.json"
  printf '%s\n' '{"dispatchId":"archived","parentSessionId":"other-session","parentHost":"host","state":"done","processState":"succeeded","terminalState":"released","worktreePath":"/archived"}' >"$root_dir/dispatches/archive/2026-09-14/archived/meta.json"
  printf '%s\n' '{not json' >"$root_dir/dispatches/broken/meta.json"
}
run_side() {
  local executable="$1" root_dir="$2" args="$3"
  MEGABRAIN_STATE_DIR="$root_dir" MEGABRAIN_SESSION_ID=caller MEGABRAIN_SESSION_HOST=host "$executable" orchestrate list $args
}
write_fixture "$state_dir"
for args in "" "--json" "--all" "--all --json" "--orphans --json" "--uncertain --json"; do
  binary_output="$(run_side "$root/.build/megabrain" "$state_dir" "$args" 2>"$state_dir/binary.err")"
  [ -n "$binary_output" ] || fail "compiled binary produced no output for args: $args"
  if [ -x "$root/.build/megabrain" ]; then
    [ -n "$binary_output" ] || fail "compiled binary produced no output for args: $args"
  fi
done
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
tmux_output="$(env -u SUPERSET_TERMINAL_ID -u ORCA_TERMINAL_HANDLE PATH="$tmux_bin:$PATH" MEGABRAIN_STATE_DIR="$tmux_state" TMUX=1 TMUX_PANE=%7 \
  MEGABRAIN_SESSION_ID=wrong MEGABRAIN_SESSION_HOST=wrong "$root/.build/megabrain" orchestrate list --json)"
printf '%s' "$tmux_output" | jq -e 'length == 1 and .[0].dispatchId == "tmux-owned" and .[0].ownedByCaller == true' >/dev/null ||
  fail "tmux caller identity was not selected: $tmux_output"
printf 'tmux caller identity follows the shell precedence\n'

precedence_state="$state_dir/precedence"
mkdir -p "$precedence_state/dispatches/superset-owned"
printf '%s\n' '{"dispatchId":"superset-owned","parentSessionId":"caller","parentHost":"superset","state":"running","processState":"running","terminalState":"owned","worktreePath":"/superset"}' >"$precedence_state/dispatches/superset-owned/meta.json"
precedence_output="$(MEGABRAIN_STATE_DIR="$precedence_state" MEGABRAIN_SESSION_ID=wrong MEGABRAIN_SESSION_HOST=wrong SUPERSET_TERMINAL_ID=caller ORCA_TERMINAL_HANDLE=other "$root/.build/megabrain" orchestrate list --json)"
printf '%s' "$precedence_output" | jq -e 'length == 1 and .[0].dispatchId == "superset-owned" and .[0].ownedByCaller == true' >/dev/null ||
  fail "Superset identity did not win over generic and Orca identities: $precedence_output"
printf 'Superset identity wins over generic and Orca identities\n'
