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
  local pid='' command_line=''
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
  local pid=''
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
  local attempt=0
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
  local pid='' command_line=''
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
  local attempt=0
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
  local path="${MEGABRAIN_NATIVE_WORKTREE:-$PWD}" root=''
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
  local config=''
  config="$(megabrain_native_config_file)"
  [ -f "$config" ] || return 0
  if ! jq -e 'type == "object" and .version == 1 and (.surfaces | type == "object")' "$config" >/dev/null 2>&1; then
    megabrain_error "invalid native simulator config: $config"
    return 1
  fi
}

megabrain_native_config_value() {
  local surface="$1" key="$2" config=''
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
  local kind="$1" devices='' runtime_fragment=''
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

megabrain_native_sim_list() {
  local kind='' json=false arg='' candidates='' line='' udid='' state='' name=''
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show native-sim-list; return 0 ;;
      -*) megabrain_error "unknown native sim list option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
      *)
        [ -z "$kind" ] || { megabrain_usage_fail native-sim-list; return "$MEGABRAIN_USAGE_ERROR"; }
        kind="$arg"; shift ;;
    esac
  done
  [ -n "$kind" ] || { megabrain_usage_fail native-sim-list; return "$MEGABRAIN_USAGE_ERROR"; }
  megabrain_native_validate_kind "$kind" || return $?
  megabrain_native_require_simctl || return 1
  candidates="$(megabrain_native_simulator_candidates "$kind")" || return 1

  if [ "$json" = true ]; then
    printf '%s\n' "$candidates" | jq -Rsc --arg kind "$kind" '
      split("\n")
      | map(select(length > 0) | split("\t") | {udid: .[0], state: .[1], name: .[2]})
      | {kind: $kind, devices: .}
    '
    return $?
  fi

  while IFS=$'\t' read -r udid state name; do
    [ -n "$udid" ] || continue
    printf '%s\t%s\t%s\n' "$name" "$state" "$udid"
  done <<<"$candidates"
}

megabrain_native_runtime_list() {
  local platform='' installed=false available=false json=false arg='' raw='' prefix='' versions=''
  while [ "$#" -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      --installed) installed=true ;;
      --available) available=true ;;
      --json) json=true ;;
      -h|--help) megabrain_usage_show native-runtime-list; return 0 ;;
      ios|iOS) [ -z "$platform" ] || { megabrain_error "unknown native runtime list option: $arg"; return "$MEGABRAIN_USAGE_ERROR"; }; platform=iOS ;;
      tvos|tvOS) [ -z "$platform" ] || { megabrain_error "unknown native runtime list option: $arg"; return "$MEGABRAIN_USAGE_ERROR"; }; platform=tvOS ;;
      *) megabrain_error "unknown native runtime list option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  [ "$installed" != "$available" ] || { megabrain_error 'native runtime list requires exactly one of --installed or --available'; return "$MEGABRAIN_USAGE_ERROR"; }
  if [ "$installed" = true ]; then
    megabrain_native_require_simctl || return 1
    raw="$(xcrun simctl list runtimes --json 2>/dev/null)" || { megabrain_error 'failed to list runtimes with simctl'; return 1; }
    if [ "$json" = true ]; then
      printf '%s' "$raw" | jq -c --arg platform "${platform:-all}" '{platform:$platform,runtimes:(.runtimes // [] | map(select((.name // "") | startswith(if $platform == "all" then "" else $platform end)) | {platform:(if (.name|startswith("iOS")) then "iOS" else "tvOS" end),version,build:(.buildversion // .buildVersion),identifier}),available:[],refusal:null}'
    else
      printf '%s' "$raw" | jq -r --arg platform "${platform:-all}" '.runtimes // [] | .[] | select($platform == "all" or ((.name // "") | startswith($platform))) | [.name|split(" ")[0],.version,(.buildversion // .buildVersion),.identifier] | @tsv'
    fi
    return $?
  fi
  local facts="${MEGABRAIN_FACTS_FILE:-${MEGABRAIN_ROOT:-$PWD}/.megabrain/facts.json}"
  prefix="$platform"; case "$prefix" in iOS) prefix=ios ;; tvOS) prefix=tvos ;; esac
  [ -f "$facts" ] && versions="$(jq -r --arg prefix "native-runtime-$prefix-" '.facts // [] | .[] | select(.id | startswith($prefix)) | .id[$prefix|length:] | gsub("-"; ".")' "$facts" 2>/dev/null)" || versions=''
  if [ "$json" = true ]; then
    jq -n --arg platform "${platform:-all}" --arg versions "$versions" '{platform:$platform,runtimes:[],available:([$versions|split("\n")[]|select(length>0)|{platform:$platform,version:.}]),refusal:null}'
  elif [ -n "$versions" ]; then while IFS= read -r arg; do printf '%s\t%s\n' "${platform:-unknown}" "$arg"; done <<<"$versions"; else printf 'no known runtime versions are available for download\n'; fi
}

