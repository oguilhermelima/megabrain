#!/usr/bin/env bash

megabrain_context_detect() {
  local current_json
  megabrain_session_id >/dev/null
  if [ -n "${MEGABRAIN_SESSION_ID:-}" ]; then
    printf '%s\n' "$MEGABRAIN_SESSION_HOST"
    return 0
  fi
  if megabrain_require_command orca; then
    current_json="$(orca worktree current --json 2>/dev/null || true)"
    if printf '%s' "$current_json" | jq -e '.ok == true and (.result.worktree.path // .result.worktree.git.path) != null' >/dev/null 2>&1; then
      printf 'orca\n'
      return 0
    fi
  fi
  printf 'unknown\n'
}

command_context() {
  local format="plain" arg host
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  if [ -x "$typescript_binary" ] && [ "${MEGABRAIN_CONTEXT_IMPLEMENTATION:-}" != shell ]; then
    "$typescript_binary" context "$@"
    return $?
  fi
  for arg in "$@"; do
    case "$arg" in
      --json) format="json" ;;
      -h|--help) megabrain_usage_show context; return 0 ;;
      *) megabrain_error "unknown context option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  host="$(megabrain_context_detect)"
  megabrain_session_id >/dev/null
  megabrain_resolve_parent_context
  if [ "$format" = json ]; then
    jq -n --arg host "$host" --arg workspace "${SUPERSET_WORKSPACE_ID:-}" \
      --arg terminal "${MEGABRAIN_SESSION_ID:-}" --arg agent "$MEGABRAIN_PARENT_AGENT" \
      '{host: $host, workspaceId: (if $workspace|length > 0 then $workspace else null end), terminalId: (if $terminal|length > 0 then $terminal else null end), agentId: (if $agent|length > 0 then $agent else null end)}'
  else
    printf '%s\n' "$host"
  fi
}

command_orchestrate() {
  local subcommand="${1:-}"
  shift || true
  case "$subcommand" in
    spawn) command_worktree create --orchestrate "$@" ;;
    list) command_orchestrate_list "$@" ;;
    prune) megabrain_dispatch_prune "$@" ;;
    reconcile) megabrain_dispatch_reconcile "$@" ;;
    liveness) megabrain_dispatch_liveness "$@" ;;
    watch) megabrain_dispatch_watch "$@" ;;
    read) megabrain_dispatch_read "$@" ;;
    ack|acknowledge) megabrain_dispatch_ack "$@" ;;
    reply)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      if [ -x "$typescript_binary" ] && [ "${MEGABRAIN_ORCHESTRATE_REPLY_IMPLEMENTATION:-}" != shell ]; then
        "$typescript_binary" orchestrate reply "$@"
        return $?
      fi
      megabrain_dispatch_reply "$@"
      ;;
    stop) megabrain_dispatch_stop "$@" ;;
    change)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      if [ -x "$typescript_binary" ] && [ "${MEGABRAIN_ORCHESTRATE_CHANGE_IMPLEMENTATION:-}" != shell ]; then
        "$typescript_binary" orchestrate change "$@"
        return $?
      fi
      megabrain_dispatch_change "$@"
      ;;
    close)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      if [ -x "$typescript_binary" ] && [ "${MEGABRAIN_ORCHESTRATE_CLOSE_IMPLEMENTATION:-}" != shell ]; then
        "$typescript_binary" orchestrate close "$@"
        return $?
      fi
      megabrain_dispatch_close "$@"
      ;;
    -h|--help|"")
      megabrain_usage_show orchestrate-spawn orchestrate-list orchestrate-reconcile \
        orchestrate-prune orchestrate-watch orchestrate-read orchestrate-ack orchestrate-reply orchestrate-stop orchestrate-change orchestrate-close
      ;;
    *) megabrain_error "unknown orchestrate command: $subcommand"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}

MEGABRAIN_DISPATCH_LIST_CACHE_ACTIVE=false
MEGABRAIN_DISPATCH_LIST_ORCA_PREPARED=false
MEGABRAIN_DISPATCH_LIST_ORCA_AVAILABLE=false
MEGABRAIN_DISPATCH_LIST_ORCA_VALID=false
MEGABRAIN_DISPATCH_LIST_ORCA_TERMINALS='[]'
MEGABRAIN_DISPATCH_LIST_ORCA_IDS=''
MEGABRAIN_DISPATCH_LIST_SUPERSET_PREPARED=false
MEGABRAIN_DISPATCH_LIST_SUPERSET_AVAILABLE=false
MEGABRAIN_DISPATCH_LIST_SUPERSET_VALID=false
MEGABRAIN_DISPATCH_LIST_SUPERSET_TERMINALS='[]'
MEGABRAIN_DISPATCH_LIST_SUPERSET_IDS=''

