#!/usr/bin/env bash

megabrain_dispatch_watch() {
  local module_root typescript_binary
  module_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  typescript_binary="${MEGABRAIN_ROOT:-$module_root}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  [ -z "${MEGABRAIN_STATE_DIR:-}" ] || export MEGABRAIN_STATE_DIR
  # WHY: the wrapper keeps the watch path behind the same binary and freshness boundary.
  MEGABRAIN_ROOT="$module_root" megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" orchestrate watch "$@"
}

megabrain_dispatch_ack_for_owner() {
  local owner="${1:-}" module_root typescript_binary
  module_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  typescript_binary="${MEGABRAIN_ROOT:-$module_root}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  # WHY: acknowledgements are durable queue mutations, so the wrapper routes them through
  # the compiled command that owns the queue semantics.
  megabrain_warn_if_typescript_binary_stale
  shift
  case "$owner" in
    parent) "$typescript_binary" orchestrate ack "$@" ;;
    child) "$typescript_binary" ack "$@" ;;
    *) megabrain_error "unknown mailbox owner: $owner"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}

megabrain_dispatch_ack() {
  local module_root typescript_binary
  module_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  typescript_binary="${MEGABRAIN_ROOT:-$module_root}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  [ -z "${MEGABRAIN_STATE_DIR:-}" ] || export MEGABRAIN_STATE_DIR
  # WHY: keep the parent acknowledgement on the compiled command path.
  MEGABRAIN_ROOT="$module_root" megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" orchestrate ack "$@"
}

megabrain_dispatch_child_ack() {
  megabrain_dispatch_ack_for_owner child "$@"
}

command_ask() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
  megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" ask "$@"
}

command_received() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
  megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" received "$@"
}

command_done() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
  megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" done "$@"
}

command_check() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
  megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" check "$@"
}

command_ack() {
  megabrain_dispatch_child_ack "$@"
}