megabrain_native_runtime_install() {
  local platform='' version='' json=false arg='' raw=''
  while [ "$#" -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      --json) json=true ;;
      ios|iOS) platform=iOS ;;
      tvos|tvOS) platform=tvOS ;;
      -h|--help) megabrain_usage_show native-runtime-install; return 0 ;;
      -*) megabrain_error "unknown native runtime install option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
      *) [ -z "$version" ] || { megabrain_error "unknown native runtime install option: $arg"; return "$MEGABRAIN_USAGE_ERROR"; }; version="$arg" ;;
    esac
  done
  [ -n "$platform" ] && [ -n "$version" ] || { megabrain_error 'native runtime install requires <platform> <version>'; return "$MEGABRAIN_USAGE_ERROR"; }
  xcodebuild -downloadPlatform "$platform" -buildVersion "$version" || { megabrain_error "failed to download $platform $version"; return 1; }
  raw="$(xcrun simctl list runtimes --json 2>/dev/null)" || { megabrain_error 'failed to list runtimes with simctl'; return 1; }
  if ! printf '%s' "$raw" | jq -e --arg platform "$platform" --arg version "$version" '.runtimes // [] | any(.[]; ((.name // "") | startswith($platform)) and .version == $version)' >/dev/null; then
    megabrain_error "runtime download reported success, but simctl does not list $platform $version"; return 1
  fi
  if [ "$json" = true ]; then printf '%s' "$raw" | jq -c --arg platform "$platform" --arg version "$version" '{platform:$platform,version:$version,runtime:([.runtimes[]|select(.version==$version and (.name|startswith($platform)))][0]),refusal:null}'; else printf 'installed %s %s\n' "$platform" "$version"; fi
}

