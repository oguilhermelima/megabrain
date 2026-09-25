#!/usr/bin/env bash

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

command_orchestrate_list() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  # WHY: keep this command wrapper as a direct binary boundary.
  megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" orchestrate list "$@"
}
