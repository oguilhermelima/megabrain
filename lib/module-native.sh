#!/usr/bin/env bash

MEGABRAIN_APPIUM_PORT="${MEGABRAIN_APPIUM_PORT:-4723}"
MEGABRAIN_APPIUM_PIDFILE="$MEGABRAIN_STATE_DIR/appium.pid"
MEGABRAIN_APPIUM_LOG="$MEGABRAIN_STATE_DIR/appium.log"
MEGABRAIN_NATIVE_DEFAULT_TIMEOUT="${MEGABRAIN_NATIVE_DEFAULT_TIMEOUT:-30}"

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

megabrain_appium_pid() {
  local pid=""
  if [ -f "$MEGABRAIN_APPIUM_PIDFILE" ]; then
    pid="$(sed -n '1p' "$MEGABRAIN_APPIUM_PIDFILE")"
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      printf '%s\n' "$pid"
      return 0
    fi
  fi
  lsof -tiTCP:"$MEGABRAIN_APPIUM_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1
}

megabrain_appium_status() {
  local pid command_line
  pid="$(megabrain_appium_pid)"
  if [ -z "$pid" ]; then
    printf 'appium: down (port %s)\n' "$MEGABRAIN_APPIUM_PORT"
    return 1
  fi
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [ -n "$command_line" ] && [[ "$command_line" != *appium* ]]; then
    printf 'appium: occupied (port %s, pid %s)\n' "$MEGABRAIN_APPIUM_PORT" "$pid"
    return 1
  fi
  printf 'appium: up (port %s, pid %s)\n' "$MEGABRAIN_APPIUM_PORT" "$pid"
  return 0
}

megabrain_appium_start() {
  local pid
  if megabrain_appium_status >/dev/null 2>&1; then
    megabrain_appium_status
    return 0
  fi
  module_simulator_native_doctor >/dev/null || {
    megabrain_error "appium is not ready; run megabrain install simulator-native"
    return 1
  }
  mkdir -p "$MEGABRAIN_STATE_DIR" || return 1
  nohup appium --port "$MEGABRAIN_APPIUM_PORT" >"$MEGABRAIN_APPIUM_LOG" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" >"$MEGABRAIN_APPIUM_PIDFILE"
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.2
    if megabrain_appium_status >/dev/null 2>&1; then
      megabrain_appium_status
      return 0
    fi
  done
  megabrain_error "appium did not start on port $MEGABRAIN_APPIUM_PORT; see $MEGABRAIN_APPIUM_LOG"
  return 1
}

megabrain_appium_stop() {
  local pid command_line
  pid="$(megabrain_appium_pid)"
  if [ -z "$pid" ]; then
    rm -f "$MEGABRAIN_APPIUM_PIDFILE"
    printf 'appium: already stopped\n'
    return 0
  fi
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [ -n "$command_line" ] && [[ "$command_line" != *appium* ]]; then
    megabrain_error "refusing to stop non-Appium process $pid on port $MEGABRAIN_APPIUM_PORT"
    return 1
  fi
  kill "$pid" >/dev/null 2>&1 || true
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" >/dev/null 2>&1 || break
    sleep 0.2
  done
  rm -f "$MEGABRAIN_APPIUM_PIDFILE"
  printf 'appium: stopped (pid %s)\n' "$pid"
}

megabrain_native_kind_label() {
  case "$1" in
    phone) printf 'iOS' ;;
    tv) printf 'tvOS' ;;
    *) return 1 ;;
  esac
}

megabrain_native_validate_kind() {
  case "$1" in
    phone|tv) return 0 ;;
    *) megabrain_error "expected simulator kind phone or tv, got: $1"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}

megabrain_native_require_simctl() {
  if [ "$(uname -s 2>/dev/null || printf unknown)" != Darwin ]; then
    megabrain_error 'native simulator commands require macOS'
    return 1
  fi
  if ! megabrain_require_command xcrun; then
    megabrain_error 'xcrun is not on PATH'
    return 1
  fi
}

megabrain_native_worktree_root() {
  local path="${MEGABRAIN_NATIVE_WORKTREE:-$PWD}" root
  root="$(git -C "$path" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$root" ]; then
    printf '%s\n' "$root"
  else
    printf '%s\n' "$path"
  fi
}

megabrain_native_config_file() {
  printf '%s/.megabrain/native.json\n' "$(megabrain_native_worktree_root)"
}

