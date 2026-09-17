#!/usr/bin/env bash

MEGABRAIN_PLAYWRIGHT_NAME="playwright"
MEGABRAIN_PLAYWRIGHT_COMMAND="@playwright/mcp@latest"
MEGABRAIN_PLAYWRIGHT_VERSION="1.62.1"
MEGABRAIN_PLAYWRIGHT_ROOT="${MEGABRAIN_PLAYWRIGHT_ROOT:-$HOME/.megabrain/playwright}"
MEGABRAIN_PLAYWRIGHT_SCRIPT="${MEGABRAIN_ROOT:-.}/scripts/playwright-web.mjs"

megabrain_playwright_config_path() {
  local browser="${1:-chromium}"
  jq -r --arg browser "$browser" '.profiles[$browser].configPath // empty' \
    "$MEGABRAIN_PLAYWRIGHT_ROOT/manifest.json" 2>/dev/null
}

megabrain_playwright_active_browser() {
  jq -r '.activeBrowser // "chromium"' "$MEGABRAIN_PLAYWRIGHT_ROOT/manifest.json" 2>/dev/null || printf 'chromium\n'
}

megabrain_playwright_ready() {
  megabrain_require_command npx && npx -y "$MEGABRAIN_PLAYWRIGHT_COMMAND" --version >/dev/null 2>&1
}

megabrain_web_local_ready() {
  megabrain_require_command node && megabrain_require_command npm && [ -f "$MEGABRAIN_PLAYWRIGHT_SCRIPT" ]
}

megabrain_agent_mcp_registered() {
  local agent="$1" config_path="${2:-$(megabrain_playwright_config_path)}"
  [ -n "$config_path" ] || return 1
  case "$agent" in
    claude)
      claude mcp list 2>/dev/null | grep -F "$MEGABRAIN_PLAYWRIGHT_NAME" | grep -F "$MEGABRAIN_PLAYWRIGHT_COMMAND" | grep -F -- "--config $config_path" >/dev/null
      ;;
    codex)
      codex mcp list --json 2>/dev/null | jq -e --arg name "$MEGABRAIN_PLAYWRIGHT_NAME" \
        --arg command "$MEGABRAIN_PLAYWRIGHT_COMMAND" --arg config "$config_path" \
        'any(.[]?; .name == $name and ((.transport.command // "") == "npx") and (((.transport.args // []) | join(" ")) | contains($command) and contains("--config") and contains($config)))' >/dev/null 2>&1
      ;;
    agy)
      agy mcp list 2>/dev/null | grep -F "$MEGABRAIN_PLAYWRIGHT_NAME" | grep -F "$MEGABRAIN_PLAYWRIGHT_COMMAND" | grep -F -- "--config $config_path" >/dev/null
      ;;
    *) return 1 ;;
  esac
}

megabrain_remove_playwright() {
  local agent="$1"
  case "$agent" in
    claude) claude mcp remove "$MEGABRAIN_PLAYWRIGHT_NAME" >/dev/null 2>&1 || true ;;
    codex) codex mcp remove "$MEGABRAIN_PLAYWRIGHT_NAME" >/dev/null 2>&1 || true ;;
    agy) agy mcp remove "$MEGABRAIN_PLAYWRIGHT_NAME" >/dev/null 2>&1 || true ;;
    *) return 1 ;;
  esac
}

megabrain_present_agents() {
  local agent
  for agent in claude codex agy; do
    megabrain_require_command "$agent" && printf '%s\n' "$agent"
  done
}

