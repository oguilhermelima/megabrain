#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-multiline.XXXXXX")"
state="$work/state"
server="mb-multiline-$RANDOM-$$"
real_tmux="$(command -v tmux)"
real_node="$(command -v node)"
mkdir -p "$state"
for name in $(compgen -e); do
  case "$name" in MEGABRAIN_*|ORCA_*|TMUX*) unset "$name" ;; esac
done
export MEGABRAIN_STATE_DIR="$state"
export MB_MULTILINE_LOG="$work/submissions.log"
cleanup() {
  tmux -L "$server" kill-server >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

pane="$("$real_tmux" -L "$server" new-session -d -s proof -P -F '#{pane_id}' "env MB_MULTILINE_LOG='$MB_MULTILINE_LOG' '$real_node' '$root/tests/fixtures/multiline-agent.mjs'")"
deadline=$((SECONDS + 5))
until "$real_tmux" -L "$server" capture-pane -p -t "$pane" | grep -q READY; do
  [ "$SECONDS" -lt "$deadline" ] || fail 'stand-in agent did not start'
  sleep 0.05
done
printf '%s' $'first line\nsecond line\nthird line' >"$work/message.txt"
"$real_tmux" -L "$server" load-buffer -b multiline "$work/message.txt"
"$real_tmux" -L "$server" paste-buffer -p -d -b multiline -t "$pane"
"$real_tmux" -L "$server" send-keys -t "$pane" Enter
deadline=$((SECONDS + 5))
until [ -s "$MB_MULTILINE_LOG" ]; do
  [ "$SECONDS" -lt "$deadline" ] || fail 'stand-in agent did not receive a submission'
  sleep 0.05
done
expected=$'SUBMISSION 1\nfirst line\nsecond line\nthird line\nEND SUBMISSION'
actual="$(cat "$MB_MULTILINE_LOG")"
[ "$actual" = "$expected" ] || fail "multi-line paste was not one intact submission: $actual"
printf 'tmux bracketed paste delivered one multi-line submission\n'