megabrain_native_select_device() {
  local kind="$1" requested="$2" booted_only="$3" candidates='' line='' udid='' state='' name=''
  local count=0 identifier_count=0 name_count=0 selected_udid='' selected_state='' selector_type=''
  candidates="$(megabrain_native_simulator_candidates "$kind")" || return 1
  while IFS=$'\t' read -r udid state name; do
    [ -n "$udid" ] || continue
    if [ "$booted_only" = true ] && [ "$state" != Booted ]; then
      continue
    fi
    if [ -n "$requested" ]; then
      if [ "$udid" = "$requested" ]; then
        identifier_count=$((identifier_count + 1))
        selected_udid="$udid"
        selected_state="$state"
      elif [ "$name" = "$requested" ]; then
        name_count=$((name_count + 1))
        if [ "$identifier_count" -eq 0 ]; then
          selected_udid="$udid"
          selected_state="$state"
        fi
      fi
    else
      count=$((count + 1))
      selected_udid="$udid"
      selected_state="$state"
    fi
  done <<<"$candidates"

  if [ -n "$requested" ]; then
    case "$requested" in
      *[!0123456789abcdefABCDEF-]*) selector_type='name' ;;
      *) selector_type='device' ;;
    esac
    if [ "$identifier_count" -gt 0 ]; then
      count="$identifier_count"
    else
      count="$name_count"
      [ "$name_count" -gt 0 ] && selector_type='name'
    fi
  fi

  local label=''
  label="$(megabrain_native_kind_label "$kind")"
  if [ "$count" -eq 0 ]; then
    if [ "$booted_only" = true ]; then
      if [ -n "$requested" ]; then
        if [ "$selector_type" = name ]; then
          megabrain_error "simulator name $requested is not a booted $label simulator"
        else
          megabrain_error "simulator $requested is not a booted $label simulator"
        fi
      else
        megabrain_error "no booted $label simulator is available; run megabrain native sim ensure $kind"
      fi
    elif [ -n "$requested" ]; then
      if [ "$selector_type" = name ]; then
        megabrain_error "no $label simulator matches device name $requested"
      else
        megabrain_error "no $label simulator matches device $requested"
      fi
    else
      megabrain_error "no $label simulator matches the requested kind"
    fi
    return 1
  fi
  if [ "$count" -gt 1 ]; then
    if [ "$booted_only" = true ]; then
      if [ "$selector_type" = name ]; then
        megabrain_error "more than one booted $label simulator matches name $requested; pass --device <udid>"
      else
        megabrain_error "more than one booted $label simulator matches; pass --device <udid>"
      fi
    else
      if [ "$selector_type" = name ]; then
        megabrain_error "more than one $label simulator matches name $requested; pass --device <udid>"
      else
        megabrain_error "more than one $label simulator matches; pass --device <udid>"
      fi
    fi
    return 1
  fi
  MEGABRAIN_NATIVE_SELECTED_UDID="$selected_udid"
  MEGABRAIN_NATIVE_SELECTED_STATE="$selected_state"
}

