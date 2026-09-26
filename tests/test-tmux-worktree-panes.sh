#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-tmux-panes.XXXXXX")"
socket="mbpane$$"
state="$tmp/state"
fake_bin="$tmp/bin"
parent_dir="$tmp/parent"
worktree="$root"
local_worktree="$root"
parent_session="mbpane-parent"
local_session="mbpane-local"
parent_pane=""
local_pane=""
session=""

cleanup() {
  tmux -L "$socket" kill-server >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

tmux_cmd() {
  tmux -f /dev/null -L "$socket" "$@"
}

mkdir -p "$state" "$fake_bin" "$parent_dir"
cat > "$fake_bin/codex" <<'EOF'
#!/usr/bin/env bash
stty -echo -icanon
printf '› Ask Codex to do anything\n'
exec sleep 300
EOF
chmod +x "$fake_bin/codex"
export MEGABRAIN_STATE_DIR="$state"
export MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS=0
export MEGABRAIN_AGENT_READY_TIMEOUT_MS=5000
export PATH="$fake_bin:$PATH"
unset TMUX TMUX_PANE MEGABRAIN_SESSION_HOST MEGABRAIN_SESSION_ID

tmux_cmd new-session -d -s "$parent_session" -c "$parent_dir" -x 120 -y 40 bash
parent_pane="$(tmux_cmd display-message -p -t "$parent_session" '#{pane_id}')"
export TMUX="$(tmux_cmd display-message -p -t "$parent_pane" '#{socket_path},#{pid},#{session_id}')"
export TMUX_PANE="$parent_pane"

dispatches=()
panes=()
for index in 1 2 3 4 5; do
  dispatch="dispatch-pane-child-$index"
  output="$(MEGABRAIN_SPAWN_DISPATCH_ID="$dispatch" "$root/.build/megabrain" orchestrate spawn --worktree "$worktree" --agent codex --prompt "child $index" --tmux true --json 2>&1 || true)"
  if ! jq -e '.dispatchId' <<<"$output" >/dev/null 2>&1; then
    if [ -n "$session" ]; then
      printf 'pane state after failed spawn %s:\n' "$index" >&2
      tmux_cmd list-panes -s -t "$session" -F '#{window_index}|#{pane_id}|#{pane_current_command}|#{pane_current_path}' >&2 || true
      while IFS='|' read -r _window pane_id _command _path; do tmux_cmd capture-pane -p -t "$pane_id" -S -20 >&2 || true; done < <(tmux_cmd list-panes -s -t "$session" -F '#{window_index}|#{pane_id}|#{pane_current_command}|#{pane_current_path}')
    fi
    fail "spawn $index failed: $output"
  fi
  dispatches+=("$dispatch")
  meta="$state/dispatches/$dispatch/meta.json"
  [ -f "$meta" ] || fail "spawn $index did not write metadata"
  [ "$(jq -r '.dispatchId' "$meta")" = "$dispatch" ] || fail "spawn $index wrote unexpected dispatch metadata"
  panes+=("$(jq -r '.tmuxPane' "$meta")")
  if [ "$index" = 1 ]; then session="$(jq -r '.tmuxSession' "$meta")"; fi
  [ "$(jq -r '.tmuxSession' "$meta")" = "$session" ] || fail "spawn $index opened a different worktree session"
done

window_counts="$(tmux_cmd list-windows -t "$session" -F '#{window_index}:#{window_panes}')"
geometry="$(tmux_cmd list-panes -s -t "$session" -F '#{window_index}|#{pane_id}|#{pane_left}|#{pane_width}|#{pane_top}|#{window_width}|#{pane_current_path}')"
printf 'session geometry before assertions: %s\n%s\n' "$session" "$geometry"
assert_equal "$window_counts" $'0:4\n1:1'
main_row="$(tmux_cmd list-panes -t "$session:0" -F '#{pane_id}|#{pane_left}|#{pane_width}|#{pane_top}|#{window_width}|#{pane_current_path}' | sort -t '|' -k2,2n -k4,4n | head -n 1)"
IFS='|' read -r main_pane main_left main_width _main_top main_window_width main_path <<<"$main_row"
assert_equal "$main_left" 0
assert_equal "$main_path" "$worktree"
main_percent=$((main_width * 100 / main_window_width))
[ "$main_percent" -ge 48 ] && [ "$main_percent" -le 51 ] || fail "main pane was not half width: ${main_width}/${main_window_width}"

right_rows="$(tmux_cmd list-panes -t "$session:0" -F '#{pane_id}|#{pane_left}|#{pane_top}|#{pane_current_path}' | awk -F '|' '$2 > 0 { print }' | sort -t '|' -k3,3n)"
assert_equal "$(wc -l <<<"$right_rows" | tr -d ' ')" 3
right_lefts="$(awk -F '|' '{print $2}' <<<"$right_rows" | sort -u | wc -l | tr -d ' ')"
assert_equal "$right_lefts" 1
right_tops="$(awk -F '|' '{print $3}' <<<"$right_rows" | sort -u | wc -l | tr -d ' ')"
assert_equal "$right_tops" 3
while IFS='|' read -r _pane _left _top current_path; do assert_equal "$current_path" "$worktree"; done <<<"$right_rows"
fifth_window="$(tmux_cmd display-message -p -t "${panes[4]}" '#{window_index}')"
assert_equal "$fifth_window" 1
printf 'geometry windows: %s\n' "$(tr '\n' ' ' <<<"$window_counts" | sed 's/ $//')"
printf 'geometry main: left=%s width=%s/%s (%s%%)\n' "$main_left" "$main_width" "$main_window_width" "$main_percent"
printf 'geometry right children: %s\n' "$(awk -F '|' '{printf "left=%s top=%s ", $2, $3}' <<<"$right_rows" | sed 's/ $//')"
printf 'geometry fifth child: window=%s pane=%s\n' "$fifth_window" "${panes[4]}"

for index in 1 2 3 4; do
  "$root/.build/megabrain" orchestrate close "${dispatches[$((index - 1))]}" >/dev/null
  remaining="$(tmux_cmd list-panes -s -t "$session" -F '#{pane_id}')"
  case " $remaining " in *" ${panes[$((index - 1))]} "*) fail "closed child pane ${panes[$((index - 1))]} is still present" ;; esac
  tmux_cmd has-session -t "$session" || fail "worktree session ended before its last child closed"
