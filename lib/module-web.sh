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

# WHY: web install/doctor helpers above still belong to the unported simulator-web module; only
# the user-facing web verb is owned by the compiled CLI now.
command_web() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  "$typescript_binary" web "$@"
}