megabrain_dispatch_terminal_ids() {
  local host="$1" records="$2"
  case "$host" in
    orca)
      printf '%s' "$records" | jq -r '
        def terminals: if type == "array" then . else (.result.terminals // []) end;
        terminals[]? | .handle // empty
      ' 2>/dev/null
      ;;
    superset)
      printf '%s' "$records" | jq -r '
        def terminals: if type == "array" then . else (.sessions // .result.sessions // .result.terminals // .terminals // []) end;
        terminals[]? | .terminalId // empty
      ' 2>/dev/null
      ;;
    *) return 1 ;;
  esac
}

megabrain_dispatch_list_cache_prepare_host() {
  local host="$1" records
  case "$host" in
    orca)
      [ "$MEGABRAIN_DISPATCH_LIST_ORCA_PREPARED" = true ] && return 0
      MEGABRAIN_DISPATCH_LIST_ORCA_PREPARED=true
      if ! megabrain_require_command orca; then
        return 0
      fi
      MEGABRAIN_DISPATCH_LIST_ORCA_AVAILABLE=true
      records="$(orca terminal list --json 2>/dev/null || true)"
      MEGABRAIN_DISPATCH_LIST_ORCA_TERMINALS="$records"
      if printf '%s' "$records" | jq -e . >/dev/null 2>&1; then
        MEGABRAIN_DISPATCH_LIST_ORCA_VALID=true
        MEGABRAIN_DISPATCH_LIST_ORCA_IDS="$(megabrain_dispatch_terminal_ids orca "$records" 2>/dev/null || true)"
      fi
      ;;
    superset)
      [ "$MEGABRAIN_DISPATCH_LIST_SUPERSET_PREPARED" = true ] && return 0
      MEGABRAIN_DISPATCH_LIST_SUPERSET_PREPARED=true
      if ! megabrain_superset_available; then
        return 0
      fi
      MEGABRAIN_DISPATCH_LIST_SUPERSET_AVAILABLE=true
      records="$(megabrain_superset_terminals_json 2>/dev/null || true)"
      MEGABRAIN_DISPATCH_LIST_SUPERSET_TERMINALS="$records"
      if printf '%s' "$records" | jq -e . >/dev/null 2>&1; then
        MEGABRAIN_DISPATCH_LIST_SUPERSET_VALID=true
        MEGABRAIN_DISPATCH_LIST_SUPERSET_IDS="$(megabrain_dispatch_terminal_ids superset "$records" 2>/dev/null || true)"
      fi
      ;;
  esac
}

megabrain_dispatch_host_terminal_records() {
  local meta="$1" host workspace_id
  host="$(printf '%s' "$meta" | jq -r '.childHost // empty')"
  workspace_id="$(printf '%s' "$meta" | jq -r '.workspaceId // empty')"
  if [ "$MEGABRAIN_DISPATCH_LIST_CACHE_ACTIVE" = true ]; then
    megabrain_dispatch_list_cache_prepare_host "$host"
    case "$host" in
      orca)
        [ "$MEGABRAIN_DISPATCH_LIST_ORCA_AVAILABLE" = true ] || return 1
        printf '%s' "$MEGABRAIN_DISPATCH_LIST_ORCA_TERMINALS"
        return 0
        ;;
      superset)
        [ "$MEGABRAIN_DISPATCH_LIST_SUPERSET_AVAILABLE" = true ] || return 1
        printf '%s' "$MEGABRAIN_DISPATCH_LIST_SUPERSET_TERMINALS"
        return 0
        ;;
      *) return 1 ;;
    esac
  fi
  case "$host" in
    orca)
      megabrain_require_command orca || return 1
      orca terminal list --json 2>/dev/null
      ;;
    superset)
      [ -n "$workspace_id" ] || return 1
      megabrain_superset_available || return 1
      megabrain_superset terminals list --workspace "$workspace_id" --json 2>/dev/null
      ;;
    *) return 1 ;;
  esac
}