done
assert_equal "$(tmux_cmd list-panes -t "$session" -F '#{pane_id}' | wc -l | tr -d ' ')" 1
"$root/.build/megabrain" orchestrate close "${dispatches[4]}" >/dev/null
if tmux_cmd has-session -t "$session" >/dev/null 2>&1; then fail "Megabrain worktree session survived its last child"; fi
printf 'close order: first four panes removed; final pane removed with session\n'

# A logical Orca caller with real tmux markers still uses its current pane when the target is its
# own checkout, even with tmux explicitly disabled.
tmux_cmd new-session -d -s "$local_session" -c "$local_worktree" -x 120 -y 40 bash
local_pane="$(tmux_cmd display-message -p -t "$local_session" '#{pane_id}')"
export TMUX="$(tmux_cmd display-message -p -t "$local_pane" '#{socket_path},#{pid},#{session_id}')"
export TMUX_PANE="$local_pane"
export ORCA_TERMINAL_HANDLE=orca-parent
unset MEGABRAIN_SESSION_HOST MEGABRAIN_SESSION_ID
local_output="$(MEGABRAIN_SPAWN_DISPATCH_ID=dispatch-local-orca-tmux "$root/.build/megabrain" orchestrate spawn --worktree "$local_worktree" --agent codex --prompt local --tmux false --json)"
local_dispatch="$(jq -r '.dispatchId' <<<"$local_output")"
local_meta="$state/dispatches/$local_dispatch/meta.json"
assert_equal "$(jq -r '.parentHost' "$local_meta")" orca
assert_equal "$(jq -r '.runtime' "$local_meta")" tmux
assert_equal "$(jq -r '.tmuxSession' "$local_meta")" "$local_session"
local_child="$(jq -r '.tmuxPane' "$local_meta")"
[ "$local_child" != "$local_pane" ] || fail "same-checkout child reused the caller's pane"
"$root/.build/megabrain" orchestrate close "$local_dispatch" >/dev/null
tmux_cmd display-message -p -t "$local_pane" '#{pane_id}' >/dev/null || fail "closing the child killed the caller pane"
assert_equal "$(tmux_cmd list-panes -t "$local_session" -F '#{pane_id}' | wc -l | tr -d ' ')" 1
printf 'caller case: orca identity plus TMUX opened child beside caller; caller pane survived close\n'
