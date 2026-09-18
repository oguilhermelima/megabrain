#!/usr/bin/env bash

module_tv_adb_doctor() {
  if ! megabrain_require_command adb; then
    megabrain_set_status missing "adb is not on PATH"
    return 1
  fi
  if ! adb version >/dev/null 2>&1; then
    megabrain_set_status misconfigured "adb version failed"
    return 1
  fi
  megabrain_set_status ok "adb is available"
  return 0
}

module_tv_adb_install() {
  if megabrain_require_command adb; then
    module_tv_adb_doctor
    return $?
  fi
  if megabrain_require_command brew; then
    megabrain_notice "adb is missing. Install Android platform-tools with: brew install android-platform-tools"
  else
    megabrain_notice "adb is missing. Install Android platform-tools with your OS package manager (for example: apt-get install adb)"
  fi
  megabrain_set_status missing "adb is not on PATH"
  return 1
}

# WHY: the wrapper remains a useful installed entrypoint even before its compiled payload is built.
command_tv() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
  megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" tv "$@"
}