megabrain_native_sim_ensure() {
  local kind='' device='' timeout="$MEGABRAIN_NATIVE_DEFAULT_TIMEOUT" json=false arg=''
  local candidates='' state='' boot_output='' boot_rc=0 attempt=0 configured_value=''
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
  megabrain_native_config_validate || return 1
  if [ -z "$device" ]; then
    configured_value="$(megabrain_native_config_value "$kind" device)"
    device="$configured_value"
  fi
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
  local kind='' route='' bundle_id='' url_template='' device='' metro_port='' timeout="$MEGABRAIN_NATIVE_DEFAULT_TIMEOUT" json=false arg=''
  local configured_value='' url='' terminate_output='' terminate_rc=0 terminate_lower=''
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
  if [ -z "$device" ]; then
    configured_value="$(megabrain_native_config_value "$kind" device)"
    device="$configured_value"
  fi
  [ -n "$url_template" ] || { megabrain_error "URL template is required for $kind; pass --url-template"; return 1; }
  [ -n "$bundle_id" ] || { megabrain_error "bundle id is required for $kind; pass --bundle-id"; return 1; }
  [ "$metro_port" = none ] && metro_port=''
  megabrain_native_validate_metro_port "$metro_port" || return $?
  megabrain_native_require_simctl || return 1
  megabrain_native_select_device "$kind" "$device" true || return 1
  url="$(megabrain_native_render_url "$url_template" "$route" "$metro_port" "$bundle_id" "$MEGABRAIN_NATIVE_SELECTED_UDID")" || return 1
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

megabrain_native_crashes() {
  local kind="${1:-}" last=1 arg='' directory target path header body app signing exception signal termination fault frames count=0
  shift || true
  [ -n "$kind" ] || { megabrain_usage_fail native-crashes; return "$MEGABRAIN_USAGE_ERROR"; }
  while [ "$#" -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      --last) [ "$#" -gt 0 ] || { megabrain_error 'missing value for --last'; return "$MEGABRAIN_USAGE_ERROR"; }; last="$1"; shift ;;
      --json) megabrain_error 'native crashes --json is only available in the TypeScript implementation'; return 2 ;;
      -h|--help) megabrain_usage_show native-crashes; return 0 ;;
      *) megabrain_error "unknown native crashes option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  [[ "$last" =~ ^[1-9][0-9]*$ ]] || { megabrain_error "last must be a positive integer: $last"; return "$MEGABRAIN_USAGE_ERROR"; }
  target="$(megabrain_native_config_value "$kind" bundleId)" || return 1
  [ -n "$target" ] || { megabrain_error "bundle id is required for $kind; pass --bundle-id in .megabrain/native.json"; return 1; }
  directory="${MEGABRAIN_NATIVE_CRASH_REPORTS_DIR:-$HOME/Library/Logs/DiagnosticReports}"
  [ -d "$directory" ] || { megabrain_error "cannot read crash reports directory: $directory"; return 1; }
  local ordered_paths=''
  ordered_paths="$(for path in "$directory"/*.ips; do
    [ -f "$path" ] || continue
    printf '%s %s\n' "$(megabrain_path_mtime "$path" || printf 0)" "$path"
  done | sort -rn | cut -d' ' -f2-)"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    [ -f "$path" ] || continue
    header="$(head -n 1 "$path" 2>/dev/null || true)"
    body="$(tail -n +2 "$path" 2>/dev/null || true)"
    if ! app="$(printf '%s' "$header" | jq -er '.app_name' 2>/dev/null)" || ! exception="$(printf '%s' "$body" | jq -er '.exception.type' 2>/dev/null)"; then
      megabrain_error "$(basename "$path"): report cannot be parsed"
      continue
    fi
    signing="$(printf '%s' "$body" | jq -r '.codeSigningID // empty' 2>/dev/null || true)"
    if [[ "$target" == *.* ]]; then [ "$signing" = "$target" ] || continue; else [ "$app" = "$target" ] || continue; fi
    fault="$(printf '%s' "$body" | jq -er '.faultingThread as $i | .threads[$i].frames' 2>/dev/null)" || { megabrain_error "$(basename "$path"): faultingThread index does not exist in threads"; continue; }
    signal="$(printf '%s' "$body" | jq -r '.exception.signal // empty' 2>/dev/null || true)"
    termination="$(printf '%s' "$body" | jq -r '.termination.indicator // .termination // empty' 2>/dev/null || true)"
    frames="$(printf '%s' "$body" | jq -r '.usedImages as $images | .faultingThread as $i | .threads[$i].frames[] | if .imageIndex != null and $images[.imageIndex].name then ($images[.imageIndex].name + " + " + (.imageOffset // "unknown offset") + " (" + ($images[.imageIndex].path // "unknown path") + ")") else ("imageIndex " + ((.imageIndex // "unknown")|tostring) + " + " + ((.imageOffset // "unknown offset")|tostring)) end' 2>/dev/null || true)"
    printf '%s\n%s%s\n%s\n' "$path" "$exception" "${signal:+ ($signal)}" "$termination"
    printf '%s\n' "$frames" | sed 's/^/  /'
    count=$((count + 1)); [ "$count" -ge "$last" ] && break
  done <<EOF
$ordered_paths
EOF
  [ "$count" -gt 0 ] || printf 'no crash reports found for %s\n' "$target"
}