megabrain_dispatch_terminal_id_exists() {
  local host="$1" records="$2" terminal_id="$3"
  [ -n "$terminal_id" ] || return 1
  case "$host" in
    orca)
      printf '%s' "$records" | jq -e --arg id "$terminal_id" '
        def terminals: if type == "array" then . else (.result.terminals // []) end;
        any(terminals[]?; (.handle // "") == $id)
      ' >/dev/null 2>&1
      ;;
    superset)
      printf '%s' "$records" | jq -e --arg id "$terminal_id" '
        def terminals: if type == "array" then . else (.sessions // .result.sessions // .result.terminals // .terminals // []) end;
        any(terminals[]?; (.terminalId // "") == $id)
      ' >/dev/null 2>&1
      ;;
    *) return 1 ;;
  esac
}

megabrain_dispatch_process_has_identity() {
  local pid="$1" dispatch_id="$2" marker tty
  marker="MEGABRAIN_DISPATCH_ID=$dispatch_id"
  tty="$(ps -p "$pid" -o tty= 2>/dev/null | tr -d '[:space:]')"
  [ -n "$tty" ] || return 1
  if ps eww -t "$tty" -o pid=,ppid=,command= 2>/dev/null | awk -v root="$pid" -v marker="$marker" '
    {
      parent[$1] = $2
      command[$1] = $0
    }
    END {
      seen[root] = 1
      count = 1
      node[1] = root
      for (i = 1; i <= count; i++) {
        for (candidate in parent) {
          if (parent[candidate] == node[i] && !seen[candidate]++) {
            count++
            node[count] = candidate
          }
        }
      }
      for (i = 1; i <= count; i++) {
        fields = split(command[node[i]], words)
        for (field = 1; field <= fields; field++) {
          if (words[field] == marker) found = 1
        }
      }
      exit(found ? 0 : 1)
    }
  '; then
    return 0
  fi
  return 1
}

megabrain_dispatch_parent_status() {
  local meta="$1" host parent workspace_json workspace_id terminals queried=false
  MEGABRAIN_PARENT_STATUS=unknown
  host="$(printf '%s' "$meta" | jq -r '.parentHost // empty')"
  parent="$(printf '%s' "$meta" | jq -r '.parentSessionId // empty')"
  if [ "$MEGABRAIN_DISPATCH_LIST_CACHE_ACTIVE" = true ]; then
    case "$host" in
      orca)
        megabrain_dispatch_list_cache_prepare_host orca
        [ "$MEGABRAIN_DISPATCH_LIST_ORCA_AVAILABLE" = true ] || return 0
        [ "$MEGABRAIN_DISPATCH_LIST_ORCA_VALID" = true ] || return 0
        if [ -n "$parent" ] && printf '%s\n' "$MEGABRAIN_DISPATCH_LIST_ORCA_IDS" | grep -Fx "$parent" >/dev/null 2>&1; then
          MEGABRAIN_PARENT_STATUS=alive
        else
          MEGABRAIN_PARENT_STATUS=gone
        fi
        return 0
        ;;
      superset)
        megabrain_dispatch_list_cache_prepare_host superset
        [ "$MEGABRAIN_DISPATCH_LIST_SUPERSET_AVAILABLE" = true ] || return 0
        [ "$MEGABRAIN_DISPATCH_LIST_SUPERSET_VALID" = true ] || return 0
        if [ -n "$parent" ] && printf '%s\n' "$MEGABRAIN_DISPATCH_LIST_SUPERSET_IDS" | grep -Fx "$parent" >/dev/null 2>&1; then
          MEGABRAIN_PARENT_STATUS=alive
        else
          MEGABRAIN_PARENT_STATUS=gone
        fi
        return 0
        ;;
      *) return 0 ;;
    esac
  fi
  case "$host" in
    orca)
      megabrain_require_command orca || return 0
      terminals="$(orca terminal list --json 2>/dev/null || true)"
      printf '%s' "$terminals" | jq -e . >/dev/null 2>&1 || return 0
      if megabrain_dispatch_terminal_id_exists orca "$terminals" "$parent"; then
        MEGABRAIN_PARENT_STATUS=alive
      else
        MEGABRAIN_PARENT_STATUS=gone
      fi
      ;;
    superset)
      megabrain_superset_available || return 0
      workspace_json="$(megabrain_superset workspaces list --local --json 2>/dev/null || true)"
      printf '%s' "$workspace_json" | jq -e . >/dev/null 2>&1 || return 0
      while IFS= read -r workspace_id; do
        [ -n "$workspace_id" ] || continue
        queried=true
        terminals="$(megabrain_superset terminals list --workspace "$workspace_id" --json 2>/dev/null || true)"
        printf '%s' "$terminals" | jq -e . >/dev/null 2>&1 || { MEGABRAIN_PARENT_STATUS=unknown; return 0; }
        if megabrain_dispatch_terminal_id_exists superset "$terminals" "$parent"; then
          MEGABRAIN_PARENT_STATUS=alive
          return 0
        fi
      done < <(printf '%s' "$workspace_json" | jq -r '(if type == "array" then . else (.result.workspaces? // .workspaces? // .result? // []) end)[]? | (.id // .workspaceId // .workspace.id // empty)' 2>/dev/null)
      [ "$queried" = true ] && MEGABRAIN_PARENT_STATUS=gone
      ;;
    *) ;;
  esac
}