megabrain_print_attributed_output() {
  local agent="$1" output="$2" line
  [ -n "$output" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s: %s\n' "$agent" "$line"
  done <<< "$output"
}

module_simulator_web_doctor() {
  local agent missing=0 config_path active_browser web_report web_status web_reason
  if ! megabrain_require_command npx; then
    megabrain_set_status missing "npx is not on PATH"
    return 1
  fi
  if ! megabrain_require_command node || ! megabrain_require_command npm; then
    megabrain_set_status missing "node and npm are required for pinned Playwright $MEGABRAIN_PLAYWRIGHT_VERSION"
    return 1
  fi
  if ! megabrain_playwright_ready; then
    megabrain_set_status missing "@playwright/mcp could not be executed by npx"
    return 1
  fi
  if [ ! -f "$MEGABRAIN_PLAYWRIGHT_ROOT/manifest.json" ]; then
    megabrain_set_status missing "browser profiles are not installed; run megabrain install simulator-web"
    return 1
  fi
  web_report="$(node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" doctor --root "$MEGABRAIN_PLAYWRIGHT_ROOT" 2>/dev/null)" || {
    megabrain_set_status misconfigured "browser profile doctor could not read its manifest"
    return 1
  }
  web_status="$(printf '%s' "$web_report" | jq -r '.status // "unknown"')"
  web_reason="$(printf '%s' "$web_report" | jq -r '.reason // "browser profile status is unknown"')"
  if [ "$web_status" != ok ]; then
    megabrain_set_status "$web_status" "$web_reason"
    return 1
  fi
  active_browser="$(megabrain_playwright_active_browser)"
  config_path="$(megabrain_playwright_config_path "$active_browser")"
  [ -n "$config_path" ] || {
    megabrain_set_status misconfigured "active browser $active_browser has no MCP config"
    return 1
  }
  for agent in $(megabrain_present_agents); do
    if ! megabrain_agent_mcp_registered "$agent" "$config_path"; then
      megabrain_set_status misconfigured "playwright MCP is not registered with $agent using $config_path"
      missing=1
    fi
  done
  if [ "$missing" -ne 0 ]; then
    return 1
  fi
  megabrain_set_status ok "Playwright MCP is current, using $config_path, with pinned browser profiles"
  return 0
}

megabrain_register_playwright() {
  local agent="$1" config_path="$2" output rc=0
  if megabrain_agent_mcp_registered "$agent" "$config_path"; then
    megabrain_info "$agent: playwright MCP already registered with $config_path"
    return 0
  fi
  megabrain_remove_playwright "$agent"
  case "$agent" in
    claude)
      output="$(claude mcp add --scope user "$MEGABRAIN_PLAYWRIGHT_NAME" -- npx -y "$MEGABRAIN_PLAYWRIGHT_COMMAND" --config "$config_path" 2>&1)" || rc=$?
      ;;
    codex)
      output="$(codex mcp add "$MEGABRAIN_PLAYWRIGHT_NAME" -- npx -y "$MEGABRAIN_PLAYWRIGHT_COMMAND" --config "$config_path" 2>&1)" || rc=$?
      ;;
    agy)
      output="$(agy mcp add "$MEGABRAIN_PLAYWRIGHT_NAME" -- npx -y "$MEGABRAIN_PLAYWRIGHT_COMMAND" --config "$config_path" 2>&1)" || rc=$?
      ;;
    *) return 1 ;;
  esac
  if [ "$rc" -ne 0 ]; then
    megabrain_error "$agent: playwright MCP registration failed"
    megabrain_print_attributed_output "$agent" "$output" >&2
    return "$rc"
  fi
  megabrain_print_attributed_output "$agent" "$output"
  return 0
}

module_simulator_web_install() {
  local browser="${2:-both}" active_browser inactive_browser config_path agent rc=0 doctor_rc
  local registered_agents="" failed_agents=""
  if ! megabrain_web_local_ready; then
    megabrain_error "node, npm, and the browser setup script are required for simulator-web"
    megabrain_set_status missing "node and npm are required for pinned Playwright $MEGABRAIN_PLAYWRIGHT_VERSION"
    return 1
  fi
  if ! megabrain_playwright_ready; then
    megabrain_error "@playwright/mcp could not be executed by npx"
    megabrain_set_status missing "@playwright/mcp could not be executed by npx"
    return 1
  fi
  case "$browser" in chromium|firefox|both) ;; *)
    megabrain_error "browser must be chromium, firefox, or both"
    return "$MEGABRAIN_USAGE_ERROR"
    ;;
  esac
  node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" install --root "$MEGABRAIN_PLAYWRIGHT_ROOT" --browser "$browser" || {
    megabrain_set_status missing "browser setup failed; run doctor for prerequisites"
    return 1
  }
  active_browser="$(megabrain_playwright_active_browser)"
  config_path="$(megabrain_playwright_config_path "$active_browser")"
  [ -n "$config_path" ] || {
    megabrain_set_status misconfigured "browser setup did not write the active MCP config"
    return 1
  }
  if [ "$browser" = both ]; then
    case "$active_browser" in
      chromium) inactive_browser=firefox ;;
      firefox) inactive_browser=chromium ;;
      *) inactive_browser=the-other-browser ;;
    esac
    megabrain_info "browser profiles installed: $active_browser is active for MCP; $inactive_browser is available for $inactive_browser-only runs"
  else
    megabrain_info "browser profile installed: $active_browser is active for MCP"
  fi
  for agent in $(megabrain_present_agents); do
    if megabrain_register_playwright "$agent" "$config_path"; then
      registered_agents="${registered_agents:+$registered_agents }$agent"
    else
      failed_agents="${failed_agents:+$failed_agents }$agent"
      rc=1
    fi
  done
  megabrain_info "Playwright MCP registration summary: registered ${registered_agents:-none}; failed ${failed_agents:-none}"
  module_simulator_web_doctor
  doctor_rc=$?
  [ "$rc" -eq 0 ] && [ "$doctor_rc" -eq 0 ]
}

