#!/usr/bin/env bash

MEGABRAIN_TMUX_SESSION_ATTEMPTS="${MEGABRAIN_TMUX_SESSION_ATTEMPTS:-600}"
MEGABRAIN_TMUX_SESSION_WAIT="${MEGABRAIN_TMUX_SESSION_WAIT:-0.1}"
MEGABRAIN_TMUX_ENTER_RETRIES="${MEGABRAIN_TMUX_ENTER_RETRIES:-3}"
MEGABRAIN_TMUX_ENTER_WAIT="${MEGABRAIN_TMUX_ENTER_WAIT:-0.5}"
MEGABRAIN_TMUX_ENTER_TIMEOUT_SECONDS="${MEGABRAIN_TMUX_ENTER_TIMEOUT_SECONDS:-30}"
MEGABRAIN_TMUX_WRITE_TIMEOUT_SECONDS="${MEGABRAIN_TMUX_WRITE_TIMEOUT_SECONDS:-2}"
MEGABRAIN_TMUX_WRITE_POLL_INTERVAL="${MEGABRAIN_TMUX_WRITE_POLL_INTERVAL:-0.05}"
MEGABRAIN_TMUX_MAIN_PANE_PERCENT=50
MEGABRAIN_TMUX_MAIN_SPLIT_FLAG='-h'
MEGABRAIN_TMUX_CHILD_SPLIT_FLAG='-v'

megabrain_tmux_session_exists() {
  local session="$1"
  tmux has-session -t "$session" 2>/dev/null
}

megabrain_tmux_set_state_dir() {
  local session="$1"
  [ -n "$session" ] || return 1
  tmux set-environment -t "$session" MEGABRAIN_STATE_DIR "$MEGABRAIN_STATE_DIR"
}

megabrain_tmux_wait_for_session() {
  local session="$1" attempt
  for ((attempt = 1; attempt <= MEGABRAIN_TMUX_SESSION_ATTEMPTS; attempt++)); do
    megabrain_tmux_session_exists "$session" && return 0
    sleep "$MEGABRAIN_TMUX_SESSION_WAIT"
  done
  return 1
}

megabrain_tmux_first_pane() {
  local session="$1"
  tmux list-panes -t "$session" -F '#{pane_id}' 2>/dev/null | head -n 1
}