megabrain_native_app_health() {
  local kind='' bundle_id='' device='' metro_port='' control_frame='' json=false arg='' configured_value=''
  local process_state=unknown process_reason='could not inspect simulator processes' metro_state=unknown metro_reason='Metro attachment cannot be determined'
  local tree_count='' tree_reason='accessibility tree could not be consulted' frame_state=unknown frame_reason='no control frame configured'
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --bundle-id|--device|--metro-port|--control-frame)
        [ "$#" -ge 2 ] || { megabrain_usage_fail native-health; return "$MEGABRAIN_USAGE_ERROR"; }
        case "$arg" in --bundle-id) bundle_id="$2";; --device) device="$2";; --metro-port) metro_port="$2";; --control-frame) control_frame="$2";; esac
        shift 2 ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show native-health; return 0 ;;
      -*) megabrain_error "unknown native health option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
      *) [ -z "$kind" ] || { megabrain_usage_fail native-health; return "$MEGABRAIN_USAGE_ERROR"; }; kind="$arg"; shift ;;
    esac
  done
  [ -n "$kind" ] || { megabrain_usage_fail native-health; return "$MEGABRAIN_USAGE_ERROR"; }
  megabrain_native_validate_kind "$kind" || return $?
  megabrain_native_config_validate || return 1
  [ -n "$bundle_id" ] || { configured_value="$(megabrain_native_config_value "$kind" bundleId)"; bundle_id="$configured_value"; }
  [ -n "$device" ] || { configured_value="$(megabrain_native_config_value "$kind" device)"; device="$configured_value"; }
  [ -n "$metro_port" ] || { configured_value="$(megabrain_native_config_value "$kind" metroPort)"; metro_port="$configured_value"; }
  [ -n "$control_frame" ] || { configured_value="$(megabrain_native_config_value "$kind" controlFrame)"; control_frame="$configured_value"; }
  [ -n "$bundle_id" ] || { megabrain_error "bundle id is required for $kind; pass --bundle-id"; return 1; }
  megabrain_native_require_simctl || return 1
  megabrain_native_select_device "$kind" "$device" true || return 1
  local process_output='' process_rc=0 metro_output='' source_output='' session_id='' capture_path='' control_hash='' live_hash=''
  process_output="$(xcrun simctl spawn "$MEGABRAIN_NATIVE_SELECTED_UDID" launchctl list 2>/dev/null)" || process_rc=$?
  if [ "$process_rc" -ne 0 ]; then process_state=unknown; process_reason='could not inspect simulator processes'
  elif printf '%s\n' "$process_output" | grep -Fq "$bundle_id"; then process_state=running; process_reason=''
  else process_state=not-running; process_reason='process is not running'; fi
  if [ -n "$metro_port" ] && [ "$metro_port" != none ]; then
    if metro_output="$(curl -fsS --max-time 2 "http://127.0.0.1:$metro_port/json/list" 2>/dev/null)"; then
      if printf '%s' "$metro_output" | jq -e --arg id "$bundle_id" 'any(.[]?; tostring | contains($id))' >/dev/null 2>&1; then metro_state=attached; metro_reason=''; else metro_state=not-attached; metro_reason='Metro has no target for this app'; fi
    else metro_reason="Metro /json/list was unavailable on port $metro_port"; fi
  fi
  source_output="$(curl -fsS -X POST http://127.0.0.1:4723/session -H 'Content-Type: application/json' -d "{\"capabilities\":{\"alwaysMatch\":{\"platformName\":\"iOS\",\"appium:udid\":\"$MEGABRAIN_NATIVE_SELECTED_UDID\",\"appium:bundleId\":\"$bundle_id\"}}}" 2>/dev/null || true)"
  session_id="$(printf '%s' "$source_output" | jq -r '.sessionId // .value.sessionId // empty' 2>/dev/null || true)"
  if [ -n "$session_id" ]; then
    source_output="$(curl -fsS "http://127.0.0.1:4723/session/$session_id/source" 2>/dev/null || true)"
    tree_count="$(printf '%s' "$source_output" | grep -Eo '<XCUIElementType[A-Za-z0-9]+' | wc -l | tr -d ' ')"
    curl -fsS -X DELETE "http://127.0.0.1:4723/session/$session_id" >/dev/null 2>&1 || true
  fi
  if [ -n "$control_frame" ] && [ -f "$control_frame" ]; then
    capture_path="${TMPDIR:-/tmp}/megabrain-native-health-$$.png"
    if xcrun simctl io "$MEGABRAIN_NATIVE_SELECTED_UDID" screenshot "$capture_path" >/dev/null 2>&1 && control_hash="$(shasum -a 256 "$control_frame" | awk '{print $1}')" && live_hash="$(shasum -a 256 "$capture_path" | awk '{print $1}')"; then
      [ "$control_hash" = "$live_hash" ] && frame_state=identical || frame_state=differs
      frame_reason='screenshot hashes compared'
    fi
    rm -f "$capture_path"
  fi
  local status=unknown reason='accessibility tree is unavailable and Metro is not attached'
  if [ "$process_state" = not-running ]; then status=not-rendered; reason="$process_reason"
  elif [ "$process_state" = unknown ]; then reason="$process_reason"
  elif [ "$frame_state" = identical ]; then status=not-rendered; reason='screen matches the control frame'
  elif [ "$frame_state" = unknown ]; then reason="$frame_reason"
  elif [ -n "$tree_count" ] && [ "$tree_count" -le 1 ]; then status=loading; reason="accessibility tree exposes $tree_count element$([ "$tree_count" -eq 1 ] || printf s)"
  elif [ -n "$tree_count" ]; then status=rendered; reason="frame differs and accessibility tree exposes $tree_count elements"
  elif [ "$metro_state" = attached ]; then status=rendered; reason='frame differs and Metro is attached'; fi
  if [ "$json" = true ]; then jq -n --arg status "$status" --arg reason "$reason" --arg ps "$process_state" --arg ms "$metro_state" --arg ts "${tree_count:-}" --arg fs "$frame_state" '{status:$status,reason:$reason,process:{state:$ps},metro:{state:$ms},tree:{count:(if $ts == "" then null else ($ts|tonumber) end)},frame:{state:$fs}}'; else printf '%s: %s\nprocess=%s; metro=%s; tree=%s; frame=%s\n' "$status" "$reason" "$process_state" "$metro_state" "${tree_count:-unknown}" "$frame_state"; fi
}

