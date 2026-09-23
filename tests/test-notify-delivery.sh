#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d /tmp/mbnotify.XXXXXX)"
state_dir="$(cd -P "$state_dir" && pwd -P)"
unset TMUX TMUX_PANE
export TMUX_TMPDIR="$state_dir"
socket_name="megabrainnotify-$$"
parent_session="megabrain-notify-parent-$$"
dedicated_session="megabrain-notify-dedicated-$$"

cleanup() {
  local rc=$?
  tmux -L "$socket_name" kill-server >/dev/null 2>&1 || true
  rm -rf "$state_dir"
  return "$rc"
}
trap cleanup EXIT

export MEGABRAIN_STATE_DIR="$state_dir"
export ORCA_TERMINAL_HANDLE=parent-terminal
unset SUPERSET_TERMINAL_ID

fake_bin="$state_dir/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/orca" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = terminal ] && [ "${2:-}" = close ]; then
  printf '%s\n' '{"ok":true}'
  exit 0
fi
exit 1
EOF
chmod +x "$fake_bin/orca"
export PATH="$fake_bin:$PATH"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

tmux_cmd() {
  tmux -L "$socket_name" "$@"
}

compiled_close() {
  MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate close "$@"
}

# Fixture built directly with jq: no lib/ sourcing. Mirrors the meta.json shape spawn() writes;
# only the fields orchestrate-close.ts actually reads need to be real.
create_meta() {
  local dispatch_id="$1" session="$2" pane="$3" parent_session_arg="${4:-$2}" parent_pane_arg="${5:-$3}" agent="${6:-codex}"
  local dir="$state_dir/dispatches/$dispatch_id"
  mkdir -p "$dir/messages" "$dir/deliveries"
  jq -n --arg dispatchId "$dispatch_id" --arg worktreePath "$root" --arg agent "$agent" \
    --arg tmuxSession "$session" --arg tmuxPane "$pane" \
    --arg parentTmuxSession "$parent_session_arg" --arg parentTmuxPane "$parent_pane_arg" '{
      dispatchId: $dispatchId, parentSessionId: "parent-terminal", parentHost: "orca",
      parentTmuxSession: $parentTmuxSession, parentTmuxPane: $parentTmuxPane,
      childHost: "orca", workspaceId: "", terminalId: ($dispatchId + "-terminal"),
      worktreePath: $worktreePath, branch: "main", agent: $agent, agentId: $agent,
      model: "gpt-5", modelHonored: true, label: "label", state: "running",
      runtime: "tmux", spawnRuntime: "tmux", tmuxSession: $tmuxSession, tmuxPane: $tmuxPane,
      createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z"
    }' >"$dir/meta.json"
}

tmux_cmd new-session -d -s "$parent_session" "printf '%s' 'Working · esc to interrupt'; sleep 5"
parent_pane="$(tmux_cmd display-message -p -t "$parent_session" '#{pane_id}')"

tmux_cmd split-window -v -t "$parent_pane" -P -F '#{pane_id}' bash >/dev/null
shared_pane="$(tmux_cmd list-panes -t "$parent_session" -F '#{pane_id}' | tail -n 1)"
create_meta shared-close "$parent_session" "$shared_pane"
shared_close="$(compiled_close shared-close --json)"
assert_equal "$(printf '%s' "$shared_close" | jq -r '.message')" \
  'tmux pane removed; the shared tmux session and host terminal tab were kept.'
assert_equal "$(jq -r '.state' "$state_dir/dispatches/shared-close/meta.json")" closed
printf 'shared close reports that session and host tab were kept\n'

tmux_cmd new-session -d -s "$dedicated_session" bash
dedicated_pane="$(tmux_cmd display-message -p -t "$dedicated_session" '#{pane_id}')"
create_meta exclusive-close "$dedicated_session" "$dedicated_pane" "$parent_session" "$parent_pane"
exclusive_close="$(compiled_close exclusive-close --json)"
assert_equal "$(printf '%s' "$exclusive_close" | jq -r '.message')" \
  'last tmux pane removed; the exclusive tmux session and host terminal tab were closed.'
printf 'exclusive close reports that session and host tab were closed\n'

printf 'ok: close reporting for shared and exclusive tmux sessions\n'