megabrain_tmux_session_registry_prune() {
  local record_path record session
  for record_path in "$MEGABRAIN_TMUX_SESSION_DIR"/*.json; do
    [ -f "$record_path" ] || continue
    record="$(cat "$record_path" 2>/dev/null || true)"
    session="$(printf '%s' "$record" | jq -r '.tmuxSession // empty' 2>/dev/null || true)"
    if [ -z "$session" ] || ! megabrain_tmux_session_exists "$session"; then
      rm -f "$record_path"
    fi
  done
}

megabrain_tmux_session_registry_record_current() {
  local record_path="$1"
  jq -e '
    type == "object"
    and (.tmuxSession | type == "string" and length > 0)
    and (.agent | type == "string" and length > 0)
    and (.workingDirectory | type == "string" and length > 0)
    and (.tmuxPane | type == "string" and length > 0)
    and .role == "main"
    and (.host | type == "string" and length > 0)
    and (.createdAt | type == "string" and length > 0)
  ' "$record_path" >/dev/null 2>&1
}

megabrain_tmux_session_registry_installed_current() {
  megabrain_tmux_session_registry_record_current "$@"
}

megabrain_tmux_registry_session_for_worktree() {
  local worktree_path="$1" target record_path record session directory role
  target="$(cd "$worktree_path" 2>/dev/null && pwd -P || printf '%s' "$worktree_path")"
  megabrain_tmux_session_registry_prune
  for record_path in "$MEGABRAIN_TMUX_SESSION_DIR"/*.json; do
    [ -f "$record_path" ] || continue
    record="$(cat "$record_path" 2>/dev/null || true)"
    session="$(printf '%s' "$record" | jq -r '.tmuxSession // empty' 2>/dev/null || true)"
    directory="$(printf '%s' "$record" | jq -r '.workingDirectory // empty' 2>/dev/null || true)"
    role="$(printf '%s' "$record" | jq -r '.role // empty' 2>/dev/null || true)"
    [ "$role" = main ] || continue
    [ -n "$session" ] && [ -n "$directory" ] || continue
    directory="$(cd "$directory" 2>/dev/null && pwd -P || printf '%s' "$directory")"
    if [ "$directory" = "$target" ] && megabrain_tmux_session_exists "$session"; then
      printf '%s\n' "$session"
      return 0
    fi
  done
  return 1
}

megabrain_tmux_caller_session_for_worktree() {
  local worktree_path="$1" target caller_session record_path record session directory pane role
  [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] || return 1
  caller_session="$(megabrain_dispatch_tmux_caller_session 2>/dev/null || true)"
  [ -n "$caller_session" ] || return 1
  megabrain_tmux_session_exists "$caller_session" || return 1
  target="$(cd "$worktree_path" 2>/dev/null && pwd -P || printf '%s' "$worktree_path")"
  megabrain_tmux_session_registry_prune
  for record_path in "$MEGABRAIN_TMUX_SESSION_DIR"/*.json; do
    [ -f "$record_path" ] || continue
    record="$(cat "$record_path" 2>/dev/null || true)"
    session="$(printf '%s' "$record" | jq -r '.tmuxSession // empty' 2>/dev/null || true)"
    directory="$(printf '%s' "$record" | jq -r '.workingDirectory // empty' 2>/dev/null || true)"
    pane="$(printf '%s' "$record" | jq -r '.tmuxPane // empty' 2>/dev/null || true)"
    role="$(printf '%s' "$record" | jq -r '.role // empty' 2>/dev/null || true)"
    [ "$session" = "$caller_session" ] && [ "$pane" = "$TMUX_PANE" ] && [ "$role" = main ] || continue
    [ -n "$directory" ] || continue
    directory="$(cd "$directory" 2>/dev/null && pwd -P || printf '%s' "$directory")"
    if [ "$directory" = "$target" ]; then
      printf '%s\n' "$caller_session"
      return 0
    fi
  done
  return 1
}

megabrain_tmux_registry_main_pane_for_session() {
  local session="$1" record_path record pane role
  megabrain_tmux_session_exists "$session" || return 1
  megabrain_tmux_session_registry_prune
  for record_path in "$MEGABRAIN_TMUX_SESSION_DIR"/*.json; do
    [ -f "$record_path" ] || continue
    record="$(cat "$record_path" 2>/dev/null || true)"
    role="$(printf '%s' "$record" | jq -r '.role // empty' 2>/dev/null || true)"
    [ "$role" = main ] || continue
    pane="$(printf '%s' "$record" | jq -r --arg session "$session" 'select(.tmuxSession == $session) | .tmuxPane // empty' 2>/dev/null || true)"
    [ -n "$pane" ] || continue
    if tmux list-panes -t "$session" -F '#{pane_id}' 2>/dev/null | grep -Fx "$pane" >/dev/null 2>&1; then
      printf '%s\n' "$pane"
      return 0
    fi
  done
  return 1
}

megabrain_tmux_existing_session_for_worktree() {
  local worktree_path="$1" meta_path meta session state
  MEGABRAIN_TMUX_EXISTING_SESSION=""
  session="$(megabrain_tmux_caller_session_for_worktree "$worktree_path" 2>/dev/null || true)"
  if [ -n "$session" ]; then
    MEGABRAIN_TMUX_EXISTING_SESSION="$session"
    return 0
  fi
  for meta_path in "$MEGABRAIN_DISPATCH_DIR"/*/meta.json; do
    [ -f "$meta_path" ] || continue
    meta="$(cat "$meta_path")"
    session="$(printf '%s' "$meta" | jq -r --arg path "$worktree_path" '
      select(.runtime == "tmux" and .worktreePath == $path and .state != "closed") | .tmuxSession // empty' 2>/dev/null)"
    [ -n "$session" ] || continue
    state="$(printf '%s' "$meta" | jq -r '.state // empty')"
    case "$state" in failed|orphaned) continue ;; esac
    if megabrain_tmux_session_exists "$session"; then
      MEGABRAIN_TMUX_EXISTING_SESSION="$session"
      return 0
    fi
  done
  session="$(megabrain_tmux_registry_session_for_worktree "$worktree_path" 2>/dev/null || true)"
  if [ -n "$session" ]; then
    MEGABRAIN_TMUX_EXISTING_SESSION="$session"
    return 0
  fi
  return 1
}

