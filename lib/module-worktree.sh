#!/usr/bin/env bash

MEGABRAIN_TERMINAL_KILLED_TREE='[]'

megabrain_worktree_root() {
  local raw="" read_only=false host=""
  if [ "${1:-}" = --read-only ]; then
    read_only=true
  fi
  host="$(megabrain_context_detect)"

  # Superset remains authoritative when it is the host in use. Do not inspect
  # an installed but inactive host: its setting may describe another machine's
  # workspace layout.
  if [ "$host" = superset ] && megabrain_superset_available; then
    raw="$(megabrain_superset settings get worktreeBaseDir 2>/dev/null || true)"
    raw="$(printf '%s\n' "$raw" | megabrain_trim)"
    if [ -n "$raw" ] && [ "$raw" != "null" ]; then
      raw="$(printf '%s' "$raw" | jq -r 'if type == "object" then (.value // .result.value // .path // .result.path // empty) elif type == "string" then . else empty end' 2>/dev/null || printf '%s' "$raw")"
      raw="$(printf '%s\n' "$raw" | megabrain_trim)"
    fi
  fi

  if [ -z "$raw" ]; then
    raw="$(megabrain_worktree_root_state_read 2>/dev/null || true)"
  fi
  if [ -z "$raw" ]; then
    if [ "$read_only" = true ] || [ ! -t 0 ]; then
      megabrain_error "shared worktree root for host '$host' is unset; choose one interactively with megabrain worktree create or set $MEGABRAIN_STATE_DIR/worktree-root"
      return 1
    fi
    read -r -p "Shared worktree root: " raw
    [ -n "$raw" ] || { megabrain_error "worktree root cannot be empty"; return 1; }
    if [ "$host" = superset ] && megabrain_superset_available; then
      megabrain_superset settings set worktreeBaseDir "$raw" >/dev/null || return 1
    else
      megabrain_worktree_root_state_write "$raw" || return 1
    fi
  fi
  raw="${raw/#\~/$HOME}"
  if [ "${raw#/}" = "$raw" ]; then
    raw="$PWD/$raw"
  fi
  MEGABRAIN_SHARED_ROOT="$(cd "$raw" 2>/dev/null && pwd -P || true)"
  if [ -z "$MEGABRAIN_SHARED_ROOT" ]; then
    MEGABRAIN_SHARED_ROOT="$raw"
  fi
  printf '%s\n' "$MEGABRAIN_SHARED_ROOT"
}

megabrain_worktree_root_state_file() {
  printf '%s/worktree-root\n' "$MEGABRAIN_STATE_DIR"
}

megabrain_worktree_root_state_read() {
  local state_file="" raw=""
  state_file="$(megabrain_worktree_root_state_file)"
  [ -f "$state_file" ] || return 0
  IFS= read -r raw <"$state_file" || true
  printf '%s\n' "$raw" | megabrain_trim
}

megabrain_worktree_root_state_write() {
  local raw="$1" state_file="" temporary_file=""
  mkdir -p "$MEGABRAIN_STATE_DIR" || return 1
  state_file="$(megabrain_worktree_root_state_file)"
  temporary_file="$(mktemp "$MEGABRAIN_STATE_DIR/worktree-root.XXXXXX")" || return 1
  if ! printf '%s\n' "$raw" >"$temporary_file"; then
    rm -f "$temporary_file"
    return 1
  fi
  mv -f "$temporary_file" "$state_file"
}

megabrain_worktree_root_for_selector() {
  local selector="$1" selected_path="" worktree_root=""
  selected_path="$(cd "$selector" 2>/dev/null && pwd -P || true)"
  worktree_root="$(git -C "$selector" rev-parse --show-toplevel 2>/dev/null || true)"
  worktree_root="$(cd "$worktree_root" 2>/dev/null && pwd -P || true)"
  [ -n "$worktree_root" ] || {
    megabrain_error "worktree path is not a Git directory: $selector"
    return 1
  }
  if [ "$selected_path" != "$worktree_root" ]; then
    megabrain_error "worktree selector points to subdirectory: $selected_path; pass the worktree root $worktree_root and put cd $selected_path in the command"
    return 1
  fi
  printf '%s\n' "$worktree_root"
}

