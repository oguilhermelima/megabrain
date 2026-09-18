#!/usr/bin/env bash

megabrain_module_doctor() {
  local module="$1"
  case "$module" in
    orchestration) module_orchestration_doctor ;;
    orchestration-hooks) module_orchestration_hooks_doctor ;;
    worktree) module_worktree_doctor ;;
    simulator-web) module_simulator_web_doctor ;;
    simulator-native) module_simulator_native_doctor ;;
    simulator-tv) module_simulator_tv_doctor ;;
    tv-adb) module_tv_adb_doctor ;;
    tmux-runtime) module_tmux_runtime_doctor ;;
    skill-sync) module_skill_sync_doctor ;;
    *) megabrain_set_status missing "unknown module"; return 1 ;;
  esac
}

megabrain_module_install() {
  local module="$1"
  case "$module" in
    orchestration) module_orchestration_install ;;
    orchestration-hooks) module_orchestration_hooks_install ;;
    worktree) module_worktree_install ;;
    simulator-web) module_simulator_web_install "${2:-false}" "${3:-both}" ;;
    simulator-native) module_simulator_native_install ;;
    simulator-tv) module_simulator_tv_install ;;
    tv-adb) module_tv_adb_install ;;
    tmux-runtime) module_tmux_runtime_install "${2:-false}" ;;
    skill-sync) module_skill_sync_install ;;
    *) megabrain_error "unknown module: $module"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}

megabrain_module_revert() {
  local module="$1"
  case "$module" in
    orchestration-hooks) module_orchestration_hooks_revert ;;
    *) megabrain_error "module cannot be reverted: $module"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}

megabrain_install_one() {
  local module="$1"
  local assume_yes="${2:-false}" browser="${3:-both}" install_rc doctor_rc
  MODULE_UNCERTAIN_REASONS='[]'
  MODULE_RETAINED_REASONS='[]'
  megabrain_module_install "$module" "$assume_yes" "$browser"
  install_rc=$?
  megabrain_module_doctor "$module"
  doctor_rc=$?
  if [ "$doctor_rc" -eq 0 ] && [ "$install_rc" -eq 0 ]; then
    megabrain_state_set "$module" true "$MODULE_DETAILS" || return 1
    megabrain_status_line "$module" "$MODULE_STATUS" "$MODULE_REASON"
    return 0
  fi
  if [ "$MODULE_STATUS" = unknown ] || [ -z "$MODULE_STATUS" ]; then
    megabrain_state_reconcile "$module" unknown "$MODULE_DETAILS" || return 1
    megabrain_status_line "$module" "$MODULE_STATUS" "$MODULE_REASON"
    return 1
  fi
  megabrain_state_set "$module" false "$MODULE_DETAILS" || return 1
  megabrain_status_line "$module" "$MODULE_STATUS" "$MODULE_REASON"
  return 1
}

megabrain_interactive_modules() {
  local index module selected
  local -a ids
  ids=()
  while IFS= read -r module; do
    ids+=("$module")
  done < <(megabrain_module_ids)
  printf 'Select modules to install (numbers separated by spaces, or all):\n'
  index=1
  if [ "${#ids[@]}" -gt 0 ]; then
    for module in "${ids[@]}"; do
      printf '  [%d] %s\n' "$index" "$module"
      index=$((index + 1))
    done
  fi
  read -r -p 'Modules: ' selected || return 1
  if [ "$selected" = all ]; then
    if [ "${#ids[@]}" -gt 0 ]; then
      printf '%s\n' "${ids[@]}"
    fi
    return 0
  fi
  for index in $selected; do
    case "$index" in
      '') megabrain_error "invalid module selection: $index"; return 1 ;;
      *)
        if [[ "$index" =~ ^[0-9]+$ ]] && [ "$index" -ge 1 ] && [ "$index" -le "${#ids[@]}" ]; then
          printf '%s\n' "${ids[$((index - 1))]}"
        else
          megabrain_error "invalid module selection: $index"
          return 1
        fi
        ;;
    esac
  done
}

command_install() {
  local module="" selected selected_modules rc=0 assume_yes=false revert=false browser=both arg
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --yes) assume_yes=true; shift ;;
      --revert) revert=true; shift ;;
      --browser)
        [ "$#" -gt 1 ] || { megabrain_usage_fail install; return "$MEGABRAIN_USAGE_ERROR"; }
        browser="$2"
        shift 2
        ;;
      -h|--help)
        megabrain_usage_show install
        return 0
        ;;
      *)
        if [ -n "$module" ]; then
          megabrain_error "install accepts at most one module id"
          return "$MEGABRAIN_USAGE_ERROR"
        fi
        module="$arg"
        shift
        ;;
    esac
  done
  if [ -n "$module" ]; then
    megabrain_validate_module "$module" || { megabrain_error "unknown module: $module"; return "$MEGABRAIN_USAGE_ERROR"; }
    if [ "$revert" = true ]; then
      megabrain_module_revert "$module"
      return $?
    fi
    megabrain_install_one "$module" "$assume_yes" "$browser"
    return $?
  fi
  if [ ! -t 0 ]; then
    megabrain_error "install without a module id requires an interactive terminal"
    return 1
  fi
  selected_modules="$(megabrain_interactive_modules)" || return 1
  while IFS= read -r selected; do
    megabrain_install_one "$selected" "$assume_yes" "$browser" || rc=1
  done <<EOF
