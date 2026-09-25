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
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
  megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" context "$@"
}

command_orchestrate() {
  local subcommand="${1:-}"
  shift || true
  case "$subcommand" in
    spawn)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      megabrain_require_worktree_binary "$typescript_binary" || return 1
      "$typescript_binary" orchestrate spawn "$@"
      ;;
    list)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      [ -x "$typescript_binary" ] || {
        megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
        return 1
      }
      # WHY: migrated orchestrate verbs have no shell fallback; freshness remains visible at the boundary.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" orchestrate list "$@"
      ;;
    prune)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      [ -x "$typescript_binary" ] || {
        megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
        return 1
      }
      # WHY: migrated orchestrate verbs have no shell fallback; freshness remains visible at the boundary.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" orchestrate prune "$@"
      ;;
    reconcile)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      [ -x "$typescript_binary" ] || {
        megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
        return 1
      }
      # WHY: migrated orchestrate verbs have no shell fallback; freshness remains visible at the boundary.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" orchestrate reconcile "$@"
      ;;
    liveness)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      [ -x "$typescript_binary" ] || {
        megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
        return 1
      }
      # WHY: migrated orchestrate verbs have no shell fallback; freshness remains visible at the boundary.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" orchestrate liveness "$@"
      ;;
    watch) megabrain_dispatch_watch "$@" ;;
    read)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      [ -x "$typescript_binary" ] || {
        megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
        return 1
      }
      # WHY: migrated orchestrate verbs have no shell fallback; freshness remains visible at the boundary.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" orchestrate read "$@"
      ;;
    ack|acknowledge) megabrain_dispatch_ack "$@" ;;
    reply)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      [ -x "$typescript_binary" ] || {
        megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
        return 1
      }
      # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" orchestrate reply "$@"
      ;;
    stop)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      [ -x "$typescript_binary" ] || {
        megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
        return 1
      }
      # WHY: migrated orchestrate verbs have no shell fallback; freshness remains visible at the boundary.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" orchestrate stop "$@"
      ;;
    change)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      [ -x "$typescript_binary" ] || {
        megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
        return 1
      }
      # WHY: migrated orchestrate verbs have no shell fallback; freshness remains visible at the boundary.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" orchestrate change "$@"
      ;;
    close)
      local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
      [ -x "$typescript_binary" ] || {
        megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
        return 1
      }
      # WHY: migrated orchestrate verbs have no shell fallback; freshness remains visible at the boundary.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" orchestrate close "$@"
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
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  # WHY: retained for sourced shell contracts; the dispatcher routes directly above.
  megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" orchestrate list "$@"
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