megabrain_terminal_record_path() {
  local terminal_id="$1"
  case "$terminal_id" in
    ''|.|..|*'/'*|*$'\n'*) return 1 ;;
  esac
  printf '%s/%s.json\n' "$MEGABRAIN_TERMINAL_DIR" "$terminal_id"
}

megabrain_terminal_json_number() {
  local response="$1" expression="$2" value
  value="$(printf '%s' "$response" | jq -r "$expression // empty" 2>/dev/null || true)"
  case "$value" in
    ''|*[!0-9]*) printf 'null\n' ;;
    *) printf '%s\n' "$value" ;;
  esac
}

megabrain_terminal_id_from_response() {
  printf '%s' "$1" | jq -r '
    .terminalId // .sessionId // .result.terminalId // .result.sessionId //
    .terminal.handle // .result.terminal.handle // .handle // .result.handle //
    .terminal.sessionId // .result.terminalSessionId // .terminal.id //
    .result.terminal.id // .id // empty
  ' 2>/dev/null
}

megabrain_terminal_shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

megabrain_terminal_identity_token() {
  local token
  token="$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d '[:space:]')"
  [ -n "$token" ] || token="$(date -u '+%s')-$$"
  printf '%s\n' "$token"
}

megabrain_terminal_identity_wrap_command() {
  local command_text="$1" token="$2" quoted_command
  quoted_command="$(megabrain_terminal_shell_quote "$command_text")"
  printf "printf 'MEGABRAIN_TERMINAL_PID_%s=%%s\\n' \"\$\$\"; exec sh -c %s\n" "$token" "$quoted_command"
}

megabrain_terminal_pid_from_marker() {
  local response="$1" marker="$2" pid
  pid="$(printf '%s' "$response" | jq -r '.. | strings' 2>/dev/null | sed -n "s/.*${marker}=\([0-9][0-9]*\).*/\1/p" | head -n 1)"
  case "$pid" in
    ''|0|*[!0-9]*) return 1 ;;
    *) printf '%s\n' "$pid" ;;
  esac
}

megabrain_terminal_identity_from_host() {
  local host="$1" workspace_id="$2" terminal_id="$3" marker="$4"
  local timeout_ms="${MEGABRAIN_TERMINAL_IDENTITY_TIMEOUT_MS:-10000}" attempts attempt response pid
  case "$timeout_ms" in
    ''|*[!0-9]*) timeout_ms=10000 ;;
  esac
  attempts=$(( (timeout_ms + 99) / 100 ))
  [ "$attempts" -gt 0 ] || attempts=1
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    case "$host" in
      superset) response="$(megabrain_superset terminals read --workspace "$workspace_id" --terminal "$terminal_id" --json 2>/dev/null || true)" ;;
      orca) response="$(orca terminal read --terminal "$terminal_id" --json 2>/dev/null || true)" ;;
      *) response='' ;;
    esac
    pid="$(megabrain_terminal_pid_from_marker "$response" "$marker" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      printf '%s\n' "$pid"
      return 0
    fi
    [ "$attempt" -lt "$attempts" ] && sleep 0.1
  done
  return 1
}

