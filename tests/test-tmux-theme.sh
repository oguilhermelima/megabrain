#!/usr/bin/env bash

set -euo pipefail

export LC_ALL=C.UTF-8

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/support/state-dir-guard.bash"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-tmux-theme.XXXXXX")"
export HOME="$work/home"
export MEGABRAIN_STATE_DIR="$work/state"
require_megabrain_test_state
mkdir -p "$HOME/.megabrain/tmux"
cp "$root/tmux/megabrain.tmux.conf" "$HOME/.megabrain/tmux/megabrain.tmux.conf"
socket="mb-theme-$$"
server=(tmux -L "$socket" -f "$HOME/.megabrain/tmux/megabrain.tmux.conf")
cleanup() {
  "${server[@]}" kill-server >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
option() { "${server[@]}" display-message -p -t theme "#{$1}"; }
header() { "${server[@]}" display-message -p -t "$1" '#{E:pane-border-format}'; }

"${server[@]}" new-session -d -s theme -n main
first="$("${server[@]}" display-message -p -t theme:main.0 '#{pane_id}')"
"${server[@]}" select-pane -t "$first" -T fallback-chat
"${server[@]}" split-window -d -h -t "$first" -P -F '#{pane_id}' >/dev/null
second="$(${server[@]} display-message -p -t theme:main.1 '#{pane_id}')"
"${server[@]}" set-option -p -t "$second" @megabrain_agent codex
"${server[@]}" set-option -p -t "$second" @megabrain_name fix-codex-liveness
"${server[@]}" set-option -p -t "$second" @megabrain_state working

fallback="$(header "$first")"
evaluated="$(header "$second")"
case "$fallback" in *fallback-chat*) ;; *) fail "pane title fallback missing from evaluated header: $fallback" ;; esac
case "$evaluated" in *codex*fix-codex-liveness*'●'*) ;; *) fail "option-backed header did not evaluate: $evaluated" ;; esac
printf 'fallback header: %s\n' "$fallback"
printf 'worker header: %s\n' "$evaluated"
current_status="$(option status)"
[ "$current_status" = off ] || fail "status must be off with one window (got: $current_status)"
global_status="$("${server[@]}" show-options -gqv status)"
[ "$global_status" = off ] || fail "global default status must be off (got: $global_status)"
window_options="$("${server[@]}" show-window-options -g)"
for setting in 'pane-border-status top' 'pane-border-lines single' 'pane-border-indicators off'; do
  case "$window_options" in *"$setting"*) ;; *) fail "missing tmux window option: $setting" ;; esac
done

"${server[@]}" new-window -t theme -n second
current_status="$(option status)"
[ "$current_status" = on ] || fail "status must be on with two windows (got: $current_status)"
"${server[@]}" kill-window -t theme:second
current_status="$(option status)"
[ "$current_status" = off ] || fail "status must return off with one window (got: $current_status)"
printf 'status: off with one window, on with two, off again with one\n'

# Reverting a live server must remove the settings that the managed block applied, even when the
# user's original config did not define those options.
revert_home="$work/revert-home"
revert_socket="mb-revert-theme-$$"
revert_server=(tmux -L "$revert_socket")
mkdir -p "$revert_home"
: > "$revert_home/.tmux.conf"
"${revert_server[@]}" -f /dev/null new-session -d -s revert
"${revert_server[@]}" new-window -t revert
revert_pane="$("${revert_server[@]}" display-message -p -t revert:0 '#{pane_id}')"
"${revert_server[@]}" send-keys -t "$revert_pane" "HOME='$revert_home' MEGABRAIN_ROOT='$root' MEGABRAIN_STATE_DIR='$work/revert-state' '$root/.build/megabrain' tmux tune --yes" Enter
for _ in {1..50}; do
  output="$("${revert_server[@]}" capture-pane -p -t "$revert_pane" -S -10)"
  [[ "$output" == *"tmux tuning applied"* ]] && break
  sleep 0.1
done
[[ "$output" == *"tmux tuning applied"* ]] || fail "could not apply the theme to the isolated server: $output"
revert_theme="$("${revert_server[@]}" show-window-options -g pane-border-status | awk '{print $2}')"
[ "$revert_theme" = top ] || fail "isolated server did not get the theme (got: $revert_theme)"
"${revert_server[@]}" send-keys -t "$revert_pane" "HOME='$revert_home' MEGABRAIN_ROOT='$root' MEGABRAIN_STATE_DIR='$work/revert-state' '$root/.build/megabrain' tmux tune --revert" Enter
for _ in {1..50}; do
  output="$("${revert_server[@]}" capture-pane -p -t "$revert_pane" -S -10)"
  [[ "$output" == *"tmux tuning reverted"* ]] && break
  sleep 0.1
done
[[ "$output" == *"tmux tuning reverted"* ]] || fail "could not revert the theme on the isolated server: $output"
reverted_theme="$("${revert_server[@]}" show-window-options -g pane-border-status | awk '{print $2}')"
[ "$reverted_theme" = off ] || fail "revert left the running server's pane border theme applied (got: $reverted_theme)"
"${revert_server[@]}" kill-server >/dev/null
printf 'revert: live server options return to defaults\n'