megabrain_tmux_host_terminal_for_session() {
  local session="$1" meta_path meta
  for meta_path in "$MEGABRAIN_DISPATCH_DIR"/*/meta.json; do
    [ -f "$meta_path" ] || continue
    meta="$(cat "$meta_path")"
    if printf '%s' "$meta" | jq -e --arg session "$session" '.runtime == "tmux" and .tmuxSession == $session' >/dev/null 2>&1; then
      printf '%s\n' "$(printf '%s' "$meta" | jq -r '.terminalId // empty')"
      return 0
    fi
  done
  return 1
}

megabrain_tmux_main_pane_width() {
  local session="$1" window_width
  window_width="$(tmux display-message -p -t "$session" '#{window_width}' 2>/dev/null)" || return 1
  [[ "$window_width" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$((window_width * MEGABRAIN_TMUX_MAIN_PANE_PERCENT / 100))"
}

megabrain_tmux_resize_main_pane() {
  local session="$1" main_pane width
  main_pane="$(megabrain_tmux_registry_main_pane_for_session "$session")" || return 1
  width="$(megabrain_tmux_main_pane_width "$session")" || return 1
  # Each split lets tmux redistribute the window, so restore the main chat width.
  tmux resize-pane -t "$main_pane" -x "$width"
}

megabrain_tmux_last_right_pane() {
  local session="$1" main_pane main_left
  main_pane="$(megabrain_tmux_registry_main_pane_for_session "$session")" || return 1
  main_left="$(tmux display-message -p -t "$main_pane" '#{pane_left}' 2>/dev/null)" || return 1
  [[ "$main_left" =~ ^[0-9]+$ ]] || return 1
  tmux list-panes -t "$session" -F '#{pane_id} #{pane_left} #{pane_top} #{pane_index}' 2>/dev/null |
    awk -v main_left="$main_left" '
      $2 > main_left &&
      (!found || $2 > right_left || ($2 == right_left && $3 > right_top) || ($2 == right_left && $3 == right_top && $4 > right_index)) {
        pane = $1
        right_left = $2
        right_top = $3
        right_index = $4
        found = 1
      }
      END { if (found) print pane }
    '
}

megabrain_tmux_split_pane() {
  local session="$1" worktree_path main_pane right_pane target split_flag pane
  worktree_path="$2"
  main_pane="$(megabrain_tmux_registry_main_pane_for_session "$session" 2>/dev/null || true)"
  if [ -z "$main_pane" ]; then
    tmux split-window -d -t "$session" -c "$worktree_path" -P -F '#{pane_id}' 2>/dev/null
    return
  fi
  right_pane="$(megabrain_tmux_last_right_pane "$session" 2>/dev/null || true)"
  if [ -n "$right_pane" ]; then
    target="$right_pane"
    split_flag="$MEGABRAIN_TMUX_CHILD_SPLIT_FLAG"
    pane="$(tmux split-window -d "$split_flag" -t "$target" -c "$worktree_path" -P -F '#{pane_id}' 2>/dev/null)" || return 1
  else
    target="$main_pane"
    split_flag="$MEGABRAIN_TMUX_MAIN_SPLIT_FLAG"
    pane="$(tmux split-window -d "$split_flag" -p "$MEGABRAIN_TMUX_MAIN_PANE_PERCENT" -t "$target" -c "$worktree_path" -P -F '#{pane_id}' 2>/dev/null)" || return 1
  fi
  megabrain_tmux_resize_main_pane "$session" || return 1
  printf '%s\n' "$pane"
}

megabrain_tmux_send_agent() {
  local pane="$1" command_text="$2" mode="${3:-command}" attempt=0 current started now elapsed
  if [ "$mode" = prompt ]; then
    megabrain_tmux_send_text "$pane" "$command_text"
    return $?
  fi
  # WHY: the child shell can still hold startup noise or a stray keystroke, and typing
  # onto a non-empty line produced "mocd <path>" once, which died as command not found.
  # Only the shell branch is cleared; C-u in an agent composer is not a line kill.
  tmux send-keys -t "$pane" C-u || return 1
  megabrain_tmux_send_literal "$pane" "$command_text" || return 1
  # Enter is deliberately a separate call; some host terminal layers lose it when combined with text.
  case "$MEGABRAIN_TMUX_ENTER_TIMEOUT_SECONDS" in
    ''|*[!0-9]*) megabrain_error "tmux agent launch timeout must be a non-negative number of seconds"; return 1 ;;
  esac
  started="$(date +%s)"
  while :; do
    tmux send-keys -t "$pane" Enter || return 1
    attempt=$((attempt + 1))
    sleep "$MEGABRAIN_TMUX_ENTER_WAIT"
    current="$(tmux display-message -p -t "$pane" '#{pane_current_command}' 2>/dev/null || true)"
    case "$current" in
      bash|zsh|sh|dash|fish|ksh|tcsh|login|-zsh|-bash) : ;;
      *) return 0 ;;
    esac
    now="$(date +%s)"
    elapsed=$((now - started))
    if [ "$elapsed" -ge "$MEGABRAIN_TMUX_ENTER_TIMEOUT_SECONDS" ]; then
      megabrain_error "tmux did not submit the agent command in pane $pane after $attempt Enter attempts and ${MEGABRAIN_TMUX_ENTER_TIMEOUT_SECONDS}s"
      return 1
    fi
  done
}

megabrain_tmux_pipe_pane_start() {
  local pane="$1" path="$2" quoted_path
  quoted_path="$(printf '%q' "$path")"
  tmux pipe-pane -o -t "$pane" "cat >> $quoted_path"
}

megabrain_tmux_pipe_pane_stop() {
  tmux pipe-pane -t "$1"
}

megabrain_tmux_model_substitution_report() {
  local pane="$1" output report
  output="$(megabrain_tmux_capture_pane "$pane" -200 2>/dev/null || true)"
  report="$(printf '%s\n' "$output" | grep -iE 'not supported.*model|substitut|using .* instead' | tail -n 1 || true)"
  [ -n "$report" ] || return 1
  printf '%s\n' "$report"
}

megabrain_tmux_agent_output_clean() {
  local pane="$1" output
  output="$(megabrain_tmux_capture_pane "$pane" -200 2>/dev/null || true)"
  case "$output" in
    *'0;276;0c'*|*xterm.js*) return 1 ;;
  esac
}

megabrain_tmux_interrupt_affordance() {
  case "$1" in
    claude|codex) printf 'Escape\n' ;;
    *) return 1 ;;
  esac
}

MEGABRAIN_TMUX_INTERRUPT_STATUS=not-landed

megabrain_tmux_send_interrupt() {
  local pane="$1" agent="${2:-}" affordance
  MEGABRAIN_TMUX_INTERRUPT_STATUS=not-landed
  [ -n "$agent" ] || agent="$(megabrain_tmux_agent_for_pane "$pane" 2>/dev/null || true)"
  affordance="$(megabrain_tmux_interrupt_affordance "$agent" 2>/dev/null || true)"
  [ -n "$affordance" ] || return 1
  megabrain_tmux_send_lock_acquire "$pane" || return 1
  if tmux send-keys -t "$pane" "$affordance"; then
    MEGABRAIN_TMUX_INTERRUPT_STATUS=landed
  fi
  megabrain_tmux_send_lock_release
  [ "$MEGABRAIN_TMUX_INTERRUPT_STATUS" = landed ]
}

# A prompt retry only needs another chance to submit the text already accepted by the
# composer. Retyping would append a second copy when the first Enter was ignored.
megabrain_tmux_retry_prompt() {
  local pane="$1" rc=0
  MEGABRAIN_TMUX_SEND_STATUS=not-typed
  megabrain_tmux_send_lock_acquire "$pane" || return 0
  if tmux send-keys -t "$pane" Enter; then
    MEGABRAIN_TMUX_SEND_STATUS=queued
  else
    rc=1
  fi
  megabrain_tmux_send_lock_release
  return "$rc"
}

megabrain_tmux_apply_config() {
  local session="$1"
  megabrain_tmux_session_exists "$session" || return 1
  tmux set-option -t "$session" mouse on >/dev/null || return 1
  tmux set-option -t "$session" status off >/dev/null || return 1
  tmux set-option -t "$session" pane-active-border-style 'fg=green,bold' >/dev/null || return 1
  tmux set-option -t "$session" escape-time 0 >/dev/null || return 1
}

# WHY: the wrapper remains a useful installed entrypoint even before its compiled payload is built.
command_tmux() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
  megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" tmux "$@"
}

