#!/usr/bin/env bash

if ! declare -F megabrain_model_init >/dev/null 2>&1; then
  # shellcheck source=local/megabrain/lib/module-model.sh
  source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/module-model.sh"
fi

MEGABRAIN_CHAIN_AGENTS='codex claude agy'
MEGABRAIN_CHAIN_WINDOWS='5h weekly'

MEGABRAIN_CHAIN_TEMP_FILE=""
MEGABRAIN_CHAIN_TEMP_HUP_TRAP=""
MEGABRAIN_CHAIN_TEMP_INT_TRAP=""
MEGABRAIN_CHAIN_TEMP_TERM_TRAP=""

MEGABRAIN_CHAIN_LIMIT_STATUS="unknown"
MEGABRAIN_CHAIN_LIMIT_USED=""
MEGABRAIN_CHAIN_LIMIT_RESETS=""
MEGABRAIN_CHAIN_LIMIT_REASON=""
MEGABRAIN_CHAIN_LIMIT_SOURCE=""
MEGABRAIN_CHAIN_LIMIT_RESULT=""
MEGABRAIN_CHAIN_LIMIT_FETCHED_AT=""

MEGABRAIN_CHAIN_SELECTED_NAME=""
MEGABRAIN_CHAIN_SELECTED_STEPS="[]"
MEGABRAIN_CHAIN_SELECTION_REASON=""
MEGABRAIN_CHAIN_SELECTION_DEFAULT=false

MEGABRAIN_CHAIN_WALK_OUTPUT=""
MEGABRAIN_CHAIN_WALK_SPAWN_JSON=null
MEGABRAIN_CHAIN_WALK_AGENT=""
MEGABRAIN_CHAIN_WALK_STEP=""
MEGABRAIN_CHAIN_WALK_TOTAL=""
MEGABRAIN_CHAIN_WALK_REASON=""
MEGABRAIN_CHAIN_WALK_SKIPPED='[]'
MEGABRAIN_CHAIN_WALK_DISPATCH_ID=""
MEGABRAIN_CHAIN_WALK_START_INDEX=0
MEGABRAIN_CHAIN_CODEX_ROLLOUT_SCAN_LIMIT=50

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
