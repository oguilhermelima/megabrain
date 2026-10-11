#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
binary="$root/.build/megabrain"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-supervise.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export HOME="$state_dir/home"
export MEGABRAIN_STATE_DIR="$state_dir/state"
mkdir -p "$HOME" "$MEGABRAIN_STATE_DIR"
require_megabrain_test_state

socket="mb-sup-$RANDOM-$$"
tmux_bin="$(command -v tmux)"
wrapper_dir="$state_dir/bin"
mkdir -p "$wrapper_dir"
cat >"$wrapper_dir/tmux" <<EOF
#!/usr/bin/env bash
exec "$tmux_bin" -L "$socket" "\$@"
EOF
chmod +x "$wrapper_dir/tmux"
export PATH="$wrapper_dir:$PATH"

cleanup() {
  "$tmux_bin" -L "$socket" kill-server 2>/dev/null || true
  if [ -n "${agent_pid:-}" ]; then kill "$agent_pid" 2>/dev/null || true; fi
  rm -rf "$state_dir"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

"$tmux_bin" -L "$socket" new-session -d -s supervise-test 'sleep 300'
"$tmux_bin" -L "$socket" set-option -g remain-on-exit on
pane="$("$tmux_bin" -L "$socket" display-message -p -t supervise-test '#{pane_id}')"
agent_pid="$("$tmux_bin" -L "$socket" display-message -p -t "$pane" '#{pane_pid}')"
session_id="$("$tmux_bin" -L "$socket" display-message -p -t supervise-test '#{session_id}')"

DISPATCH_ID=supervise-killed-agent PANE_ID="$pane" SESSION_ID="$session_id" AGENT_PID="$agent_pid" bun --eval '
  import { stateDatabase, createDispatch } from "./src/adapters/state-db.ts";
  const db = stateDatabase(process.env);
  if (db.kind !== "ok") throw new Error(db.error);
  const created = createDispatch(db.value, { dispatchId: process.env.DISPATCH_ID, state: "running", processState: "running", runtime: "tmux", agent: "codex", worktreePath: process.cwd(), tmuxPane: process.env.PANE_ID, tmuxSessionId: process.env.SESSION_ID, agentPid: Number(process.env.AGENT_PID), parentSessionId: "parent", parentHost: "tmux", parentTerminalId: "parent" });
  if (created.kind !== "ok") throw new Error(created.error);
  db.value.close();
'

export MEGABRAIN_SUPERVISE_INTERVAL_SECONDS=1
"$binary" supervise >/dev/null
kill "$agent_pid"

for _ in $(seq 1 30); do
  message="$("$binary" db show supervise-killed-agent --json)"
  if jq -e '.messages[] | select(.type == "supervise" and (.text | contains("process-exited")))' <<<"$message" >/dev/null; then
    printf 'PASS: dead stand-in agent produced a process-exited notice\n'
    exit 0
  fi
  sleep 1
done
fail 'supervisor did not report the killed stand-in agent'
