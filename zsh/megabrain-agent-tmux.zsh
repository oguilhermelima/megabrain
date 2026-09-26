_megabrain_tmux_wrap() {
  local agent=$1; shift
  # Orca types the prompt after launch, so tmux startup would race it.
  if [[ -n $TMUX || -n $MEGABRAIN_NO_TMUX || -n $ORCA_AGENT_LAUNCH_TOKEN || ! -t 0 ]]; then
    command $agent "$@"
    return
  fi
  local a
  for a in "$@"; do
    case $a in
      -p|--print|--output-format|--input-format|exec|--version|-v|--help|-h)
        command $agent "$@"; return ;;
    esac
  done
  local bin=${commands[$agent]}
  [[ -n $bin ]] || { command $agent "$@"; return }
  local cmd
  local session="megabrain-${agent}-$$"
  local pane cwd state_dir sessions_dir record_path temp host name version major minor
  local -a identity_names caller_names session_env command_parts unset_names caller_values quoted_parts
  identity_names=(ORCA_TERMINAL_HANDLE ORCA_WORKSPACE_ID ORCA_WORKTREE_ID ORCA_TAB_ID ORCA_PANE_KEY
    SUPERSET_TERMINAL_ID SUPERSET_WORKSPACE_ID MEGABRAIN_STATE_DIR)
  while IFS= read -r name; do
    case " ${identity_names[*]} " in *" $name "*) ;; *) identity_names+=("$name") ;; esac
  done < <({ env; tmux show-environment -g 2>/dev/null || true; } | sed -nE 's/^(ORCA_AGENT_HOOK_[A-Za-z0-9_]+)=.*/\1/p')
  while IFS= read -r name; do caller_names+=("$name"); done < <(env | sed 's/=.*//')

  version="$(tmux -V 2>/dev/null | sed -E 's/^tmux ([0-9]+)\.([0-9]+).*/\1 \2/')"
  major=0 minor=0
  if [[ $version =~ ^[0-9]+[[:space:]]+[0-9]+$ ]]; then read -r major minor <<<"$version"; fi
  session_env=() unset_names=() caller_values=()
  for name in "${identity_names[@]}"; do
    case " ${caller_names[*]} " in
      *" $name "*)
        if (( major >= 3 )); then
          session_env+=(-e "$name=${(P)name}")
        else
          caller_values+=("$name=${(P)name}")
        fi
        ;;
      *) unset_names+=("$name") ;;
    esac
  done
  command_parts=(env)
  for name in "${unset_names[@]}"; do command_parts+=(-u "$name"); done
  command_parts+=("${caller_values[@]}" "$bin" "$@")
  quoted_parts=("${(@q)command_parts}")
  cmd="${(j: :)quoted_parts}"
  # -A keeps the existing session and its original identity when this name is reattached.
  if ! tmux new-session -d -A "${session_env[@]}" -s "$session" -c "$PWD" "$cmd" \; set -g mouse on \; set -g status off; then
    command $agent "$@"
    return
  fi
  pane="$(tmux list-panes -t "$session" -F '#{pane_id}' 2>/dev/null | head -n 1)"
  cwd="$(pwd -P 2>/dev/null || true)"
  if [[ -n ${MEGABRAIN_STATE_DIR+x} ]]; then
    state_dir="$MEGABRAIN_STATE_DIR"
  else
    state_dir="$HOME/.megabrain"
  fi
  sessions_dir="$state_dir/sessions"
  record_path="$sessions_dir/$session.json"
  host="$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)"
  # Registration is best effort so state permissions never block the agent launch.
  if [[ -n $pane && -n $cwd && -n $host ]] && mkdir -p "$sessions_dir" 2>/dev/null; then
    temp="$(mktemp "$sessions_dir/.session.XXXXXX" 2>/dev/null || true)"
    if [[ -n $temp ]] && jq -n \
      --arg tmuxSession "$session" --arg agent "$agent" --arg workingDirectory "$cwd" \
      --arg tmuxPane "$pane" --arg host "$host" --arg createdAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
      '{tmuxSession: $tmuxSession, agent: $agent, workingDirectory: $workingDirectory, tmuxPane: $tmuxPane, role: "main", host: $host, createdAt: $createdAt}' \
      >"$temp" 2>/dev/null; then
      mv -f "$temp" "$record_path" 2>/dev/null || rm -f "$temp"
    elif [[ -n $temp ]]; then
      rm -f "$temp"
    fi
  fi
  tmux attach-session -t "$session"
}
claude() {
  if typeset -f _megabrain_tmux_wrap >/dev/null 2>&1; then
    _megabrain_tmux_wrap claude "$@"
  else
    command claude "$@"
  fi
}
codex() {
  if typeset -f _megabrain_tmux_wrap >/dev/null 2>&1; then
    _megabrain_tmux_wrap codex "$@"
  else
    command codex "$@"
  fi
}
agy() {
  if typeset -f _megabrain_tmux_wrap >/dev/null 2>&1; then
    _megabrain_tmux_wrap agy "$@"
  else
    command agy "$@"
  fi
}