megabrain_native_config_validate() {
  local config
  config="$(megabrain_native_config_file)"
  [ -f "$config" ] || return 0
  if ! jq -e 'type == "object" and .version == 1 and (.surfaces | type == "object")' "$config" >/dev/null 2>&1; then
    megabrain_error "invalid native simulator config: $config"
    return 1
  fi
}

megabrain_native_config_value() {
  local surface="$1" key="$2" config
  config="$(megabrain_native_config_file)"
  [ -f "$config" ] || return 0
  jq -r --arg surface "$surface" --arg key "$key" \
    '.surfaces[$surface][$key] // empty | tostring' "$config" 2>/dev/null || true
}

megabrain_native_validate_timeout() {
  case "$1" in
    ''|*[!0-9]*|0) megabrain_error "timeout must be a positive integer: $1"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}

megabrain_native_validate_metro_port() {
  case "$1" in
    ''|none) return 0 ;;
    *[!0-9]*) megabrain_error "metro port must be an integer or none: $1"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || {
    megabrain_error "metro port must be between 1 and 65535: $1"
    return "$MEGABRAIN_USAGE_ERROR"
  }
}

megabrain_native_simulator_candidates() {
  local kind="$1" devices runtime_fragment
  runtime_fragment="iOS"
  [ "$kind" = tv ] && runtime_fragment="tvOS"
  devices="$(xcrun simctl list devices --json 2>/dev/null)" || {
    megabrain_error 'failed to list simulators with simctl'
    return 1
  }
  printf '%s\n' "$devices" | jq -r --arg runtime "$runtime_fragment" '
    .devices // {}
    | to_entries[]
    | select(.key | contains($runtime))
    | .value[]
    | select(.isAvailable == true)
    | [.udid, .state, .name] | @tsv
  ' 2>/dev/null || {
    megabrain_error 'simctl returned invalid device data'
    return 1
  }
}

megabrain_native_select_device() {
  local kind="$1" requested="$2" booted_only="$3" candidates line udid state name
  local count=0 selected_udid='' selected_state=''
  candidates="$(megabrain_native_simulator_candidates "$kind")" || return 1
  while IFS=$'\t' read -r udid state name; do
    [ -n "$udid" ] || continue
    if [ -n "$requested" ] && [ "$udid" != "$requested" ]; then
      continue
    fi
    if [ "$booted_only" = true ] && [ "$state" != Booted ]; then
      continue
    fi
    count=$((count + 1))
    selected_udid="$udid"
    selected_state="$state"
  done <<<"$candidates"

  local label
  label="$(megabrain_native_kind_label "$kind")"
  if [ "$count" -eq 0 ]; then
    if [ "$booted_only" = true ]; then
      if [ -n "$requested" ]; then
        megabrain_error "simulator $requested is not a booted $label simulator"
      else
        megabrain_error "no booted $label simulator is available; run megabrain native sim ensure $kind"
      fi
    elif [ -n "$requested" ]; then
      megabrain_error "no $label simulator matches device $requested"
    else
      megabrain_error "no $label simulator matches the requested kind"
    fi
    return 1
  fi
  if [ "$count" -gt 1 ]; then
    if [ "$booted_only" = true ]; then
      megabrain_error "more than one booted $label simulator matches; pass --device <udid>"
    else
      megabrain_error "more than one $label simulator matches; pass --device <udid>"
    fi
    return 1
  fi
  MEGABRAIN_NATIVE_SELECTED_UDID="$selected_udid"
  MEGABRAIN_NATIVE_SELECTED_STATE="$selected_state"
}

