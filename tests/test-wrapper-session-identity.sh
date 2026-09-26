#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "/tmp/mbw.XXXXXX")"
export TMUX_TMPDIR="$work/tmux"
mkdir -p "$TMUX_TMPDIR" "$work/bin"
real_tmux="$(command -v tmux)"
trap 'TMUX_TMPDIR="$TMUX_TMPDIR" "$real_tmux" -f /dev/null kill-server >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# WHY: tmux sessions inherit the server's global environment by default. Give the isolated
# server a foreign terminal and a workspace value that the caller does not have, then exercise
# the actual shell wrapper through a PTY (the wrapper deliberately bypasses noninteractive use).
"$real_tmux" -f /dev/null new-session -d -s identity-seed 'sleep 60'
"$real_tmux" -f /dev/null set-environment -g ORCA_TERMINAL_HANDLE foreign-terminal
"$real_tmux" -f /dev/null set-environment -g ORCA_WORKSPACE_ID foreign-workspace

# Ignore the user's tmux configuration while retaining a private default socket.
cat >"$work/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
exec "$REAL_TMUX" -f /dev/null "$@"
TMUX
chmod +x "$work/bin/tmux"

cat >"$work/bin/claude" <<'AGENT'
#!/usr/bin/env bash
printf 'TMUX=%s TMUX_PANE=%s\n' "${TMUX-}" "${TMUX_PANE-}" >"$OUTPUT"
env | LC_ALL=C sort | sed -n '/^ORCA_TERMINAL_HANDLE=/p; /^ORCA_WORKSPACE_ID=/p' >>"$OUTPUT"
sleep 1
AGENT
chmod +x "$work/bin/claude"

run_case() { # run_case <shell> <wrapper>
  local shell="$1" label="${1##*/}" wrapper="$2" output
  "$real_tmux" -f /dev/null set-environment -g OUTPUT "$work/env-$label"
  env -u ORCA_WORKSPACE_ID -u ORCA_AGENT_LAUNCH_TOKEN -u MEGABRAIN_NO_TMUX -u TMUX -u TMUX_PANE \
    REAL_TMUX="$real_tmux" OUTPUT="$work/env-$label" PATH="$work/bin:$PATH" ORCA_TERMINAL_HANDLE=caller-terminal \
    MEGABRAIN_STATE_DIR="$work/state-$label" python3 -c \
    'import pty, sys; raise SystemExit(pty.spawn(sys.argv[1:]))' \
    "$shell" -c 'source "$1"; claude' _ "$root/$wrapper" >"$work/pty-$label.log" 2>&1 || true
  output="$(cat "$work/env-$label" 2>/dev/null || true)"
  printf '%s\n' "$output"
  case "$output" in *'TMUX='*'TMUX_PANE='*) ;; *) fail "$shell wrapper did not run inside tmux: $(cat "$work/pty-$label.log" 2>/dev/null || true)" ;; esac
  case "$output" in *'ORCA_TERMINAL_HANDLE=caller-terminal'*) ;; *) fail "$shell wrapper did not pass the caller terminal identity: $output" ;; esac
  case "$output" in *'ORCA_WORKSPACE_ID='*) fail "$shell wrapper leaked the server workspace identity: $output" ;; esac
  printf '%s wrapper passes caller identity and omits caller-unset identity\n' "$shell"
}

run_case /bin/bash bash/megabrain-agent-tmux.bash
if [ -x /bin/zsh ]; then
  run_case /bin/zsh zsh/megabrain-agent-tmux.zsh
else
  printf 'skip: zsh wrapper identity case requires /bin/zsh\n'
fi
printf 'ok: shell wrappers preserve caller identity across isolated tmux sessions\n'