command_web_userscript() {
  local action="${1:-}" name="" userscripts="$HOME/.megabrain/userscripts" flag_value=""
  local viewport_args=()
  shift || true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --userscripts) userscripts="${2:-}"; shift 2 ;;
      --viewport|--device|--category|--orientation|--width|--height)
        flag_value="${2:-}"
        [ -n "$flag_value" ] || { megabrain_usage_fail "web-userscript-${action}"; return "$MEGABRAIN_USAGE_ERROR"; }
        viewport_args+=("$1" "$flag_value")
        shift 2
        ;;
      -h|--help) megabrain_usage_show "web-userscript-${action:-install}"; return 0 ;;
      *) [ -z "$name" ] || { megabrain_usage_fail "web-userscript-${action}"; return "$MEGABRAIN_USAGE_ERROR"; }; name="$1"; shift ;;
    esac
  done
  case "$action" in
    install) [ -n "$name" ] || { megabrain_usage_fail web-userscript-install; return "$MEGABRAIN_USAGE_ERROR"; } ;;
    list) [ -z "$name" ] || { megabrain_usage_fail web-userscript-list; return "$MEGABRAIN_USAGE_ERROR"; } ;;
    remove) [ -n "$name" ] || { megabrain_usage_fail web-userscript-remove; return "$MEGABRAIN_USAGE_ERROR"; } ;;
    *) megabrain_usage_show web-userscript; return 0 ;;
  esac
  case "$action" in
    install)
      if [ "${#viewport_args[@]}" -gt 0 ]; then
        node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" userscript-install --root "$MEGABRAIN_PLAYWRIGHT_ROOT" --userscripts "$userscripts" --file "$name" "${viewport_args[@]}"
      else
        node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" userscript-install --root "$MEGABRAIN_PLAYWRIGHT_ROOT" --userscripts "$userscripts" --file "$name"
      fi
      ;;
    list) node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" userscript-list --root "$MEGABRAIN_PLAYWRIGHT_ROOT" ;;
    remove)
      if [ "${#viewport_args[@]}" -gt 0 ]; then
        node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" userscript-remove --root "$MEGABRAIN_PLAYWRIGHT_ROOT" --file "$name" "${viewport_args[@]}"
      else
        node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" userscript-remove --root "$MEGABRAIN_PLAYWRIGHT_ROOT" --file "$name"
      fi
      ;;
  esac
}