megabrain_terminal_record_write() {
  local terminal_id="$1" host="$2" workspace_id="$3" worktree_path="$4" title="$5"
  local command_text="$6" created_at="$7" pid_json="$8" port_json="$9" root_pid_json="${10:-$8}"
  local path tmp
  path="$(megabrain_terminal_record_path "$terminal_id")" || return 1
  mkdir -p "$MEGABRAIN_TERMINAL_DIR" || return 1
  tmp="$(mktemp "$MEGABRAIN_TERMINAL_DIR/.terminal.XXXXXX")" || return 1
  if ! jq -n \
    --arg terminalId "$terminal_id" --arg host "$host" --arg workspaceId "$workspace_id" \
    --arg worktree "$worktree_path" --arg title "$title" --arg command "$command_text" \
    --arg createdAt "$created_at" --argjson pid "$pid_json" --argjson port "$port_json" \
    --argjson rootPid "$root_pid_json" \
    '{terminalId: $terminalId, host: $host, workspaceId: (if $workspaceId == "" then null else $workspaceId end), worktree: $worktree, title: (if $title == "" then null else $title end), command: $command, createdAt: $createdAt, pid: $pid, rootPid: $rootPid, port: $port, status: "active"}' \
    >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_terminal_host_records() {
  local host="$1" workspace_id="$2"
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

megabrain_terminal_host_has_id() {
  local records="$1" terminal_id="$2"
  printf '%s' "$records" | jq -e --arg id "$terminal_id" '
    def records: if type == "array" then . else (.result.terminals // .terminals // .sessions // .result.sessions // []) end;
    any(records[]?; (.terminalId // .handle // .terminalHandle // .sessionId // .id // "") == $id)
  ' >/dev/null 2>&1
}

megabrain_terminal_host_entry() {
  local records="$1" terminal_id="$2"
  printf '%s' "$records" | jq -c --arg id "$terminal_id" '
    def records: if type == "array" then . else (.result.terminals // .terminals // .sessions // .result.sessions // []) end;
    first(records[]? | select((.terminalId // .handle // .terminalHandle // .sessionId // .id // "") == $id)) // empty
  ' 2>/dev/null
}

megabrain_terminal_host_process_status() {
  local records="$1" terminal_id="$2" record="$3" entry="" exited="" host_pid="" record_pid=""
  entry="$(megabrain_terminal_host_entry "$records" "$terminal_id")"
  [ -n "$entry" ] || { printf 'unknown\n'; return 0; }
  record_pid="$(printf '%s' "$record" | jq -r '.rootPid // .pid // empty' 2>/dev/null || true)"
  case "$record_pid" in
    ''|0|*[!0-9]*) record_pid='' ;;
  esac
  host_pid="$(printf '%s' "$entry" | jq -r '.rootPid // .pid // .processId // .process.pid // empty' 2>/dev/null || true)"
  case "$host_pid" in
    ''|0|*[!0-9]*) host_pid='' ;;
  esac
  [ -n "$record_pid" ] && [ -n "$host_pid" ] && [ "$record_pid" = "$host_pid" ] || {
    printf 'unknown\n'
    return 0
  }
  exited="$(printf '%s' "$entry" | jq -r 'if has("exited") then .exited else empty end' 2>/dev/null || true)"
  case "$exited" in
    true) printf 'dead\n'; return 0 ;;
    false) ;;
  esac
  case "$(printf '%s' "$entry" | jq -r '.status // .state // empty' 2>/dev/null || true)" in
    exited|dead|stopped|terminated) printf 'dead\n'; return 0 ;;
    active|alive|running) ;;
  esac
  host_pid="$(printf '%s' "$record" | jq -r '.rootPid // .pid // empty' 2>/dev/null || true)"
  case "$host_pid" in
    ''|0|*[!0-9]*) host_pid='' ;;
  esac
  if [ -n "$host_pid" ]; then
    if kill -0 "$host_pid" >/dev/null 2>&1; then
      printf 'alive\n'
    else
      printf 'dead\n'
    fi
    return 0
  fi
  port="$(printf '%s' "$record" | jq -r '.port // empty' 2>/dev/null || true)"
  case "$port" in
    ''|*[!0-9]*) port='' ;;
  esac
  if [ -n "$port" ]; then
    listener_pid="$(megabrain_terminal_listener_pid "$port")"
    if [ -n "$listener_pid" ]; then
      printf 'alive\n'
    else
      printf 'dead\n'
    fi
    return 0
  fi
  printf 'unknown\n'
}

megabrain_terminal_host_close() {
  local host="$1" workspace_id="$2" terminal_id="$3"
  case "$host" in
    superset)
      megabrain_superset terminals close --workspace "$workspace_id" --terminal "$terminal_id" --json
      ;;
    orca)
      orca terminal close --terminal "$terminal_id" --json
      ;;
    *)
      megabrain_error "unsupported host terminal context: $host"
      return 1
      ;;
  esac
}