megabrain_native_sim_ensure() {
  local kind='' device='' timeout="$MEGABRAIN_NATIVE_DEFAULT_TIMEOUT" json=false arg
  local candidates state boot_output boot_rc attempt
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --device)
        [ "$#" -ge 2 ] || { megabrain_usage_fail native-sim-ensure; return "$MEGABRAIN_USAGE_ERROR"; }
        device="$2"; shift 2 ;;
      --timeout)
        [ "$#" -ge 2 ] || { megabrain_usage_fail native-sim-ensure; return "$MEGABRAIN_USAGE_ERROR"; }
        timeout="$2"; shift 2 ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show native-sim-ensure; return 0 ;;
      -*) megabrain_error "unknown native sim ensure option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
      *)
        [ -z "$kind" ] || { megabrain_usage_fail native-sim-ensure; return "$MEGABRAIN_USAGE_ERROR"; }
        kind="$arg"; shift ;;
    esac
  done
  [ -n "$kind" ] || { megabrain_usage_fail native-sim-ensure; return "$MEGABRAIN_USAGE_ERROR"; }
  megabrain_native_validate_kind "$kind" || return $?
  megabrain_native_validate_timeout "$timeout" || return $?
  megabrain_native_require_simctl || return 1
  megabrain_native_select_device "$kind" "$device" false || return 1

  if [ "$MEGABRAIN_NATIVE_SELECTED_STATE" != Booted ]; then
    boot_output="$(xcrun simctl boot "$MEGABRAIN_NATIVE_SELECTED_UDID" 2>&1)"
    boot_rc=$?
    if [ "$boot_rc" -ne 0 ]; then
      megabrain_error "failed to boot simulator $MEGABRAIN_NATIVE_SELECTED_UDID: ${boot_output:-simctl exited $boot_rc}"
      return 1
    fi
  fi

  attempt=0
  while [ "$attempt" -lt $((timeout * 5)) ]; do
    candidates="$(megabrain_native_simulator_candidates "$kind")" || return 1
    state=''
    while IFS=$'\t' read -r MEGABRAIN_NATIVE_CANDIDATE_UDID state MEGABRAIN_NATIVE_CANDIDATE_NAME; do
      [ "$MEGABRAIN_NATIVE_CANDIDATE_UDID" = "$MEGABRAIN_NATIVE_SELECTED_UDID" ] || continue
      break
    done <<<"$candidates"
    if [ "$state" = Booted ]; then
      if [ "$json" = true ]; then
        jq -n --arg kind "$kind" --arg udid "$MEGABRAIN_NATIVE_SELECTED_UDID" \
          '{ok: true, kind: $kind, device: $udid, state: "Booted"}'
      else
        printf 'simulator %s is booted\n' "$MEGABRAIN_NATIVE_SELECTED_UDID"
      fi
      return 0
    fi
    sleep 0.2
    attempt=$((attempt + 1))
  done
  megabrain_error "timed out waiting for simulator $MEGABRAIN_NATIVE_SELECTED_UDID to become booted"
  return 1
}

megabrain_native_render_url() {
  local template="$1" route="$2" metro_port="$3" bundle_id="$4" device="$5"
  route="${route#/}"
  template="${template//\{route\}/$route}"
  template="${template//\{metro_port\}/$metro_port}"
  template="${template//\{bundle_id\}/$bundle_id}"
  template="${template//\{device\}/$device}"
  case "$template" in
    *'{'*|*'}'*) megabrain_error 'URL template contains an unsupported placeholder'; return 1 ;;
  esac
  printf '%s\n' "$template"
}

megabrain_native_wait_for_metro() {
  local port="$1" timeout="$2" attempt=0
  [ -n "$port" ] || return 0
  megabrain_require_command curl || {
    megabrain_error 'curl is required to check Metro'
    return 1
  }
  while [ "$attempt" -lt $((timeout * 5)) ]; do
    if curl -fsS --max-time 1 "http://127.0.0.1:$port/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
    attempt=$((attempt + 1))
  done
  megabrain_error "Metro did not answer on port $port within ${timeout}s"
  return 1
}

