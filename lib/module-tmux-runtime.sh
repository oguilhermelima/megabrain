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
MEGABRAIN_TMUX_TUNE_START='# >>> megabrain tmux tuning >>>'
MEGABRAIN_TMUX_TUNE_END='# <<< megabrain tmux tuning <<<'
MEGABRAIN_TMUX_TUNE_SOURCE='source-file ~/.megabrain/tmux/megabrain.tmux.conf'
MEGABRAIN_TMUX_WRAPPER_START='# >>> megabrain tmux wrapper >>>'
MEGABRAIN_TMUX_WRAPPER_END='# <<< megabrain tmux wrapper <<<'
# The login shell decides which twin is installed and which rc file sources it. zsh is the
# default only because it is what macOS ships; a Linux box with no zsh gets the bash one.
megabrain_tmux_wrapper_shell() {
  case "${SHELL:-}" in
    *zsh) printf 'zsh\n' ;;
    *bash) printf 'bash\n' ;;
    *) printf '%s\n' "${SHELL:-unknown}" ;;
  esac
}

megabrain_tmux_wrapper_source_line() {
  case "$(megabrain_tmux_wrapper_shell)" in
    zsh) printf 'source ~/.megabrain/zsh/megabrain-agent-tmux.zsh\n' ;;
    bash) printf 'source ~/.megabrain/bash/megabrain-agent-tmux.bash\n' ;;
    *) return 1 ;;
  esac
}
MEGABRAIN_TMUX_WRAPPER_SOURCE="$(megabrain_tmux_wrapper_source_line 2>/dev/null || printf 'source ~/.megabrain/zsh/megabrain-agent-tmux.zsh')"

megabrain_tmux_available() {
  megabrain_require_command tmux
}

megabrain_tmux_version() {
  tmux -V 2>/dev/null
}

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

megabrain_tmux_session_registry_drift() {
  local record_path
  for record_path in "$MEGABRAIN_TMUX_SESSION_DIR"/*.json; do
    [ -f "$record_path" ] || continue
    megabrain_tmux_session_registry_record_current "$record_path" || printf '%s\n' "${record_path##*/}"
  done
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

megabrain_tmux_capture_pane() {
  local pane="$1" start="${2:--2000}"
  tmux capture-pane -p -t "$pane" -S "$start"
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

# tmux is only the best-effort transport. Prompt delivery is confirmed by the child via
# the durable received message in its dispatch queue.
megabrain_tmux_kill_process_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    megabrain_tmux_kill_process_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

megabrain_tmux_send_literal() {
  local pane="$1" text="$2" write_pid started now elapsed write_state write_status
  case "$MEGABRAIN_TMUX_WRITE_TIMEOUT_SECONDS" in
    ''|*[!0-9]*) megabrain_error "tmux write timeout must be a non-negative number of seconds"; return 1 ;;
  esac
  tmux send-keys -t "$pane" -l "$text" &
  write_pid=$!
  started="$(date +%s)"
  while :; do
    write_state="$(ps -p "$write_pid" -o stat= 2>/dev/null | tr -d '[:space:]' || true)"
    case "$write_state" in
      ''|Z*) break ;;
    esac
    now="$(date +%s)"
    elapsed=$((now - started))
    if [ "$elapsed" -ge "$MEGABRAIN_TMUX_WRITE_TIMEOUT_SECONDS" ]; then
      megabrain_tmux_kill_process_tree "$write_pid"
      wait "$write_pid" 2>/dev/null || true
      megabrain_error "tmux nudge did not land in pane $pane within ${MEGABRAIN_TMUX_WRITE_TIMEOUT_SECONDS}s"
      return 1
    fi
    sleep "$MEGABRAIN_TMUX_WRITE_POLL_INTERVAL"
  done
  if wait "$write_pid" 2>/dev/null; then
    write_status=0
  else
    write_status="$?"
  fi
  [ "$write_status" -eq 0 ] || return "$write_status"
}

megabrain_tmux_nudge_affordance() {
  case "$1" in
    claude) printf 'Enter\n' ;;
    codex) printf 'Tab\n' ;;
    *) return 1 ;;
  esac
}

megabrain_tmux_interrupt_affordance() {
  case "$1" in
    claude|codex) printf 'Escape\n' ;;
    *) return 1 ;;
  esac
}

