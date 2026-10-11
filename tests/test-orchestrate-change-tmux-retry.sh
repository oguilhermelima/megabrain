#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-change-tmux.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export HOME="$work/home"
export MEGABRAIN_STATE_DIR="$work/state"
mkdir -p "$HOME"
require_megabrain_test_state

server="mb-change-$RANDOM-$BASHPID"
cleanup() {
  tmux -L "$server" kill-server >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

for name in $(compgen -e); do
  case "$name" in MEGABRAIN_*|ORCA_*|TMUX*) unset "$name" ;; esac
done
export HOME="$work/home"
export MEGABRAIN_STATE_DIR="$work/state"
require_megabrain_test_state

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected '$1' to contain '$2'" ;; esac; }

[ -x "$root/.build/megabrain" ] || fail 'compiled megabrain binary missing; run bun run build first'

dispatch="change-tmux-retry"
pane="$(tmux -L "$server" new-session -d -s change -P -F '#{pane_id}' "env MEGABRAIN_DISPATCH_ID=$dispatch MB_CHANGE_LOG=$work/submitted node $root/tests/fixtures/change-agent.mjs")"
session_id="$(tmux -L "$server" display-message -p -t "$pane" '#{session_id}')"
cat >"$work/meta.json" <<EOF
{"dispatchId":"$dispatch","parentHost":"orca","parentSessionId":"parent","runtime":"tmux","tmuxSession":"change","tmuxSessionId":"$session_id","tmuxPane":"$pane","agent":"codex","agentId":"codex","state":"running","processState":"running","terminalState":"owned","createdAt":"2026-10-11T00:00:00.000Z","updatedAt":"2026-10-11T00:00:00.000Z"}
EOF
mkdir -p "$work/legacy/dispatches/$dispatch"
cp "$work/meta.json" "$work/legacy/dispatches/$dispatch/meta.json"
"$root/.build/megabrain" db import "$work/legacy" --replace --json >/dev/null

direction='Use the captured behavior and keep the change focused.'
command="env HOME=$(printf %q "$HOME") PATH=$(printf %q "$PATH") MEGABRAIN_STATE_DIR=$(printf %q "$MEGABRAIN_STATE_DIR") MEGABRAIN_SESSION_HOST=orca MEGABRAIN_SESSION_ID=parent ORCA_TERMINAL_HANDLE=parent '$root/.build/megabrain' orchestrate change '$dispatch' --text $(printf %q "$direction") --idle-timeout 2 --attempts 3 --json >$(printf %q "$work/output.json") 2>$(printf %q "$work/error.log"); printf '%s' \$? >$(printf %q "$work/status")"
tmux -L "$server" new-window -d -t change -n coordinator "$command"

deadline=$((SECONDS + 30))
while [ ! -f "$work/status" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.1; done
[ -f "$work/status" ] || fail 'coordinator command did not finish within 30 seconds'
status="$(cat "$work/status")"
output="$(cat "$work/output.json")"
assert_equal "$status" '0'
assert_contains "$output" '"attempts": 2'
assert_contains "$output" '"idleReached": true'
assert_contains "$output" '"delivered": true'
assert_contains "$(cat "$work/submitted")" '[megabrain] Change of direction from your coordinator. Stop the approach you were on and follow this instead:'
assert_contains "$(cat "$work/submitted")" "$direction"
printf 'change retries Escape in a private tmux server, proves idle, and submits the full direction\n'
