#!/usr/bin/env bash
# Spawn delivers the first prompt through a stand-in agent whose first paste is swallowed down to
# its tail, and through one that stays inside an open paste, on a private tmux server. Spawn must
# repaste, close the paste, and submit exactly once; a failing spawn with --json must print JSON.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_real_home="${HOME:-}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-paste.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$tmp/.megabrain-test-state"
require_megabrain_test_state

socket="mbpaste$$"
state="$tmp/state"
export HOME="$tmp/home"
fake_bin="$tmp/bin"
worktree="$tmp/worktree"
log="$tmp/submissions.log"

cleanup() {
  tmux -L "$socket" kill-server >/dev/null 2>&1 || true
  stop_megabrain_supervisor
  rm -rf "$tmp"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
tmux_cmd() { tmux -f /dev/null -L "$socket" "$@"; }

mkdir -p "$state" "$HOME" "$fake_bin" "$worktree"
export MEGABRAIN_STATE_DIR="$state"
[ "$(cd "$MEGABRAIN_STATE_DIR" && pwd -P)" != "$(cd "$test_real_home/.megabrain" 2>/dev/null && pwd -P || echo none)" ] || fail "refusing real-home state"
git -C "$worktree" init -q
git -C "$worktree" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init
worktree="$(cd "$worktree" && pwd -P)"

export REAL_TMUX="$(command -v tmux)"
export TMUX_TEST_SOCKET="$socket"
cat > "$fake_bin/tmux" <<'WRAP'
#!/usr/bin/env bash
command_name=""; target=""; previous=""
for arg in "$@"; do
  [ -n "$command_name" ] || case "$arg" in new-session) command_name="$arg" ;; esac
  if [ "$previous" = -s ]; then target="$arg"; fi
  previous="$arg"
done
"$REAL_TMUX" -f /dev/null -L "$TMUX_TEST_SOCKET" "$@"
status=$?
if [ "$command_name" = new-session ] && [ -n "$target" ]; then
  "$REAL_TMUX" -f /dev/null -L "$TMUX_TEST_SOCKET" set-environment -t "$target" PATH "$PATH"
fi
exit "$status"
WRAP
chmod +x "$fake_bin/tmux"
cat > "$fake_bin/codex" <<WRAP
#!/usr/bin/env bash
exec node "$root/tests/fixtures/paste-agent.mjs" 2>>"$tmp/agent.err"
WRAP
chmod +x "$fake_bin/codex"
export PATH="$fake_bin:$PATH"
# The pane's shell rebuilds PATH from its own startup files, so the stand-in must be on it there too.
printf 'export PATH=%q:$PATH\n' "$fake_bin" > "$HOME/.bashrc"
printf '. "$HOME/.bashrc"\n' > "$HOME/.bash_profile"
tmux_cmd() { tmux -f /dev/null -L "$socket" "$@"; }
export MB_PASTE_LOG="$log" MB_PASTE_RECEIVE=1 MB_MEGABRAIN="$root/.build/megabrain"
export MEGABRAIN_AGENT_READY_TIMEOUT_MS=15000
unset TMUX TMUX_PANE MEGABRAIN_SESSION_HOST MEGABRAIN_SESSION_ID MEGABRAIN_DISPATCH_ID

tmux_cmd new-session -d -s parent -c "$tmp" -x 160 -y 50 bash
parent_pane="$(tmux_cmd display-message -p -t parent '#{pane_id}')"
export TMUX="$(tmux_cmd display-message -p -t "$parent_pane" '#{socket_path},#{pid},#{session_id}')"
export TMUX_PANE="$parent_pane"

brief="$(for i in $(seq 1 60); do printf 'line %02d abcdefghij klmnopqrstuvwxyz abcdefghij klmnopqrstuvwxyz\n' "$i"; done)"

run_case() {
  local name="$1" dispatch="$2"; shift 2
  : > "$log"
  local output
  output="$(env "$@" MEGABRAIN_SPAWN_DISPATCH_ID="$dispatch" "$root/.build/megabrain" orchestrate spawn --worktree "$worktree" --agent codex --prompt "$brief" --tmux true --json 2>"$tmp/$name.err")" \
    || {
      cat "$tmp/$name.err" >&2
      [ ! -f "$tmp/agent.err" ] || cat "$tmp/agent.err" >&2
      "$root/.build/megabrain" db show "$dispatch" --json 2>&1 | jq -r '.. | objects | select(.type? == "readiness-frame") | .text' >&2 || true
      printf '%s\n' "$output" >&2
      while read -r pane_id; do printf -- '--- pane %s\n' "$pane_id" >&2; tmux_cmd capture-pane -p -t "$pane_id" >&2 || true; done < <(tmux_cmd list-panes -a -F '#{pane_id}')
      fail "$name: spawn failed"
    }
  jq -e --arg id "$dispatch" '.dispatchId == $id and .status == "spawned"' <<<"$output" >/dev/null || fail "$name: unexpected spawn JSON: $output"
  printf '%s\n' "$output"
}

# 1. The first paste arrives as its last 400 bytes only: spawn must clear, paste again and submit once.
run_case swallowed dispatch-paste-swallowed MB_PASTE_SWALLOW=1 >/dev/null
submissions="$(grep -c '^SUBMISSION ' "$log")"
[ "$submissions" = 1 ] || fail "swallowed first paste: expected one submission, got $submissions"
grep -q 'line 01 abcdefghij' "$log" || fail "swallowed first paste: the submission lost the start of the brief"
grep -q 'line 60 abcdefghij' "$log" || fail "swallowed first paste: the submission lost the end of the brief"
printf 'swallowed first paste: repasted, one whole submission\n'

# 2. The paste is left open: Enter is a newline until the end marker arrives.
run_case open dispatch-paste-open MB_PASTE_OPEN=1 >/dev/null
submissions="$(grep -c '^SUBMISSION ' "$log")"
[ "$submissions" = 1 ] || fail "open paste: expected one submission, got $submissions"
grep -q 'line 60 abcdefghij' "$log" || fail "open paste: the submission lost the end of the brief"
printf 'open paste: end marker sent, one whole submission\n'

# 3. A failing spawn prints one JSON object, not text.
out="$("$root/.build/megabrain" orchestrate spawn --json --agent codex 2>/dev/null || true)"
jq -e '.status == "failed" and (.error | type == "string")' <<<"$out" >/dev/null || fail "failing spawn --json did not print JSON: $out"
printf 'failing spawn --json: valid JSON\n'