megabrain_native_app_reload() {
  local kind='' route='' bundle_id='' url_template='' device='' metro_port='' timeout="$MEGABRAIN_NATIVE_DEFAULT_TIMEOUT" json=false arg
  local configured_value url terminate_output terminate_rc terminate_lower
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --route|--bundle-id|--url-template|--device|--metro-port|--timeout)
        [ "$#" -ge 2 ] || { megabrain_usage_fail native-app-reload; return "$MEGABRAIN_USAGE_ERROR"; }
        case "$arg" in
          --route) route="$2" ;;
          --bundle-id) bundle_id="$2" ;;
          --url-template) url_template="$2" ;;
          --device) device="$2" ;;
          --metro-port) metro_port="$2" ;;
          --timeout) timeout="$2" ;;
        esac
        shift 2 ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show native-app-reload; return 0 ;;
      -*) megabrain_error "unknown native app reload option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
      *)
        [ -z "$kind" ] || { megabrain_usage_fail native-app-reload; return "$MEGABRAIN_USAGE_ERROR"; }
        kind="$arg"; shift ;;
    esac
  done
  [ -n "$kind" ] || { megabrain_usage_fail native-app-reload; return "$MEGABRAIN_USAGE_ERROR"; }
  megabrain_native_validate_kind "$kind" || return $?
  megabrain_native_validate_timeout "$timeout" || return $?
  megabrain_native_config_validate || return 1

  if [ -z "$url_template" ]; then
    configured_value="$(megabrain_native_config_value "$kind" urlTemplate)"
    url_template="$configured_value"
  fi
  if [ -z "$bundle_id" ]; then
    configured_value="$(megabrain_native_config_value "$kind" bundleId)"
    bundle_id="$configured_value"
  fi
  if [ -z "$metro_port" ]; then
    configured_value="$(megabrain_native_config_value "$kind" metroPort)"
    metro_port="$configured_value"
  fi
  [ -n "$url_template" ] || { megabrain_error "URL template is required for $kind; pass --url-template"; return 1; }
  [ -n "$bundle_id" ] || { megabrain_error "bundle id is required for $kind; pass --bundle-id"; return 1; }
  [ "$metro_port" = none ] && metro_port=''
  megabrain_native_validate_metro_port "$metro_port" || return $?
  url="$(megabrain_native_render_url "$url_template" "$route" "$metro_port" "$bundle_id" "$device")" || return 1
  megabrain_native_require_simctl || return 1
  megabrain_native_select_device "$kind" "$device" true || return 1
  megabrain_native_wait_for_metro "$metro_port" "$timeout" || return 1

  terminate_output="$(xcrun simctl terminate "$MEGABRAIN_NATIVE_SELECTED_UDID" "$bundle_id" 2>&1)"
  terminate_rc=$?
  if [ "$terminate_rc" -ne 0 ]; then
    terminate_lower="$(printf '%s' "$terminate_output" | tr '[:upper:]' '[:lower:]')"
    case "$terminate_lower" in
      *'not running'*|*'no such process'*|*'does not exist'*|*'not found'*|*'nothing to terminate'*) ;;
      *) megabrain_error "failed to terminate $bundle_id on simulator $MEGABRAIN_NATIVE_SELECTED_UDID: ${terminate_output:-simctl exited $terminate_rc}"; return 1 ;;
    esac
  fi
  if ! xcrun simctl openurl "$MEGABRAIN_NATIVE_SELECTED_UDID" "$url" >/dev/null 2>&1; then
    megabrain_error "failed to open URL on simulator $MEGABRAIN_NATIVE_SELECTED_UDID: $url"
    return 1
  fi
  if [ "$json" = true ]; then
    jq -n --arg kind "$kind" --arg udid "$MEGABRAIN_NATIVE_SELECTED_UDID" --arg bundleId "$bundle_id" --arg url "$url" \
      '{ok: true, kind: $kind, device: $udid, bundleId: $bundleId, url: $url, terminated: true, opened: true, renderObserved: false}'
  else
    printf 'reloaded %s on simulator %s: terminated and opened %s; app rendering was not observed\n' "$bundle_id" "$MEGABRAIN_NATIVE_SELECTED_UDID" "$url"
  fi
}

command_native() {
  local family="${1:-}" operation="${2:-}" arg
  shift || true
  shift || true
  case "$family" in
    appium)
      case "${1:-}" in
        -h|--help) megabrain_usage_show native-appium; return 0 ;;
      esac
      [ "$#" -eq 0 ] || { megabrain_error "unknown native appium option: $1"; return "$MEGABRAIN_USAGE_ERROR"; }
      case "$operation" in
        start) megabrain_appium_start ;;
        stop) megabrain_appium_stop ;;
        status) megabrain_appium_status ;;
        -h|--help|"") megabrain_usage_show native-appium ;;
        *) megabrain_error "unknown appium operation: $operation"; return "$MEGABRAIN_USAGE_ERROR" ;;
      esac
      ;;
    sim)
      case "$operation" in
        ensure) megabrain_native_sim_ensure "$@" ;;
        list) megabrain_native_sim_list "$@" ;;
        -h|--help|"") megabrain_usage_show native-sim-list native-sim-ensure ;;
        *) megabrain_error "unknown native sim operation: $operation"; return "$MEGABRAIN_USAGE_ERROR" ;;
      esac
      ;;
    app)
      case "$operation" in
        reload) megabrain_native_app_reload "$@" ;;
        -h|--help|"") megabrain_usage_show native-app-reload ;;
        *) megabrain_error "unknown native app operation: $operation"; return "$MEGABRAIN_USAGE_ERROR" ;;
      esac
      ;;
    -h|--help|"") megabrain_usage_show native-sim-list native-sim-ensure native-app-reload native-appium ;;
    *) megabrain_error "unknown native command: $family"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
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