$selected_modules
EOF
  return "$rc"
}

# WHY: the wrapper remains a useful installed entrypoint even before its compiled payload is built.
command_doctor() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || {
    megabrain_error "compiled binary is missing: $typescript_binary; run bun run build"
    return 1
  }
  # WHY: direct binary wrappers must retain the centralized freshness notice after the existence check.
  megabrain_warn_if_typescript_binary_stale
  "$typescript_binary" doctor "$@"
}

module_orchestration_doctor() {
  local orca_status=missing superset_status=missing tmux_status=missing
  local counts_suffix usable_runtimes="" missing_runtimes=""
  megabrain_dispatch_health_counts
  counts_suffix="; uncertain dispatches: $MODULE_UNCERTAIN_DISPATCHES (review with megabrain orchestrate list --uncertain; reconcile or archive eligible records with megabrain orchestrate prune --older-than 1); retained terminals: $MODULE_RETAINED_TERMINALS; leaked dispatch sessions: $MODULE_LEAKED_DISPATCH_SESSIONS; prunable dispatches: $MODULE_PRUNABLE_DISPATCHES"
  if [ "${MODULE_UNCERTAIN_DISPATCHES:-0}" -gt 0 ]; then
    counts_suffix="$counts_suffix; unresolved reasons: $(printf '%s' "${MODULE_UNCERTAIN_REASONS:-[]}" | jq -r '[.[].reason] | unique | join(", ")')"
  fi
  if [ "${MODULE_RETAINED_TERMINALS:-0}" -gt 0 ]; then
    counts_suffix="$counts_suffix; retained reasons: $(printf '%s' "${MODULE_RETAINED_REASONS:-[]}" | jq -r '[.[].reason] | unique | join(", ")')"
  fi
  if [ -n "${MODULE_UNRECOGNISED_MESSAGE_FILES:-}" ]; then
    counts_suffix="$counts_suffix; unrecognised message files: $MODULE_UNRECOGNISED_MESSAGE_FILES"
  fi
  if [ "${MODULE_UNCERTAIN_DISPATCHES:-0}" -gt 0 ] || [ "${MODULE_RETAINED_TERMINALS:-0}" -gt 0 ]; then
    megabrain_set_status misconfigured "dispatch state requires reconciliation$counts_suffix"
    return 1
  fi
  if megabrain_runtime_enabled; then
    if megabrain_tmux_available; then
      tmux_status=ok
    else
      tmux_status=misconfigured
    fi
  fi
  if ! megabrain_require_command orca; then
    orca_status=missing
  elif ! orca status --json >/dev/null 2>&1; then
    orca_status=misconfigured
  else
    orca_status=ok
  fi
  if ! megabrain_superset_available; then
    superset_status=missing
  elif ! megabrain_superset workspaces list --json >/dev/null 2>&1; then
    superset_status=misconfigured
  else
    superset_status=ok
  fi

  if [ "$orca_status" = ok ]; then
    usable_runtimes=orca
  elif [ "$orca_status" = missing ]; then
    missing_runtimes=orca
  fi
  if [ "$superset_status" = ok ]; then
    if [ -n "$usable_runtimes" ]; then usable_runtimes="$usable_runtimes, "; fi
    usable_runtimes="${usable_runtimes}superset"
  elif [ "$superset_status" = missing ]; then
    if [ -n "$missing_runtimes" ]; then missing_runtimes="$missing_runtimes, "; fi
    missing_runtimes="${missing_runtimes}superset"
  fi
  if [ "$tmux_status" = ok ]; then
    if [ -n "$usable_runtimes" ]; then usable_runtimes="$usable_runtimes, "; fi
    usable_runtimes="${usable_runtimes}tmux"
  elif [ "$tmux_status" = missing ]; then
    if [ -n "$missing_runtimes" ]; then missing_runtimes="$missing_runtimes, "; fi
    missing_runtimes="${missing_runtimes}tmux"
  fi

  if [ -n "$usable_runtimes" ]; then
    megabrain_set_status ok "usable runtimes: $usable_runtimes; other runtimes are optional$counts_suffix"
    return 0
  fi
  if [ "$orca_status" = misconfigured ]; then
    megabrain_set_status misconfigured "orca status --json failed$counts_suffix"
    return 1
  fi
  if [ "$superset_status" = misconfigured ]; then
    megabrain_set_status misconfigured "superset workspaces list --json failed$counts_suffix"
    return 1
  fi
  if [ "$tmux_status" = misconfigured ]; then
    megabrain_set_status misconfigured "tmux runtime is enabled but tmux is unavailable$counts_suffix"
    return 1
  fi
  megabrain_set_status missing "no orchestration runtime is available; missing runtimes: $missing_runtimes$counts_suffix"
  return 1
}

module_orchestration_install() {
  module_orchestration_doctor
}