megabrain_dispatch_terminal_status() {
  local meta="$1" dispatch_id terminal_id runtime host records tmux_session tmux_pane pane_pid
  MEGABRAIN_TERMINAL_STATUS=unknown
  dispatch_id="$(printf '%s' "$meta" | jq -r '.dispatchId')"
  terminal_id="$(printf '%s' "$meta" | jq -r '.terminalId // empty')"
  host="$(printf '%s' "$meta" | jq -r '.childHost // empty')"
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  if [ "$runtime" = tmux ]; then
    tmux_session="$(printf '%s' "$meta" | jq -r '.tmuxSession // empty')"
    tmux_pane="$(printf '%s' "$meta" | jq -r '.tmuxPane // empty')"
    if ! megabrain_require_command tmux || ! megabrain_tmux_session_exists "$tmux_session"; then
      MEGABRAIN_TERMINAL_STATUS=missing
      return 0
    fi
    if ! tmux list-panes -t "$tmux_session" -F '#{pane_id}' 2>/dev/null | grep -Fx "$tmux_pane" >/dev/null 2>&1; then
      MEGABRAIN_TERMINAL_STATUS=missing
      return 0
    fi
    pane_pid="$(tmux display-message -p -t "$tmux_pane" '#{pane_pid}' 2>/dev/null || true)"
    if [ -n "$pane_pid" ] && megabrain_dispatch_process_has_identity "$pane_pid" "$dispatch_id"; then
      MEGABRAIN_TERMINAL_STATUS=proven
    fi
    return 0
  fi
  records="$(megabrain_dispatch_host_terminal_records "$meta" 2>/dev/null || true)"
  [ -n "$records" ] || return 0
  printf '%s' "$records" | jq -e . >/dev/null 2>&1 || return 0
  if megabrain_dispatch_terminal_id_exists "$host" "$records" "$terminal_id"; then
    MEGABRAIN_TERMINAL_STATUS=proven
  elif [ -n "$terminal_id" ]; then
    case "$host" in
      orca)
        jq -e 'def terminals: if type == "array" then . else (.result.terminals // []) end; (terminals | length) == 0' <<<"$records" >/dev/null 2>&1 &&
          MEGABRAIN_TERMINAL_STATUS=missing
        ;;
      superset)
        jq -e 'def terminals: if type == "array" then . else (.sessions // .result.sessions // .result.terminals // .terminals // []) end; (terminals | length) == 0' <<<"$records" >/dev/null 2>&1 &&
          MEGABRAIN_TERMINAL_STATUS=missing
        ;;
    esac
  fi
  return 0
}

