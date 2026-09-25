#!/usr/bin/env bash

command_chain() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  local subcommand="${1:-}"
  case "$subcommand" in
    list|limits|add|edit|delete|repair|run|-h|--help|"")
      [ -x "$typescript_binary" ] || {
        megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
        return 1
      }
      # WHY: migrated chain verbs have no shell fallback; freshness remains visible at the boundary.
      megabrain_warn_if_typescript_binary_stale
      exec "$typescript_binary" chain "$@"
      ;;
  esac
  shift || true
  case "$subcommand" in
    -h|--help|"")
      megabrain_usage_show chain
      ;;
    *) megabrain_error "unknown chain command: $subcommand"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}