megabrain_tmux_agent_for_pane() {
  local pane="$1" session="" record_path="" record="" agent="" record_match="" record_state="" record_agent="" resolved_agent=""
  session="$(tmux display-message -p -t "$pane" '#{session_name}' 2>/dev/null || true)"
  [ -n "$session" ] || return 1
  # A worker parent pane is owned by a dispatch, not necessarily by the tmux
  # session's registered main pane. Prefer this source because it identifies child
  # panes directly and records the worker's agent.
  for record_path in "$MEGABRAIN_DISPATCH_DIR"/*/meta.json; do
    [ -f "$record_path" ] || continue
    record="$(cat "$record_path" 2>/dev/null || true)"
    record_match="$(printf '%s' "$record" | jq -r --arg session "$session" --arg pane "$pane" '
      select(.runtime == "tmux" and .tmuxSession == $session and .tmuxPane == $pane) |
      [.state // empty, .agent // empty] | @tsv' 2>/dev/null || true)"
    while IFS=$'\t' read -r record_state record_agent; do
      megabrain_dispatch_state_is_open "$record_state" || continue
      agent="$record_agent"
    done <<EOF
$record_match
EOF
    [ -n "$agent" ] || continue
    if [ -n "$resolved_agent" ] && [ "$resolved_agent" != "$agent" ]; then
      return 1
    fi
    resolved_agent="$agent"
  done
  if [ -n "$resolved_agent" ]; then
    printf '%s\n' "$resolved_agent"
    return 0
  fi

  # A top-level coordinator is not a dispatch. Its session registry record is the
  # next authoritative source; an absent record means the agent is unknown, never
  # an invitation to assume Claude.
  resolved_agent=""
  for record_path in "$MEGABRAIN_TMUX_SESSION_DIR"/*.json; do
    [ -f "$record_path" ] || continue
    record="$(cat "$record_path" 2>/dev/null || true)"
    agent="$(printf '%s' "$record" | jq -r --arg session "$session" --arg pane "$pane" '
      select(.tmuxSession == $session and .tmuxPane == $pane and .role == "main") |
      .agent // empty' 2>/dev/null || true)"
    [ -n "$agent" ] || continue
    if [ -n "$resolved_agent" ] && [ "$resolved_agent" != "$agent" ]; then
      return 1
    fi
    resolved_agent="$agent"
  done
  [ -n "$resolved_agent" ] || return 1
  printf '%s\n' "$resolved_agent"
}

megabrain_tmux_send_lock_path() {
  local pane="$1" key lock_dir
  lock_dir="${MEGABRAIN_STATE_DIR:-${TMPDIR:-/tmp}/megabrain}/tmux-send-locks"
  key="$(printf '%s' "$pane" | LC_ALL=C tr -c 'A-Za-z0-9_.-' '_')"
  printf '%s/%s.lock\n' "$lock_dir" "$key"
}

megabrain_tmux_send_lock_acquire() {
  local pane="$1" lock
  lock="$(megabrain_tmux_send_lock_path "$pane")" || return 1
  mkdir -p "${lock%/*}" || return 1
  while ! mkdir "$lock" 2>/dev/null; do
    sleep 0.02
  done
  MEGABRAIN_TMUX_SEND_LOCK_PATH="$lock"
}

megabrain_tmux_send_lock_release() {
  [ -n "${MEGABRAIN_TMUX_SEND_LOCK_PATH:-}" ] || return 0
  rmdir "$MEGABRAIN_TMUX_SEND_LOCK_PATH" 2>/dev/null || true
  MEGABRAIN_TMUX_SEND_LOCK_PATH=""
}

megabrain_tmux_clear_typed_text() {
  local pane="$1" text="$2" text_length
  text_length="${#text}"
  tmux send-keys -t "$pane" C-e || return 1
  [ "$text_length" -eq 0 ] || tmux send-keys -N "$text_length" -t "$pane" BSpace || return 1
}

megabrain_tmux_nudge_text_for_pane() {
  local pane="$1" text="$2" pane_width text_length
  pane_width="$(tmux display-message -p -t "$pane" '#{pane_width}' 2>/dev/null || true)"
  text="$(printf '%s' "$text" | tr '\r\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//')"
  case "$pane_width" in
    ''|*[!0-9]*|0)
      printf '%s\n' "$text"
      return 0
      ;;
  esac
  text_length="$(printf '%s' "$text" | wc -m | tr -d ' ')"
  if [ "$text_length" -le "$pane_width" ]; then
    printf '%s\n' "$text"
  elif [ "$pane_width" -eq 1 ]; then
    printf '…\n'
  else
    printf '%s…\n' "$(printf '%s' "$text" | cut -c 1-$((pane_width - 1)))"
  fi
}

megabrain_tmux_send_nudge() {
  local pane="$1" text="$2" agent="${MEGABRAIN_TMUX_NUDGE_AGENT:-}"
  if [ "$#" -ge 3 ]; then
    agent="$3"
  fi
  if [ -z "$agent" ]; then
    agent="$(megabrain_tmux_agent_for_pane "$pane" 2>/dev/null || true)"
  fi
  text="$(megabrain_tmux_nudge_text_for_pane "$pane" "$text")"
  megabrain_tmux_send_text "$pane" "$text" "$agent" nudge
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

megabrain_tmux_send_text() {
  local pane="$1" text="$2" agent="${3:-}" mode="${4:-prompt}" affordance rc
  MEGABRAIN_TMUX_SEND_STATUS=not-typed
  if [ "$mode" = nudge ]; then
    affordance="$(megabrain_tmux_nudge_affordance "$agent" 2>/dev/null || true)"
    # The queue is authoritative. With no measured affordance, do not risk leaving a
    # pointer in an agent composer; the caller already has the durable message.
    [ -n "$affordance" ] || return 0
  else
    affordance=Enter
  fi

  # Text and its Enter are one transaction for the pane. This prevents concurrent
  # nudges from sharing a composer line or consuming one another's submission key.
  megabrain_tmux_send_lock_acquire "$pane" || return 0
  rc=0
  if ! megabrain_tmux_send_literal "$pane" "$text"; then
    megabrain_tmux_clear_typed_text "$pane" "$text" >/dev/null 2>&1 || rc=1
  elif ! tmux send-keys -t "$pane" "$affordance"; then
    megabrain_tmux_clear_typed_text "$pane" "$text" >/dev/null 2>&1 || rc=1
  else
    MEGABRAIN_TMUX_SEND_STATUS=queued
  fi
  megabrain_tmux_send_lock_release
  return "$rc"
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

megabrain_tmux_config_applied() {
  local session option value
  while IFS= read -r session; do
    [ -n "$session" ] || continue
    case "$session" in megabrain-*) ;; *) continue ;; esac
    option="$(tmux show-options -t "$session" -v mouse 2>/dev/null || true)"
    [ "$option" = on ] || continue
    option="$(tmux show-options -t "$session" -v status 2>/dev/null || true)"
    [ "$option" = off ] || continue
    option="$(tmux show-options -t "$session" -v escape-time 2>/dev/null || true)"
    [ "$option" = 0 ] || continue
    value="$(tmux show-options -t "$session" -v pane-active-border-style 2>/dev/null || true)"
    [ -n "$value" ] && return 0
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
  return 1
}

megabrain_tmux_tuning_repo_path() {
  printf '%s/tmux/megabrain.tmux.conf\n' "$MEGABRAIN_ROOT"
}

megabrain_tmux_tuning_install_path() {
  printf '%s/.megabrain/tmux/megabrain.tmux.conf\n' "$HOME"
}

megabrain_tmux_tuning_config_path() {
  printf '%s/.tmux.conf\n' "$HOME"
}

megabrain_tmux_tuning_validate_config() {
  local config="$1" starts ends
  [ -e "$config" ] || return 0
  [ -f "$config" ] || {
    megabrain_error "tmux config exists but is not a regular file: $config"
    return 1
  }
  starts="$(grep -Fxc "$MEGABRAIN_TMUX_TUNE_START" "$config" 2>/dev/null || true)"
  ends="$(grep -Fxc "$MEGABRAIN_TMUX_TUNE_END" "$config" 2>/dev/null || true)"
  if [ "$starts" -ne "$ends" ]; then
    megabrain_error "tmux config has an incomplete legacy tuning block: $config"
    return 1
  fi
}

megabrain_tmux_tuning_block_present() {
  local config="$1" starts ends source_lines
  [ -f "$config" ] || return 1
  starts="$(grep -Fxc "$MEGABRAIN_TMUX_TUNE_START" "$config" 2>/dev/null || true)"
  ends="$(grep -Fxc "$MEGABRAIN_TMUX_TUNE_END" "$config" 2>/dev/null || true)"
  source_lines="$(grep -Fxc "$MEGABRAIN_TMUX_TUNE_SOURCE" "$config" 2>/dev/null || true)"
  [ "$starts" -eq 1 ] && [ "$ends" -eq 1 ] && [ "$source_lines" -eq 1 ]
}

megabrain_tmux_tuning_installed_current() {
  cmp -s "$(megabrain_tmux_tuning_repo_path)" "$(megabrain_tmux_tuning_install_path)"
}

megabrain_tmux_tuning_next_backup_path() {
  local config="$1" stamp path suffix=1
  [ -f "$config" ] || return 0
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  path="${config}.megabrain-backup-${stamp}"
  # Never overwrite an existing backup from an earlier apply.
  while [ -e "$path" ]; do
    path="${config}.megabrain-backup-${stamp}-${suffix}"
    suffix=$((suffix + 1))
  done
  printf '%s\n' "$path"
}

megabrain_tmux_tuning_backup_paths() {
  local path
  for path in "$HOME"/.tmux.conf.megabrain-backup-*; do
    [ -f "$path" ] || continue
    printf '%s\n' "$path"
  done
}

megabrain_tmux_tuning_backup_paths_json() {
  megabrain_tmux_tuning_backup_paths | jq -Rsc 'split("\n") | map(select(length > 0))'
}

megabrain_tmux_tuning_server_running() {
  megabrain_require_command tmux || return 1
  tmux list-sessions >/dev/null 2>&1
}

megabrain_tmux_tuning_server_has_rgb() {
  local features
  features="$(tmux show-options -gqv terminal-features 2>/dev/null || true)"
  printf '%s\n' "$features" | tr ',' '\n' | grep -Eq '(^|:)RGB($|:)'
}

megabrain_tmux_tuning_install_file() {
  local repo="$1" install_path temp
  install_path="$(megabrain_tmux_tuning_install_path)"
  mkdir -p "$(dirname "$install_path")" || return 1
  temp="$(mktemp "${install_path}.XXXXXX")" || return 1
  if ! cp "$repo" "$temp" || ! mv -f "$temp" "$install_path"; then
    rm -f "$temp"
    return 1
  fi
}

megabrain_tmux_tuning_write_config() {
  local config="$1" temp
  temp="$(mktemp "${config}.XXXXXX")" || return 1
  if [ -f "$config" ]; then
    set -- "$config"
  else
    set -- /dev/null
  fi
  if ! awk -v start="$MEGABRAIN_TMUX_TUNE_START" \
    -v end="$MEGABRAIN_TMUX_TUNE_END" \
    -v source="$MEGABRAIN_TMUX_TUNE_SOURCE" '
    $0 == start {
      if (!replaced) {
        print start
        print source
        print end
        replaced = 1
      }
      in_block = 1
      next
    }
    in_block && $0 == end { in_block = 0; next }
    !in_block { print }
    END {
      if (!replaced) {
        print start
        print source
        print end
      }
    }
  ' "$1" >"$temp"; then
    rm -f "$temp"
    return 1
  fi
  if ! mv -f "$temp" "$config"; then
    rm -f "$temp"
    return 1
  fi
}

megabrain_tmux_tuning_remove_block() {
  local config="$1" temp
  temp="$(mktemp "${config}.XXXXXX")" || return 1
  if ! awk -v start="$MEGABRAIN_TMUX_TUNE_START" -v end="$MEGABRAIN_TMUX_TUNE_END" '
    $0 == start { in_block = 1; next }
    in_block && $0 == end { in_block = 0; next }
    !in_block { print }
  ' "$config" >"$temp"; then
    rm -f "$temp"
    return 1
  fi
  if ! mv -f "$temp" "$config"; then
    rm -f "$temp"
    return 1
  fi
}

megabrain_tmux_tuning_apply() {
  local config repo install_path backup_path="${1:-}" server_applied=false
  config="$(megabrain_tmux_tuning_config_path)"
  repo="$(megabrain_tmux_tuning_repo_path)"
  install_path="$(megabrain_tmux_tuning_install_path)"
  [ -f "$repo" ] || { megabrain_error "tmux tuning file is missing: $repo"; return 1; }
  megabrain_tmux_tuning_validate_config "$config" || return 1
  if [ -f "$config" ]; then
    [ -n "$backup_path" ] || backup_path="$(megabrain_tmux_tuning_next_backup_path "$config")"
    while [ -e "$backup_path" ]; do
      backup_path="$(megabrain_tmux_tuning_next_backup_path "$config")"
    done
    cp -p "$config" "$backup_path" || {
      megabrain_error "could not back up $config to $backup_path"
      return 1
    }
  fi
  megabrain_tmux_tuning_install_file "$repo" || {
    megabrain_error "could not install tmux tuning file at $install_path"
    return 1
  }
  if ! megabrain_tmux_tuning_write_config "$config"; then
    megabrain_error "could not update $config"
    return 1
  fi
  if megabrain_tmux_tuning_server_running; then
    if tmux source-file "$install_path" >/dev/null 2>&1; then
      server_applied=true
    else
      megabrain_error "could not apply tmux tuning to the running server"
      return 1
    fi
  fi
  MEGABRAIN_TMUX_TUNE_BACKUP_PATH="$backup_path"
  MEGABRAIN_TMUX_TUNE_SERVER_APPLIED="$server_applied"
}

megabrain_tmux_tuning_revert() {
  local config
  config="$(megabrain_tmux_tuning_config_path)"
  [ -e "$config" ] || return 0
  megabrain_tmux_tuning_validate_config "$config" || return 1
  megabrain_tmux_tuning_block_present "$config" || return 0
  megabrain_tmux_tuning_remove_block "$config" || {
    megabrain_error "could not remove the legacy tuning block from $config"
    return 1
  }
  MEGABRAIN_TMUX_TUNE_REVERTED=true
}

megabrain_tmux_tuning_print_plan() {
  local config="$1" backup_path="$2"
  printf 'Recommended tmux tuning:\n'
  printf '  - enable RGB and host-terminal parity options\n'
  printf '  - raise history, enable focus, passthrough, clipboard, mouse, and titles\n'
  printf '  - make splits and new windows inherit the current pane path\n'
  printf '  - install the shared tuning file at %s\n' "$(megabrain_tmux_tuning_install_path)"
  if [ -n "$backup_path" ]; then
    printf '  - back up %s to %s\n' "$config" "$backup_path"
  else
    printf '  - no backup: %s does not exist\n' "$config"
  fi
}

megabrain_tmux_tune() {
  local yes=false dry_run=false revert=false json=false arg config backup_path answer input
  local block_present=false installed_current=false server_running=false server_rgb=false
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --yes) yes=true; shift ;;
      --dry-run) dry_run=true; shift ;;
      --revert) revert=true; shift ;;
      --json) json=true; shift ;;
      -h|--help)
        megabrain_usage_show tmux-tune
        return 0
        ;;
      *)
        megabrain_error "unknown tmux tune option: $arg"
        return "$MEGABRAIN_USAGE_ERROR"
        ;;
    esac
  done
  if [ "$dry_run" = true ] && [ "$revert" = true ]; then
    megabrain_error '--dry-run and --revert cannot be combined'
    return "$MEGABRAIN_USAGE_ERROR"
  fi
  config="$(megabrain_tmux_tuning_config_path)"
  megabrain_tmux_tuning_block_present "$config" && block_present=true
  megabrain_tmux_tuning_installed_current && installed_current=true
  if megabrain_tmux_tuning_server_running; then
    server_running=true
    megabrain_tmux_tuning_server_has_rgb && server_rgb=true
  fi
  if [ "$dry_run" = true ]; then
    if [ "$json" = true ]; then
      jq -n --arg config "$config" --arg installed "$(megabrain_tmux_tuning_install_path)" \
        --argjson block "$block_present" --argjson installedCurrent "$installed_current" \
        --argjson serverRunning "$server_running" --argjson serverRgb "$server_rgb" \
        '{ok: true, action: "dry-run", changed: false, wouldChange: (($block | not) or ($installedCurrent | not)), configPath: $config, installedPath: $installed, blockPresent: $block, installedCurrent: $installedCurrent, serverRunning: $serverRunning, serverRgb: $serverRgb}'
    else
      megabrain_tmux_tuning_print_plan "$config" "$(megabrain_tmux_tuning_next_backup_path "$config")"
      printf '  - dry-run: no files or tmux server options will change\n'
    fi
    return 0
  fi
  if [ "$revert" = true ]; then
    if ! megabrain_tmux_tuning_revert; then
      [ "$json" = true ] && jq -n --arg action revert '{ok: false, action: $action, error: "could not revert tmux tuning"}'
      return 1
    fi
    if [ "$json" = true ]; then
      jq -n --arg config "$config" --argjson backups "$(megabrain_tmux_tuning_backup_paths_json)" \
        --argjson changed "${MEGABRAIN_TMUX_TUNE_REVERTED:-false}" \
        '{ok: true, action: "revert", changed: $changed, configPath: $config, backupPaths: $backups}'
    else
      printf 'tmux tuning reverted from %s\n' "$config"
      printf 'backups remain available:\n'
      megabrain_tmux_tuning_backup_paths | sed 's/^/  /'
    fi
    return 0
  fi
  if [ "$yes" != true ]; then
    backup_path="$(megabrain_tmux_tuning_next_backup_path "$config")"
    if [ "$json" = true ]; then
      jq -n --arg action apply '{ok: true, action: $action, status: "confirmation-required", changed: false}'
      return 0
    fi
    if [ -t 0 ]; then
      input=/dev/stdin
    elif [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
      input=/dev/tty
    else
      printf 'tmux tuning skipped (non-interactive); run: megabrain tmux tune --yes\n'
      return 0
    fi
    megabrain_tmux_tuning_print_plan "$config" "$backup_path"
    printf 'Apply recommended tmux tuning? [y/N] '
    read -r answer <"$input" || answer=''
    case "$answer" in
      y|Y|yes|YES|Yes) ;;
      *) printf 'tmux tuning skipped; run: megabrain tmux tune --yes\n'; return 0 ;;
    esac
  fi
  if ! megabrain_tmux_tuning_apply "${backup_path:-}"; then
    [ "$json" = true ] && jq -n --arg action apply '{ok: false, action: $action, error: "could not apply tmux tuning"}'
    return 1
  fi
  if [ "$json" = true ]; then
    jq -n --arg config "$config" --arg installed "$(megabrain_tmux_tuning_install_path)" \
      --arg backup "${MEGABRAIN_TMUX_TUNE_BACKUP_PATH:-}" \
      --argjson serverApplied "${MEGABRAIN_TMUX_TUNE_SERVER_APPLIED:-false}" \
      '{ok: true, action: "apply", changed: true, configPath: $config, installedPath: $installed, backupPath: (if $backup == "" then null else $backup end), serverApplied: $serverApplied}'
  else
    printf 'tmux tuning applied\n'
    if [ -n "${MEGABRAIN_TMUX_TUNE_BACKUP_PATH:-}" ]; then
      printf 'backup: %s\n' "$MEGABRAIN_TMUX_TUNE_BACKUP_PATH"
    else
      printf 'backup: none (%s did not exist)\n' "$config"
    fi
    if [ "${MEGABRAIN_TMUX_TUNE_SERVER_APPLIED:-false}" = true ]; then
      printf 'running tmux server: updated\n'
    else
      printf 'running tmux server: none\n'
    fi
  fi
}

megabrain_tmux_wrapper_repo_path() {
  case "$(megabrain_tmux_wrapper_shell)" in
    bash) printf '%s/bash/megabrain-agent-tmux.bash\n' "$MEGABRAIN_ROOT" ;;
    *) printf '%s/zsh/megabrain-agent-tmux.zsh\n' "$MEGABRAIN_ROOT" ;;
  esac
}

megabrain_tmux_wrapper_install_path() {
  case "$(megabrain_tmux_wrapper_shell)" in
    bash) printf '%s/.megabrain/bash/megabrain-agent-tmux.bash\n' "$HOME" ;;
    *) printf '%s/.megabrain/zsh/megabrain-agent-tmux.zsh\n' "$HOME" ;;
  esac
}

megabrain_tmux_wrapper_config_path() {
  case "$(megabrain_tmux_wrapper_shell)" in
    bash) printf '%s/.bashrc\n' "$HOME" ;;
    *) printf '%s/.zshrc\n' "$HOME" ;;
  esac
}

megabrain_tmux_wrapper_validate_config() {
  local config="$1" starts ends
  [ -e "$config" ] || return 0
  [ -f "$config" ] || {
    megabrain_error "zsh config exists but is not a regular file: $config"
    return 1
  }
  starts="$(grep -Fxc "$MEGABRAIN_TMUX_WRAPPER_START" "$config" 2>/dev/null || true)"
  ends="$(grep -Fxc "$MEGABRAIN_TMUX_WRAPPER_END" "$config" 2>/dev/null || true)"
  if [ "$starts" -ne "$ends" ]; then
    megabrain_error "zsh config has an incomplete megabrain tmux wrapper block: $config"
    return 1
  fi
}

megabrain_tmux_wrapper_block_present() {
  local config="$1" starts ends source_lines
  [ -f "$config" ] || return 1
  starts="$(grep -Fxc "$MEGABRAIN_TMUX_WRAPPER_START" "$config" 2>/dev/null || true)"
  ends="$(grep -Fxc "$MEGABRAIN_TMUX_WRAPPER_END" "$config" 2>/dev/null || true)"
  source_lines="$(grep -Fxc "$MEGABRAIN_TMUX_WRAPPER_SOURCE" "$config" 2>/dev/null || true)"
  [ "$starts" -eq 1 ] && [ "$ends" -eq 1 ] && [ "$source_lines" -eq 1 ]
}

megabrain_tmux_wrapper_installed_current() {
  cmp -s "$(megabrain_tmux_wrapper_repo_path)" "$(megabrain_tmux_wrapper_install_path)"
}

megabrain_tmux_wrapper_next_backup_path() {
  local config="$1" stamp path suffix=1
  [ -f "$config" ] || return 0
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  path="${config}.megabrain-backup-${stamp}"
  while [ -e "$path" ]; do
    path="${config}.megabrain-backup-${stamp}-${suffix}"
    suffix=$((suffix + 1))
  done
  printf '%s\n' "$path"
}

megabrain_tmux_wrapper_backup_paths() {
  local path
  for path in "$HOME"/.zshrc.megabrain-backup-*; do
    [ -f "$path" ] || continue
    printf '%s\n' "$path"
  done
}

megabrain_tmux_wrapper_backup_paths_json() {
  megabrain_tmux_wrapper_backup_paths | jq -Rsc 'split("\n") | map(select(length > 0))'
}

megabrain_tmux_wrapper_install_file() {
  local repo="$1" install_path temp
  install_path="$(megabrain_tmux_wrapper_install_path)"
  mkdir -p "$(dirname "$install_path")" || return 1
  temp="$(mktemp "${install_path}.XXXXXX")" || return 1
  if ! cp "$repo" "$temp" || ! mv -f "$temp" "$install_path"; then
    rm -f "$temp"
    return 1
  fi
}

megabrain_tmux_wrapper_write_config() {
  local config="$1" temp
  temp="$(mktemp "${config}.XXXXXX")" || return 1
  if [ -f "$config" ]; then
    set -- "$config"
  else
    set -- /dev/null
  fi
  if ! awk -v start="$MEGABRAIN_TMUX_WRAPPER_START" \
    -v end="$MEGABRAIN_TMUX_WRAPPER_END" \
    -v source="$MEGABRAIN_TMUX_WRAPPER_SOURCE" '
    $0 == start {
      if (!replaced) {
        print start
        print source
        print end
        replaced = 1
      }
      in_block = 1
      next
    }
    in_block && $0 == end { in_block = 0; next }
    !in_block { print }
    END {
      if (!replaced) {
        print start
        print source
        print end
      }
    }
  ' "$1" >"$temp"; then
    rm -f "$temp"
    return 1
  fi
  if ! mv -f "$temp" "$config"; then
    rm -f "$temp"
    return 1
  fi
}

megabrain_tmux_wrapper_remove_block() {
  local config="$1" temp
  temp="$(mktemp "${config}.XXXXXX")" || return 1
  if ! awk -v start="$MEGABRAIN_TMUX_WRAPPER_START" -v end="$MEGABRAIN_TMUX_WRAPPER_END" '
    $0 == start { in_block = 1; next }
    in_block && $0 == end { in_block = 0; next }
    !in_block { print }
  ' "$config" >"$temp"; then
    rm -f "$temp"
    return 1
  fi
  if ! mv -f "$temp" "$config"; then
    rm -f "$temp"
    return 1
  fi
}

megabrain_tmux_wrapper_apply() {
  local config repo install_path backup_path="${1:-}"
  config="$(megabrain_tmux_wrapper_config_path)"
  repo="$(megabrain_tmux_wrapper_repo_path)"
  install_path="$(megabrain_tmux_wrapper_install_path)"
  [ -f "$repo" ] || { megabrain_error "tmux wrapper file is missing: $repo"; return 1; }
  megabrain_tmux_wrapper_validate_config "$config" || return 1
  if [ -f "$config" ]; then
    [ -n "$backup_path" ] || backup_path="$(megabrain_tmux_wrapper_next_backup_path "$config")"
    while [ -e "$backup_path" ]; do
      backup_path="$(megabrain_tmux_wrapper_next_backup_path "$config")"
    done
    cp -p "$config" "$backup_path" || {
      megabrain_error "could not back up $config to $backup_path"
      return 1
    }
  fi
  megabrain_tmux_wrapper_install_file "$repo" || {
    megabrain_error "could not install tmux wrapper file at $install_path"
    return 1
  }
  if ! megabrain_tmux_wrapper_write_config "$config"; then
    megabrain_error "could not update $config"
    return 1
  fi
  MEGABRAIN_TMUX_WRAPPER_BACKUP_PATH="$backup_path"
}

megabrain_tmux_wrapper_revert() {
  local config
  config="$(megabrain_tmux_wrapper_config_path)"
  [ -e "$config" ] || return 0
  megabrain_tmux_wrapper_validate_config "$config" || return 1
  megabrain_tmux_wrapper_block_present "$config" || return 0
  megabrain_tmux_wrapper_remove_block "$config" || {
    megabrain_error "could not remove the megabrain tmux wrapper block from $config"
    return 1
  }
  MEGABRAIN_TMUX_WRAPPER_REVERTED=true
}

megabrain_tmux_wrapper_print_plan() {
  local config="$1" backup_path="$2"
  printf 'Recommended tmux agent wrapper:\n'
  printf '  - install the wrapper file at %s\n' "$(megabrain_tmux_wrapper_install_path)"
  printf '  - add a source block to %s\n' "$config"
  printf 'Warning: this defines shell functions named claude, codex and agy that take over those commands in every new interactive zsh. MEGABRAIN_NO_TMUX=1 or "command claude" bypasses them.\n'
  if [ -n "$backup_path" ]; then
    printf '  - back up %s to %s\n' "$config" "$backup_path"
  else
    printf '  - no backup: %s does not exist\n' "$config"
  fi
}

megabrain_tmux_wrapper() {
  local yes=false dry_run=false revert=false json=false arg config backup_path answer input
  local block_present=false installed_current=false
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --yes) yes=true; shift ;;
      --dry-run) dry_run=true; shift ;;
      --revert) revert=true; shift ;;
      --json) json=true; shift ;;
      -h|--help)
        megabrain_usage_show tmux-wrapper
        return 0
        ;;
      *)
        megabrain_error "unknown tmux wrapper option: $arg"
        return "$MEGABRAIN_USAGE_ERROR"
        ;;
    esac
  done
  # WHY: the wrapper is a zsh function sourced from .zshrc. On any other login shell it
  # changes nothing the user will ever load, so reporting success would be a lie and
  # creating a .zshrc for them would be litter. Revert stays allowed, because a shell can
  # change after the wrapper was installed and the block still needs removing.
  if [ "$revert" != true ] && [ "$dry_run" != true ]; then
    case "$(megabrain_tmux_wrapper_shell)" in
      zsh|bash) ;;
      *)
        megabrain_error "the agent wrapper ships for zsh and bash and your login shell is ${SHELL:-unknown}; nothing was written"
        return 1
        ;;
    esac
  fi
  if [ "$dry_run" = true ] && [ "$revert" = true ]; then
    megabrain_error '--dry-run and --revert cannot be combined'
    return "$MEGABRAIN_USAGE_ERROR"
  fi
  config="$(megabrain_tmux_wrapper_config_path)"
  megabrain_tmux_wrapper_block_present "$config" && block_present=true
  megabrain_tmux_wrapper_installed_current && installed_current=true
  if [ "$dry_run" = true ]; then
    if [ "$json" = true ]; then
      jq -n --arg config "$config" --arg installed "$(megabrain_tmux_wrapper_install_path)" \
        --argjson block "$block_present" --argjson installedCurrent "$installed_current" \
        '{ok: true, action: "dry-run", changed: false, wouldChange: (($block | not) or ($installedCurrent | not)), configPath: $config, installedPath: $installed, blockPresent: $block, installedCurrent: $installedCurrent}'
    else
      megabrain_tmux_wrapper_print_plan "$config" "$(megabrain_tmux_wrapper_next_backup_path "$config")"
      printf '  - dry-run: no files will change\n'
    fi
    return 0
  fi
  if [ "$revert" = true ]; then
    if ! megabrain_tmux_wrapper_revert; then
      [ "$json" = true ] && jq -n '{ok: false, action: "revert", error: "could not revert tmux wrapper"}'
      return 1
    fi
    if [ "$json" = true ]; then
      jq -n --arg config "$config" --argjson backups "$(megabrain_tmux_wrapper_backup_paths_json)" \
        --argjson changed "${MEGABRAIN_TMUX_WRAPPER_REVERTED:-false}" \
        '{ok: true, action: "revert", changed: $changed, configPath: $config, backupPaths: $backups}'
    else
      printf 'tmux agent wrapper reverted from %s\n' "$config"
      printf 'backups remain available:\n'
      megabrain_tmux_wrapper_backup_paths | sed 's/^/  /'
    fi
    return 0
  fi
  if [ "$yes" != true ]; then
    backup_path="$(megabrain_tmux_wrapper_next_backup_path "$config")"
    if [ "$json" = true ]; then
      jq -n --arg config "$config" --arg installed "$(megabrain_tmux_wrapper_install_path)" \
        '{ok: true, action: "apply", status: "confirmation-required", changed: false, configPath: $config, installedPath: $installed}'
      return 0
    fi
    if [ -t 0 ]; then
      input=/dev/stdin
    elif [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
      input=/dev/tty
    else
      printf 'tmux agent wrapper skipped (non-interactive); run: megabrain tmux wrapper --yes\n'
      return 0
    fi
    megabrain_tmux_wrapper_print_plan "$config" "$backup_path"
    printf 'Apply tmux agent wrapper? [y/N] '
    read -r answer <"$input" || answer=''
    case "$answer" in
      y|Y|yes|YES|Yes) ;;
      *) printf 'tmux agent wrapper skipped; run: megabrain tmux wrapper --yes\n'; return 0 ;;
    esac
  fi
  if ! megabrain_tmux_wrapper_apply "${backup_path:-}"; then
    [ "$json" = true ] && jq -n '{ok: false, action: "apply", error: "could not apply tmux wrapper"}'
    return 1
  fi
  if [ "$json" = true ]; then
    jq -n --arg config "$config" --arg installed "$(megabrain_tmux_wrapper_install_path)" \
      --arg backup "${MEGABRAIN_TMUX_WRAPPER_BACKUP_PATH:-}" \
      '{ok: true, action: "apply", changed: true, configPath: $config, installedPath: $installed, backupPath: (if $backup == "" then null else $backup end)}'
  else
    printf 'tmux agent wrapper applied\n'
    if [ -n "${MEGABRAIN_TMUX_WRAPPER_BACKUP_PATH:-}" ]; then
      printf 'backup: %s\n' "$MEGABRAIN_TMUX_WRAPPER_BACKUP_PATH"
    else
      printf 'backup: none (%s did not exist)\n' "$config"
    fi
  fi
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

module_tmux_runtime_doctor() {
  local version enabled detail tuning_block=false tuning_file=false wrapper_block=false wrapper_file=false server_running=false server_rgb=false registry_drift=""
  if ! megabrain_tmux_available; then
    megabrain_set_status missing "tmux is not on PATH"
    return 1
  fi
  version="$(megabrain_tmux_version)"
  if megabrain_runtime_enabled; then
    enabled="enabled"
  else
    enabled="disabled"
  fi
  megabrain_tmux_tuning_block_present "$(megabrain_tmux_tuning_config_path)" && tuning_block=true
  megabrain_tmux_tuning_installed_current && tuning_file=true
  megabrain_tmux_wrapper_block_present "$(megabrain_tmux_wrapper_config_path)" && wrapper_block=true
  megabrain_tmux_wrapper_installed_current && wrapper_file=true
  registry_drift="$(megabrain_tmux_session_registry_drift)"
  if megabrain_tmux_tuning_server_running; then
    server_running=true
    megabrain_tmux_tuning_server_has_rgb && server_rgb=true
  fi
  detail="$version; runtime $enabled; tuning block $tuning_block; tuning file current $tuning_file; wrapper block in $(basename "$(megabrain_tmux_wrapper_config_path)") $wrapper_block; wrapper file current $wrapper_file"
  if [ "$server_running" = true ]; then
    detail="$detail; running server RGB $server_rgb"
  else
    detail="$detail; running server none"
  fi
  if [ -n "$registry_drift" ]; then
    detail="$detail; session registry drift: $(printf '%s' "$registry_drift" | paste -sd ', ' -)"
  else
    detail="$detail; session registry current"
  fi
  if megabrain_tmux_config_applied; then
    detail="$detail; megabrain session config applied"
  else
    detail="$detail; megabrain session config will apply when a session launches"
  fi
  if [ "$enabled" = enabled ] &&
    [ "$tuning_block" = true ] && [ "$tuning_file" = true ] &&
    [ "$wrapper_block" = true ] && [ "$wrapper_file" = true ] && [ -z "$registry_drift" ]; then
    megabrain_set_status ok "$detail"
    return 0
  fi
  if [ "$enabled" = enabled ]; then
    megabrain_set_status misconfigured "$detail; tmux runtime files are not current; run megabrain install tmux-runtime"
  else
    megabrain_set_status misconfigured "$detail; install tmux-runtime to enable it"
  fi
  return 1
}

module_tmux_runtime_offer_tuning() {
  local assume_yes="${1:-false}"
  if [ "$assume_yes" = true ]; then
    megabrain_tmux_tune --yes
    return $?
  fi
  if [ -t 0 ] || { [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; }; then
    megabrain_tmux_tune
  else
    printf 'tmux tuning skipped (non-interactive); run: megabrain tmux tune --yes\n'
  fi
}

module_tmux_runtime_offer_wrapper() {
  local assume_yes="${1:-false}"
  if [ "$assume_yes" = true ]; then
    megabrain_tmux_wrapper --yes
    return $?
  fi
  if [ -t 0 ] || { [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; }; then
    megabrain_tmux_wrapper
  else
    printf 'tmux agent wrapper skipped (non-interactive); run: megabrain tmux wrapper --yes\n'
  fi
}

module_tmux_runtime_install() {
  if megabrain_tmux_available; then
    module_tmux_runtime_offer_tuning "${1:-false}" || return 1
    module_tmux_runtime_offer_wrapper "${1:-false}" || return 1
    megabrain_state_set tmux-runtime true "tmux runtime enabled" || return 1
    module_tmux_runtime_doctor
    return $?
  fi
  case "$(uname -s 2>/dev/null || printf unknown)" in
    Darwin)
      if megabrain_require_command brew; then
        brew install tmux || return 1
      else
        megabrain_error "tmux is missing. Install it with: brew install tmux"
        megabrain_set_status missing "tmux is not on PATH"
        return 1
      fi
      ;;
    Linux)
      megabrain_error "tmux is missing. Install it with your package manager, for example: sudo apt-get install tmux"
      megabrain_set_status missing "tmux is not on PATH"
      return 1
      ;;
    *)
      megabrain_error "tmux is missing. Install tmux with your operating system package manager"
      megabrain_set_status missing "tmux is not on PATH"
      return 1
      ;;
  esac
  module_tmux_runtime_offer_tuning "${1:-false}" || return 1
  module_tmux_runtime_offer_wrapper "${1:-false}" || return 1
  megabrain_state_set tmux-runtime true "tmux runtime enabled" || return 1
  module_tmux_runtime_doctor
}
