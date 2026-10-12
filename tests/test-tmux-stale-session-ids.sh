#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_real_home="${HOME:-}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-tmux-stale-ids.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$tmp/.megabrain-test-state"
require_megabrain_test_state

socket="mbstale$$"
state="$tmp/state"
fake_bin="$tmp/bin"
export HOME="$tmp/home"
worktree_one="$tmp/worktree-one"
worktree_two="$tmp/worktree-two"
worktree_three="$tmp/worktree-three"
worktree_four="$tmp/worktree-four"
dispatches=(stale-seed-one stale-seed-two stale-new-one stale-new-two)

cleanup() {
  tmux -f /dev/null -L "$socket" kill-server >/dev/null 2>&1 || true
  remove_test_dir "$tmp"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
tmux_cmd() { tmux -f /dev/null -L "$socket" "$@"; }
db_session() { "$root/.build/megabrain" db show "$1" --json | jq -r '.meta.tmuxSession'; }

mkdir -p "$state" "$HOME" "$fake_bin"
export MEGABRAIN_STATE_DIR="$state"
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
cat > "$fake_bin/codex" <<WRAP
#!/usr/bin/env bash
exec node "$root/tests/fixtures/paste-agent.mjs" 2>>"$tmp/agent.err"
WRAP
chmod +x "$fake_bin/tmux" "$fake_bin/codex"
export PATH="$fake_bin:$PATH"
printf 'export PATH=%q:$PATH\n' "$fake_bin" > "$HOME/.bashrc"
printf '. "$HOME/.bashrc"\n' > "$HOME/.bash_profile"
export MB_PASTE_RECEIVE=1 MB_MEGABRAIN="$root/.build/megabrain"
export MEGABRAIN_AGENT_READY_TIMEOUT_MS=15000
unset TMUX TMUX_PANE MEGABRAIN_SESSION_HOST MEGABRAIN_SESSION_ID MEGABRAIN_DISPATCH_ID
export MEGABRAIN_SESSION_ID="tmux-stale-session-id-test"
export MEGABRAIN_SESSION_HOST=local

make_worktree() {
  local directory="$1"
  mkdir -p "$directory"
  git -C "$directory" init -q
  git -C "$directory" -c user.email=test@example.com -c user.name=test commit -q --allow-empty -m init
}

spawn() {
  local index="$1" directory="$2" output
  output="$(MEGABRAIN_SPAWN_DISPATCH_ID="${dispatches[$index]}" "$root/.build/megabrain" orchestrate spawn \
    --worktree "$directory" --agent codex --prompt "spawn ${dispatches[$index]}" --tmux true --terminal none --json 2>&1)" ||
      fail "spawn ${dispatches[$index]} failed: $output"
  jq -e --arg id "${dispatches[$index]}" '.status == "spawned" and .dispatchId == $id' <<<"$output" >/dev/null ||
    fail "spawn ${dispatches[$index]} returned unexpected output: $output"
  printf '%s\n' "$output"
}

for directory in "$worktree_one" "$worktree_two" "$worktree_three" "$worktree_four"; do make_worktree "$directory"; done

# Keep $0 occupied so the rows left behind by this server restart begin at $1.
tmux_cmd new-session -d -s anchor -c "$tmp" -x 160 -y 50 bash
seed_one="$(spawn 0 "$worktree_one")"
seed_two="$(spawn 1 "$worktree_two")"
seed_one_session="$(db_session "${dispatches[0]}")"
seed_two_session="$(db_session "${dispatches[1]}")"
seed_one_id="$(tmux_cmd display-message -p -t "$seed_one_session" '#{session_id}')"
seed_two_id="$(tmux_cmd display-message -p -t "$seed_two_session" '#{session_id}')"
[ "$seed_one_id" = '$1' ] || fail "first persisted session $seed_one_session did not receive \$1 (got $seed_one_id)"
[ "$seed_two_id" = '$2' ] || fail "second persisted session did not receive \$2 (got $seed_two_id)"

tmux_cmd kill-server
new_one="$(spawn 2 "$worktree_three")"
new_two="$(spawn 3 "$worktree_four")"
new_one_session="$(db_session "${dispatches[2]}")"
new_two_session="$(db_session "${dispatches[3]}")"
new_one_id="$(tmux_cmd display-message -p -t "$new_one_session" '#{session_id}')"
new_two_id="$(tmux_cmd display-message -p -t "$new_two_session" '#{session_id}')"
[ "$new_one_id" = '$0' ] || fail "first post-restart spawn did not receive \$0 (got $new_one_id)"
[ "$new_two_id" = '$1' ] || fail "second post-restart spawn did not receive \$1 (got $new_two_id)"
printf 'both post-restart spawns succeeded with reused tmux ids $0 and $1\n'

for dispatch in "${dispatches[@]}"; do "$root/.build/megabrain" orchestrate close "$dispatch" >/dev/null; done
if tmux_cmd list-sessions >/dev/null 2>&1; then fail 'tmux sessions remain after closing all dispatches'; fi
printf 'no tmux sessions remain after cleanup\n'
