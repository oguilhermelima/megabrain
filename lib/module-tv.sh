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

megabrain_tv_device_state() {
  local serial="$1"
  adb devices | awk -v serial="$serial" '$1 == serial {print $2; exit}'
}

command_tv() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  if [ -x "$typescript_binary" ] && [ "${MEGABRAIN_TV_IMPLEMENTATION:-}" != shell ]; then
    "$typescript_binary" tv "$@"
    return $?
  fi
  local operation="${1:-}" ip="" port=5555 arg serial state
  shift || true
  case "$operation" in
    connect)
      case "${1:-}" in
        -h|--help) megabrain_usage_show tv-connect; return 0 ;;
      esac
      ip="${1:-}"
      [ -n "$ip" ] || { megabrain_usage_fail tv-connect; return "$MEGABRAIN_USAGE_ERROR"; }
      shift
      while [ "$#" -gt 0 ]; do
        arg="$1"
        case "$arg" in
          --port) port="${2:-}"; shift 2 ;;
          -h|--help) megabrain_usage_show tv-connect; return 0 ;;
          *) megabrain_error "unknown tv connect option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
        esac
      done
      module_tv_adb_doctor >/dev/null || return 1
      serial="$ip:$port"
      adb connect "$serial" >/dev/null 2>&1 || true
      state="$(megabrain_tv_device_state "$serial")"
      if [ "$state" = device ]; then
        printf 'tv: connected (%s)\n' "$serial"
        return 0
      fi
      printf 'tv: not ready (%s: %s)\n' "$serial" "${state:-not listed}"
      return 1
      ;;
    disconnect)
      case "${1:-}" in
        -h|--help) megabrain_usage_show tv-disconnect; return 0 ;;
      esac
      ip="${1:-}"
      if [ "$#" -gt 0 ]; then
        shift
        [ "$#" -eq 0 ] || { megabrain_usage_fail tv-disconnect; return "$MEGABRAIN_USAGE_ERROR"; }
        module_tv_adb_doctor >/dev/null || return 1
        adb disconnect "$ip"
      else
        module_tv_adb_doctor >/dev/null || return 1
        adb disconnect
      fi
      ;;
    -h|--help|"") megabrain_usage_show tv-connect tv-disconnect ;;
    *) megabrain_error "unknown tv command: $operation"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}