megabrain_native_build() {
  local kind="$1" arg runtime="" app_path configured_app_path app_json scheme bundle_id platform runtime_json device_json udid ios_path workspace derived sdk app_bundle
  shift || true
  case "$kind" in phone) platform=iOS ;; tv) platform=tvOS ;; *) megabrain_error "expected simulator kind phone or tv, got: $kind"; return "$MEGABRAIN_USAGE_ERROR" ;; esac
  while [ "$#" -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      --runtime) [ "$#" -gt 0 ] || { megabrain_error 'native build --runtime requires a version'; return "$MEGABRAIN_USAGE_ERROR"; }; runtime="$1"; shift ;;
      --json) ;;
      -h|--help) megabrain_usage_show native-build; return 0 ;;
      *) megabrain_error "unknown native build option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  configured_app_path="$(megabrain_native_config_value "$kind" appPath)"
  [ -n "$configured_app_path" ] || { megabrain_error "app path is required for $kind; pass surfaces.$kind.appPath in .megabrain/native.json"; return 1; }
  if [[ "$configured_app_path" = /* ]]; then
    app_path="$configured_app_path"
  else
    app_path="$(megabrain_native_worktree_root)/$configured_app_path"
  fi
  app_path="$(cd "$app_path" 2>/dev/null && pwd -P)" || { megabrain_error "configured app path does not exist for $kind: $configured_app_path"; return 1; }
  app_json="$app_path/app.json"
  [ -f "$app_json" ] || { megabrain_error "Expo app.json is required at $app_json"; return 1; }
  scheme="$(jq -r '.expo.scheme // empty' "$app_json")"; bundle_id="$(jq -r '.expo.ios.bundleIdentifier // empty' "$app_json")"
  [ -n "$scheme" ] || { megabrain_error "scheme is required in $app_json"; return 1; }
  [ -n "$bundle_id" ] || { megabrain_error "ios.bundleIdentifier is required in $app_json"; return 1; }
  runtime_json="$(xcrun simctl list runtimes --json 2>/dev/null)" || { megabrain_error 'failed to list runtimes with simctl'; return 1; }
  runtime="$(printf '%s' "$runtime_json" | jq -r --arg p "$platform" --arg v "$runtime" '[.runtimes[] | select((.name | startswith($p)) and ($v == "" or .version == $v))] | sort_by(.version) | last.version // empty')"
  [ -n "$runtime" ] || { megabrain_error "no installed $platform runtime is available"; return 1; }
  device_json="$(xcrun simctl list devices --json 2>/dev/null)" || { megabrain_error 'failed to list simulators with simctl'; return 1; }
  udid="$(printf '%s' "$device_json" | jq -r --arg p "$platform" --arg v "${runtime//./-}" '[.devices | to_entries[] | select(.key | contains($p) and contains($v)) | .value[] | select(.isAvailable == true)] | if length == 1 then .[0].udid else empty end')"
  [ -n "$udid" ] || { megabrain_error "expected exactly one $platform simulator for runtime $runtime"; return 1; }
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  if [ "$kind" = tv ]; then
    (cd "$app_path" && EXPO_TV=1 REACT_NATIVE_NODE_MODULES_DIR="$app_path/node_modules" pnpm exec expo prebuild)
  else
    (cd "$app_path" && REACT_NATIVE_NODE_MODULES_DIR="$app_path/node_modules" pnpm exec expo prebuild)
  fi || { megabrain_error 'native build failed at prebuild'; return 1; }
  ios_path="$app_path/ios"; workspace="$(find "$ios_path" -maxdepth 1 -name '*.xcworkspace' -print -quit)"; [ -n "$workspace" ] || workspace="$(find "$ios_path" -maxdepth 1 -name '*.xcodeproj' -print -quit)"
  [ -n "$workspace" ] || { megabrain_error "prebuild did not produce an Xcode project in $ios_path"; return 1; }
  (cd "$ios_path" && pod install) || { megabrain_error 'native build failed at pods'; return 1; }
  derived="$ios_path/build"; sdk=$([ "$platform" = tvOS ] && printf appletvsimulator || printf iphonesimulator)
  xcodebuild -workspace "$workspace" -scheme "$scheme" -sdk "$sdk" -destination "platform=$platform Simulator,id=$udid" -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO build || { megabrain_error 'native build failed at build'; return 1; }
  app_bundle="$derived/Build/Products/Debug-$sdk/$scheme.app"
  xcrun simctl install "$udid" "$app_bundle" || { megabrain_error 'native build failed at install'; return 1; }
  xcrun simctl launch "$udid" "$bundle_id" || { megabrain_error 'native build failed at launch'; return 1; }
  printf 'built, installed, and launched %s on simulator %s\n' "$bundle_id" "$udid"
}

command_native() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  if megabrain_should_use_typescript_binary "${MEGABRAIN_NATIVE_IMPLEMENTATION:-}"; then
    "$typescript_binary" native "$@"
    return $?
  fi
  local family="${1:-}" operation="${2:-}" arg=''
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
    runtime)
      case "$operation" in
        list) megabrain_native_runtime_list "$@" ;;
        install) megabrain_native_runtime_install "$@" ;;
        -h|--help|"") megabrain_usage_show native-runtime-list native-runtime-install ;;
        *) megabrain_error "unknown native runtime operation: $operation"; return "$MEGABRAIN_USAGE_ERROR" ;;
      esac
      ;;
    app)
      case "$operation" in
        reload) megabrain_native_app_reload "$@" ;;
        -h|--help|"") megabrain_usage_show native-app-reload ;;
        *) megabrain_error "unknown native app operation: $operation"; return "$MEGABRAIN_USAGE_ERROR" ;;
      esac
      ;;
    build)
      megabrain_native_build "$operation" "$@"
      ;;
    crashes) megabrain_native_crashes "$operation" "$@" ;;
    health) megabrain_native_app_health "$operation" "$@" ;;
    -h|--help|"") megabrain_usage_show native-sim-list native-sim-ensure native-app-reload native-health native-crashes native-build native-appium ;;
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