megabrain_terminal_listener_pid() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1
}

megabrain_terminal_process_parent() {
  local pid="$1" parent
  parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  case "$parent" in
    ''|*[!0-9]*) return 1 ;;
    *) printf '%s\n' "$parent" ;;
  esac
}

megabrain_terminal_process_children() {
  pgrep -P "$1" 2>/dev/null || true
}

megabrain_terminal_process_tree_belongs_to() {
  local root_pid="$1" target_pid="$2" current="$2" parent attempt
  [ "$target_pid" = "$root_pid" ] && return 0
  for ((attempt = 1; attempt <= 64; attempt++)); do
    parent="$(megabrain_terminal_process_parent "$current" 2>/dev/null || true)"
    [ -n "$parent" ] || return 1
    [ "$parent" = "$root_pid" ] && return 0
    case "$parent" in
      0|1) return 1 ;;
    esac
    current="$parent"
  done
  return 1
}

megabrain_terminal_kill_process_tree() {
  local pid="$1" children="" child=""
  children="$(megabrain_terminal_process_children "$pid")"
  # Signal the recorded root first. This is the supervisor that can respawn a listener;
  # killing only the port holder leaves the old command alive.
  kill -TERM "$pid" 2>/dev/null || return 1
  MEGABRAIN_TERMINAL_KILLED_TREE="$(printf '%s' "$MEGABRAIN_TERMINAL_KILLED_TREE" | jq --argjson pid "$pid" '. + [$pid]')"
  while IFS= read -r child; do
    [ -n "$child" ] || continue
    megabrain_terminal_kill_process_tree "$child" || return 1
  done <<EOF
$children
EOF
}

megabrain_terminal_wait_for_port() {
  local port="$1" desired="$2" timeout="$3" started now elapsed
  started="$(date +%s)"
  while :; do
    if [ "$desired" = free ]; then
      [ -z "$(megabrain_terminal_listener_pid "$port")" ] && return 0
    else
      [ -n "$(megabrain_terminal_listener_pid "$port")" ] && return 0
    fi
    now="$(date +%s)"
    elapsed=$((now - started))
    [ "$elapsed" -ge "$timeout" ] && return 1
    sleep 0.1
  done
}

