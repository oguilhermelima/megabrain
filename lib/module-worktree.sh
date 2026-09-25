#!/usr/bin/env bash

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