command_orchestrate_list() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  if [ -x "$typescript_binary" ] && [ "${MEGABRAIN_ORCHESTRATE_LIST_IMPLEMENTATION:-}" != shell ]; then
    "$typescript_binary" orchestrate list "$@"
    return $?
  fi
  local json=false all=false orphans=false uncertain=false arg caller_id caller_host meta_path
  local entries
  local -a meta_paths
  for arg in "$@"; do
    case "$arg" in
      --json) json=true ;;
      --all) all=true ;;
      --orphans) orphans=true ;;
      --uncertain) uncertain=true ;;
      -h|--help) megabrain_usage_show orchestrate-list; return 0 ;;
      *) megabrain_error "unknown orchestrate list option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  megabrain_session_id >/dev/null
  caller_id="$MEGABRAIN_SESSION_ID"
  caller_host="$MEGABRAIN_SESSION_HOST"
  meta_paths=()
  for meta_path in "$MEGABRAIN_DISPATCH_DIR"/*/meta.json; do
    [ -f "$meta_path" ] || continue
    meta_paths[${#meta_paths[@]}]="$meta_path"
  done
  for meta_path in "$MEGABRAIN_DISPATCH_DIR"/archive/*/*/meta.json; do
    [ -f "$meta_path" ] || continue
    meta_paths[${#meta_paths[@]}]="$meta_path"
  done
  if [ "${#meta_paths[@]}" -eq 0 ]; then
    if [ "$json" = true ]; then
      printf '[]\n'
      return 0
    fi
    printf '%-38s %-20s %-18s %-12s %-10s %s\n' DISPATCH STATE PROCESS TERMINAL OWNERSHIP WORKTREE
    return 0
  fi

  # WHY: Listing is an inventory operation; explicit reconcile owns live terminal queries.
  entries="$(jq -s \
    --arg callerId "$caller_id" --arg callerHost "$caller_host" \
    --argjson all "$all" --argjson orphans "$orphans" --argjson uncertain "$uncertain" '
    map(. as $item
      | ($item.parentHost // "") as $parentHost
      | (($callerId != "") and ($item.parentSessionId == $callerId) and ($parentHost == $callerHost)) as $owned
      | (($item.state // "") == "orphaned") as $orphan
      | (($item.processState // "") == "start-unproven" or ($item.processState // "") == "stop-unproven" or ($item.processState // "") == "abandoned" or ($item.processState // "") == "exited") as $uncertainItem
      | $item + {ownedByCaller: $owned, orphan: $orphan, uncertain: $uncertainItem, reconcileResult: ($item.reconcileOutcome // "unchanged")})
    | map(select(($all or $orphans or $uncertain or .ownedByCaller) and (($orphans | not) or .orphan) and (($uncertain | not) or .uncertain)))
  ' "${meta_paths[@]}" 2>/dev/null)" || {
    # WHY: one unreadable meta aborts the whole batch, and the fast path must stay a
    # single jq. So the per-file walk runs only once something is already wrong, drops
    # exactly the files that cannot be parsed, and says which on stderr, where it cannot
    # corrupt the --json a caller is about to parse.
    local -a readable=()
    for meta_path in "${meta_paths[@]}"; do
      if jq empty "$meta_path" >/dev/null 2>&1; then
        readable[${#readable[@]}]="$meta_path"
      else
        megabrain_notice "skipping unreadable dispatch metadata: $meta_path"
      fi
    done
    if [ "${#readable[@]}" -eq 0 ]; then
      [ "$json" = true ] && printf '[]\n'
      return 0
    fi
    entries="$(jq -s \
      --arg callerId "$caller_id" --arg callerHost "$caller_host" \
        --argjson all "$all" --argjson orphans "$orphans" --argjson uncertain "$uncertain" '
      map(. as $item
        | ($item.parentHost // "") as $parentHost
        | (($callerId != "") and ($item.parentSessionId == $callerId) and ($parentHost == $callerHost)) as $owned
        | (($item.state // "") == "orphaned") as $orphan
        | (($item.processState // "") == "start-unproven" or ($item.processState // "") == "stop-unproven" or ($item.processState // "") == "abandoned" or ($item.processState // "") == "exited") as $uncertainItem
        | $item + {ownedByCaller: $owned, orphan: $orphan, uncertain: $uncertainItem, reconcileResult: ($item.reconcileOutcome // "unchanged")})
      | map(select(($all or $orphans or $uncertain or .ownedByCaller) and (($orphans | not) or .orphan) and (($uncertain | not) or .uncertain)))
    ' "${readable[@]}")" || return 1
  }
  if [ "$json" = true ]; then
    printf '%s\n' "$entries"
    return 0
  fi
  printf '%-38s %-20s %-18s %-12s %-10s %s\n' DISPATCH STATE PROCESS TERMINAL OWNERSHIP WORKTREE
  printf '%s\n' "$entries" | jq -r '.[] | [.dispatchId, .state, (.processState // "unknown"), (.terminalState // "unknown"), (if .ownedByCaller then "owned" else "not-owned" end), .worktreePath] | @tsv' | while IFS=$'\t' read -r dispatch state process terminal ownership worktree; do
    printf '%-38s %-20s %-18s %-12s %-10s %s\n' "$dispatch" "$state" "$process" "$terminal" "$ownership" "$worktree"
  done
}

megabrain_superset_terminals_json() {
  local workspaces workspace_id terminal_json
  workspaces="$(megabrain_superset workspaces list --local --json 2>/dev/null || printf '[]')"
  printf '%s\n' "$workspaces" | jq -r '(if type == "array" then . else (.result.workspaces? // .workspaces? // .result? // []) end)[]? | (.id // .workspaceId // .workspace.id // empty)' 2>/dev/null | while IFS= read -r workspace_id; do
    [ -n "$workspace_id" ] || continue
    terminal_json="$(megabrain_superset terminals list --workspace "$workspace_id" --json 2>/dev/null || printf '[]')"
    printf '%s\n' "$terminal_json" | jq -c '(.result.terminals // .terminals // .sessions // .result.sessions // [])[]?' 2>/dev/null
  done | jq -s '{result: {terminals: .}}'
}