command_web_viewport() {
  local action="${1:-}" browser="both" filter="" flag_value=""
  local viewport_args=()
  shift || true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --browser) browser="${2:-}"; shift 2 ;;
      --filter)
        [ "$action" = devices ] || { megabrain_usage_fail "web-viewport-${action:-set}"; return "$MEGABRAIN_USAGE_ERROR"; }
        filter="${2:-}"; [ -n "$filter" ] || { megabrain_usage_fail web-devices; return "$MEGABRAIN_USAGE_ERROR"; }; shift 2
        ;;
      --viewport|--device|--category|--orientation|--width|--height)
        flag_value="${2:-}"
        [ -n "$flag_value" ] || { megabrain_usage_fail "web-viewport-${action:-set}"; return "$MEGABRAIN_USAGE_ERROR"; }
        viewport_args+=("$1" "$flag_value")
        shift 2
        ;;
      -h|--help)
        megabrain_usage_show "web-viewport-${action:-set}"
        printf '%s\n' 'Categories: mobile, tablet, desktop, ultrawide (with named size variants). Devices come from Playwright.'
        return 0
        ;;
      *) megabrain_usage_fail "web-viewport-${action:-set}"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  case "$action" in
    set)
      if [ "${#viewport_args[@]}" -gt 0 ]; then
        node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" viewport-set --root "$MEGABRAIN_PLAYWRIGHT_ROOT" --browser "$browser" "${viewport_args[@]}"
      else
        node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" viewport-set --root "$MEGABRAIN_PLAYWRIGHT_ROOT" --browser "$browser"
      fi
      ;;
    devices)
      if [ "${#viewport_args[@]}" -gt 0 ]; then
        node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" device-list --root "$MEGABRAIN_PLAYWRIGHT_ROOT" --filter "$filter" "${viewport_args[@]}"
      else
        node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" device-list --root "$MEGABRAIN_PLAYWRIGHT_ROOT" --filter "$filter"
      fi
      ;;
    show) [ "${#viewport_args[@]}" -eq 0 ] || { megabrain_usage_fail web-viewport-show; return "$MEGABRAIN_USAGE_ERROR"; }
      node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" viewport-show --root "$MEGABRAIN_PLAYWRIGHT_ROOT" --browser "$browser" ;;
    *) megabrain_usage_show web-viewport; return 0 ;;
  esac
}

command_web_devices() {
  local action="list" filter="" flag_value=""
  local device_args=()
  case "${1:-}" in
    add|remove|list) action="$1"; shift || true ;;
  esac
  if [ "$action" = add ] || [ "$action" = remove ]; then
    node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" "device-$action" --root "$MEGABRAIN_PLAYWRIGHT_ROOT" "$@"
    return
  fi
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --filter|--orientation|--devices-file)
        flag_value="${2:-}"
        [ -n "$flag_value" ] || { megabrain_usage_fail web-devices; return "$MEGABRAIN_USAGE_ERROR"; }
        device_args+=("$1" "$flag_value")
        shift 2
        ;;
      -h|--help) megabrain_usage_show web-devices; return 0 ;;
      *) [ -z "$filter" ] || { megabrain_usage_fail web-devices; return "$MEGABRAIN_USAGE_ERROR"; }; filter="$1"; shift ;;
    esac
  done
  if [ "${#device_args[@]}" -gt 0 ]; then
    node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" device-list --root "$MEGABRAIN_PLAYWRIGHT_ROOT" --filter "$filter" "${device_args[@]}"
  else
    node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" device-list --root "$MEGABRAIN_PLAYWRIGHT_ROOT" --filter "$filter"
  fi
}

command_web_visual() {
  local action="$1"
  shift
  case "${1:-}" in
    -h|--help) megabrain_usage_show "web-$action"; return 0 ;;
  esac
  node "$MEGABRAIN_PLAYWRIGHT_SCRIPT" "$action" --root "$MEGABRAIN_PLAYWRIGHT_ROOT" "$@"
}

command_web() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  if megabrain_should_use_typescript_binary "${MEGABRAIN_WEB_IMPLEMENTATION:-}"; then
    "$typescript_binary" web "$@"
    return $?
  fi
  case "${1:-}" in
    userscript) shift; command_web_userscript "$@" ;;
    viewport) shift; command_web_viewport "$@" ;;
    devices) shift; command_web_devices "$@" ;;
    capture|measure|session-save) action="$1"; shift; command_web_visual "$action" "$@" ;;
    session)
      shift
      case "${1:-}" in
        -h|--help) megabrain_usage_show web-session; return 0 ;;
      esac
      [ "${1:-}" = save ] || { megabrain_usage_fail web-session; return "$MEGABRAIN_USAGE_ERROR"; }
      shift
      command_web_visual session-save "$@"
      ;;
    --device|--category|--viewport|--width|--height)
      command_web_viewport set "$@"
      ;;
    -h|--help|"")
      megabrain_usage_show web web-viewport web-devices web-userscript web-capture web-measure web-session
      printf '%s\n' 'Use web capture, web measure, and web session save for visual parity workflows.'
      printf '%s\n' 'Use --device SLUG for a persisted device viewport; categories set viewport size only.'
      ;;
    *) megabrain_error "unknown web command: $1"; megabrain_usage_show web web-viewport web-devices web-userscript; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}
