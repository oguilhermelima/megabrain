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
version_command='exec -a 2.1.296 sleep 60'
if [ "$(uname -s)" = Darwin ]; then
  cat >"$work/version.c" <<'EOF'
#include <unistd.h>
int main(void) { for (;;) sleep(60); }
EOF
  cc "$work/version.c" -o "$work/2.1.296"
  version_command="$work/2.1.296"
fi
socket="mb-tb-${RANDOM}-${RANDOM}-$$"
server=(tmux -L "$socket" -f "$HOME/.megabrain/tmux/megabrain.tmux.conf")
cleanup() {
  "${server[@]}" kill-server >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
option() { "${server[@]}" display-message -p -t theme "#{$1}"; }
header() { "${server[@]}" display-message -p -t "$1" '#{E:pane-border-format}'; }
add_pane() { "${server[@]}" split-window -d -h -t "$1" -P -F '#{pane_id}' "$2"; }

"${server[@]}" new-session -d -s theme -n main 'sleep 60'
codex="$(${server[@]} display-message -p -t theme:main.0 '#{pane_id}')"
claude="$(add_pane "$codex" 'sleep 60')"
agy="$(add_pane "$codex" 'sleep 60')"
none="$(add_pane "$codex" 'sleep 60')"
version="$(add_pane "$codex" "$version_command")"

"${server[@]}" select-pane -t "$codex" -T codex-title
"${server[@]}" select-pane -t "$claude" -T claude-title
"${server[@]}" select-pane -t "$agy" -T agy-title
"${server[@]}" select-pane -t "$none" -T none-title
"${server[@]}" select-pane -t "$version" -T version-title
"${server[@]}" set-option -p -t "$codex" @megabrain_agent codex
"${server[@]}" set-option -p -t "$codex" @megabrain_state working
"${server[@]}" set-option -p -t "$claude" @megabrain_agent claude
"${server[@]}" set-option -p -t "$claude" @megabrain_state question
"${server[@]}" set-option -p -t "$agy" @megabrain_agent agy
"${server[@]}" set-option -p -t "$agy" @megabrain_state finished
"${server[@]}" set-option -p -t "$version" @megabrain_state stuck
"${server[@]}" select-pane -t "$version"

expected_header() {
  local agent="$1" title="$2" state="$3" active="$4" badge title_style glyph
  case "$agent" in
    codex) badge='#[bg=white fg=black]' ;;
    claude) badge='#[bg=#d97757 fg=white]' ;;
    agy) badge='#[bg=blue fg=white]' ;;
    *) badge='#[fg=brightblack]' ;;
  esac
  title_style='#[fg=brightblack]'
  if [ "$active" = yes ]; then title_style='#[fg=default bold]'; fi
  glyph=''
  case "$state" in
    working) glyph=' #[fg=blue]●#[default]' ;;
    question) glyph=' #[fg=yellow]?#[default]' ;;
    finished) glyph=' #[fg=green]✓#[default]' ;;
    stuck) glyph=' #[fg=red]!#[default]' ;;
  esac
  printf '%s %s #[default] %s%s#[default]%s ' "$badge" "$agent" "$title_style" "$title" "$glyph"
}

assert_header() {
  local pane="$1" label="$2" agent="$3" title="$4" state="$5" active="$6" actual expected
  actual="$(header "$pane")"
  expected="$(expected_header "$agent" "$title" "$state" "$active")"
  [ "$actual" = "$expected" ] || fail "$label header mismatch; expected [$expected], got [$actual]"
  printf '%s header: %s\n' "$label" "$actual"
}

assert_header "$codex" codex codex codex-title working no
assert_header "$claude" claude claude claude-title question no
assert_header "$agy" agy agy agy-title finished no
assert_header "$none" fallback sleep none-title '' no
[ "$("${server[@]}" display-message -p -t "$version" '#{pane_current_command}')" = '2.1.296' ] || fail 'version pane command did not retain its version-like name'
assert_header "$version" version claude version-title stuck yes

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
