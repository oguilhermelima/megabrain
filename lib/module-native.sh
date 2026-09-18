#!/usr/bin/env bash

megabrain_appium_driver_ready() {
  megabrain_require_command appium || return 1
  appium driver list --installed 2>&1 | grep -Eiq '(^|[[:space:]])xcuitest(@|[[:space:]]|$)'
}

module_simulator_native_doctor() {
  if [ "$(uname -s 2>/dev/null || printf unknown)" != Darwin ]; then
    megabrain_set_status unsupported "macOS only"
    return 1
  fi
  if ! megabrain_require_command appium; then
    megabrain_set_status missing "appium is not on PATH"
    return 1
  fi
  if ! megabrain_appium_driver_ready; then
    megabrain_set_status misconfigured "appium-xcuitest-driver is not installed"
    return 1
  fi
  megabrain_set_status ok "appium and xcuitest driver are installed"
  return 0
}

module_simulator_native_install() {
  module_simulator_native_doctor >/dev/null
  if [ "$?" -ne 0 ] && [ "$MODULE_STATUS" = unsupported ]; then
    megabrain_error "simulator-native is macOS only"
    return 1
  fi
  if ! megabrain_require_command appium; then
    npm install -g appium || return 1
  fi
  appium driver list --installed 2>&1 | grep -Eiq '(^|[[:space:]])xcuitest(@|[[:space:]]|$)' || appium driver install xcuitest || return 1
  module_simulator_native_doctor
}

# WHY: the wrapper remains a useful installed entrypoint even before its compiled payload is built.
command_native() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  "$typescript_binary" native "$@"
}

module_simulator_tv_doctor() {
  module_simulator_native_doctor
  if [ "$?" -eq 0 ]; then
    megabrain_set_status ok "Apple TV simulator uses the shared Appium xcuitest toolchain"
    return 0
  fi
  return 1
}

module_simulator_tv_install() {
  module_simulator_native_install
}