megabrain_terminal_resolve_selector() {
  local selector="$1" kind value path record match
  case "$selector" in
    id:*) kind=id; value="${selector#id:}" ;;
    title:*) kind=title; value="${selector#title:}" ;;
    port:*) kind=port; value="${selector#port:}" ;;
    worktree:*) kind=worktree; value="${selector#worktree:}" ;;
    *) return 1 ;;
  esac
  [ -n "$value" ] || return 1
  if [ "$kind" = worktree ] && [ -d "$value" ]; then
    value="$(megabrain_worktree_root_for_selector "$value")" || return 1
  fi
  for path in "$MEGABRAIN_TERMINAL_DIR"/*.json; do
    [ -f "$path" ] || continue
    record="$(cat "$path" 2>/dev/null || true)"
    printf '%s' "$record" | jq -e . >/dev/null 2>&1 || continue
    case "$kind" in
      id) match="$(printf '%s' "$record" | jq -r --arg value "$value" 'select(.terminalId == $value) | "yes"')" ;;
      title) match="$(printf '%s' "$record" | jq -r --arg value "$value" 'select((.title // "") == $value) | "yes"')" ;;
      port) match="$(printf '%s' "$record" | jq -r --arg value "$value" 'select((.port | tostring) == $value) | "yes"')" ;;
      worktree) match="$(printf '%s' "$record" | jq -r --arg value "$value" 'select(.worktree == $value) | "yes"')" ;;
    esac
    if [ "$match" = yes ]; then
      MEGABRAIN_TERMINAL_RESOLVED_PATH="$path"
      MEGABRAIN_TERMINAL_RESOLVED_RECORD="$record"
      MEGABRAIN_TERMINAL_RESOLVED_KIND="$kind"
      MEGABRAIN_TERMINAL_RESOLVED_VALUE="$value"
      return 0
    fi
  done
  return 1
}

megabrain_require_worktree_binary() {
  local typescript_binary="$1"
  if [ "${MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION:-}" = shell ]; then
    megabrain_error 'shell worktree implementation no longer exists; unset MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION to use the compiled binary'
    return 1
  fi
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  megabrain_warn_if_typescript_binary_stale
}

megabrain_worktree_finish() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
  megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" worktree finish "$@"
}

command_worktree() {
  local subcommand="${1:-}"
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  shift || true
  case "$subcommand" in
    create)
      megabrain_require_worktree_binary "$typescript_binary" || return 1
      "$typescript_binary" worktree create "$@"
      ;;
    pr|open-pr)
      [ -x "$typescript_binary" ] || { megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"; return 1; }
      # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" worktree pr "$@"
      ;;
    finish) megabrain_worktree_finish "$@" ;;
    list)
      [ -x "$typescript_binary" ] || { megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"; return 1; }
      # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" worktree list "$@"
      ;;
    adopt)
      [ -x "$typescript_binary" ] || { megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"; return 1; }
      # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" worktree adopt "$@"
      ;;
    -h|--help|"")
      megabrain_usage_show worktree
      ;;
    *) megabrain_error "unknown worktree command: $subcommand"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}

command_terminal() {
  local subcommand="${1:-}"
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  shift || true
  case "$subcommand" in
    create)
      [ -x "$typescript_binary" ] || { megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"; return 1; }
      # WHY: migrated lifecycle verbs have no shell fallback; keep the freshness notice on the direct wrapper.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" terminal create "$@"
      return $?
      ;;
    list)
      [ -x "$typescript_binary" ] || { megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"; return 1; }
      # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" terminal list "$@"
      ;;
    restart)
      [ -x "$typescript_binary" ] || { megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"; return 1; }
      # WHY: migrated lifecycle verbs have no shell fallback; keep the freshness notice on the direct wrapper.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" terminal restart "$@"
      return $?
      ;;
    close)
      [ -x "$typescript_binary" ] || { megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"; return 1; }
      # WHY: migrated lifecycle verbs have no shell fallback; keep the freshness notice on the direct wrapper.
      megabrain_warn_if_typescript_binary_stale
      "$typescript_binary" terminal close "$@"
      return $?
      ;;
    -h|--help|"")
      megabrain_usage_show terminal-create
      printf 'Superset tabs are not titled; only Orca tabs are.\n'
      ;;
    *) megabrain_error "unknown terminal command: $subcommand"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}

module_worktree_doctor() {
  if ! megabrain_superset_available; then
    megabrain_set_status missing "superset CLI is not on PATH and $HOME/.superset/bin/superset is unavailable"
    return 1
  fi
  if ! megabrain_require_command orca; then
    megabrain_set_status missing "orca CLI is not on PATH"
    return 1
  fi
  local root
  root="$(megabrain_worktree_root --read-only 2>/dev/null || true)"
  if [ -z "$root" ]; then
    megabrain_set_status misconfigured "Superset worktreeBaseDir is unset or unreadable"
    return 1
  fi
  megabrain_set_status ok "$root"
  return 0
}

module_worktree_install() {
  module_worktree_doctor
}
