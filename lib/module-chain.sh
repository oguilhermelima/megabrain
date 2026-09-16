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

megabrain_chain_temp_swap_cleanup() {
  local temp="$1" directory basename
  directory="$(dirname "$temp")"
  basename="$(basename "$temp")"
  rm -f "$directory/.$basename.swp"
}

megabrain_chain_temp_cleanup() {
  if [ -n "$MEGABRAIN_CHAIN_TEMP_FILE" ]; then
    megabrain_chain_temp_swap_cleanup "$MEGABRAIN_CHAIN_TEMP_FILE"
    rm -f "$MEGABRAIN_CHAIN_TEMP_FILE"
    MEGABRAIN_CHAIN_TEMP_FILE=""
  fi
}

megabrain_chain_temp_interrupt() {
  local signal="$1"
  megabrain_chain_temp_cleanup
  trap - "$signal"
  case "$signal" in
    HUP) exit 129 ;;
    INT) exit 130 ;;
    TERM) exit 143 ;;
  esac
}

megabrain_chain_temp_begin() {
  MEGABRAIN_CHAIN_TEMP_FILE="$1"
  MEGABRAIN_CHAIN_TEMP_HUP_TRAP="$(trap -p HUP)"
  MEGABRAIN_CHAIN_TEMP_INT_TRAP="$(trap -p INT)"
  MEGABRAIN_CHAIN_TEMP_TERM_TRAP="$(trap -p TERM)"
  trap 'megabrain_chain_temp_interrupt HUP' HUP
  trap 'megabrain_chain_temp_interrupt INT' INT
  trap 'megabrain_chain_temp_interrupt TERM' TERM
}

megabrain_chain_temp_end() {
  megabrain_chain_temp_cleanup
  if [ -n "$MEGABRAIN_CHAIN_TEMP_HUP_TRAP" ]; then
    eval "$MEGABRAIN_CHAIN_TEMP_HUP_TRAP"
  else
    trap - HUP
  fi
  if [ -n "$MEGABRAIN_CHAIN_TEMP_INT_TRAP" ]; then
    eval "$MEGABRAIN_CHAIN_TEMP_INT_TRAP"
  else
    trap - INT
  fi
  if [ -n "$MEGABRAIN_CHAIN_TEMP_TERM_TRAP" ]; then
    eval "$MEGABRAIN_CHAIN_TEMP_TERM_TRAP"
  else
    trap - TERM
  fi
  MEGABRAIN_CHAIN_TEMP_HUP_TRAP=""
  MEGABRAIN_CHAIN_TEMP_INT_TRAP=""
  MEGABRAIN_CHAIN_TEMP_TERM_TRAP=""
}

megabrain_chain_seed() {
  jq -n '{
    chains: {},
    defaultSteps: [],
    usageLimits: {
      liveProviders: [],
      cacheTtlSeconds: 30,
      timeoutSeconds: 5,
      notice: {enabled: false, intervalSeconds: 3600}
    }
  }'
}

megabrain_chain_reconcile_seed() {
  local config="$1" seed="$2" temp reconciled
  reconciled="$(printf '%s' "$config" | jq --argjson seedUsage "$(printf '%s' "$seed" | jq '.usageLimits')" '
    if has("usageLimits") and (.usageLimits != null) and ((.usageLimits | type) != "object") then
      .
    else
      (.usageLimits // {}) as $current
      | ($seedUsage * $current) as $merged
      | ($seedUsage.notice * (if (($current.notice // {}) | type) == "object" then ($current.notice // {}) else {} end)) as $notice
      | .usageLimits = ($merged + {notice: $notice})
    end
  ')" || return 1
  temp="$(mktemp "$MEGABRAIN_STATE_DIR/chains.XXXXXX")" || return 1
  if ! printf '%s\n' "$reconciled" >"$temp"; then
    rm -f "$temp"
    return 1
  fi
  if cmp -s "$temp" "$MEGABRAIN_CHAIN_FILE"; then
    rm -f "$temp"
  else
    mv -f "$temp" "$MEGABRAIN_CHAIN_FILE"
  fi
}

megabrain_chain_init() {
  local tmp seed config
  mkdir -p "$MEGABRAIN_STATE_DIR" || return 1
  megabrain_model_init || return 1
  if [ ! -f "$MEGABRAIN_CHAIN_FILE" ]; then
    tmp="$(mktemp "$MEGABRAIN_STATE_DIR/chains.XXXXXX")" || return 1
    seed="$(megabrain_chain_seed)" || return 1
    megabrain_chain_validate_config "$seed" true || return 1
    if ! printf '%s\n' "$seed" >"$tmp"; then
      rm -f "$tmp"
      return 1
    fi
    mv -f "$tmp" "$MEGABRAIN_CHAIN_FILE"
  elif ! jq empty "$MEGABRAIN_CHAIN_FILE" >/dev/null 2>&1; then
    megabrain_error "chain file is not valid JSON: $MEGABRAIN_CHAIN_FILE"
    return 1
  else
    seed="$(megabrain_chain_seed)" || return 1
    config="$(cat "$MEGABRAIN_CHAIN_FILE")" || return 1
    megabrain_chain_reconcile_seed "$config" "$seed" || return 1
  fi
}

megabrain_chain_read() {
  megabrain_chain_init || return 1
  cat "$MEGABRAIN_CHAIN_FILE"
}

megabrain_chain_agent_known() {
  case "$1" in
    codex|claude|agy) return 0 ;;
    *) return 1 ;;
  esac
}

megabrain_chain_window_known() {
  case "$1" in
    5h|weekly) return 0 ;;
    *) return 1 ;;
  esac
}

megabrain_chain_name_valid() {
  case "$1" in
    ""|*[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
  esac
}


megabrain_chain_validate_config() {
  local config="$1" strict="${2:-false}" registry validation_output validation_filter rc=0
  validation_filter="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/chain-validation.jq"
  if [ -f "${MEGABRAIN_MODEL_FILE:-}" ]; then
    registry="$(cat "$MEGABRAIN_MODEL_FILE")" || return 1
  else
    registry="$(megabrain_model_read)" || return 1
  fi
  validation_output="$(printf '%s' "$config" | jq -r \
    --argjson registry "$registry" \
    --argjson strict "$strict" \
    -f "$validation_filter")" || {
    megabrain_error 'invalid chain config: expected chains object and defaultSteps array'
    return 1
  }
  while IFS=$'\t' read -r validation_code chain index field value; do
    [ -n "$validation_code" ] || continue
    case "$validation_code" in
      config_shape) megabrain_error 'invalid chain config: expected chains object and defaultSteps array'; rc=1 ;;
      usage_object) megabrain_error 'invalid usageLimits: expected an object'; rc=1 ;;
      usage_live_providers_array) megabrain_error 'invalid usageLimits.liveProviders: expected an array'; rc=1 ;;
      usage_provider) megabrain_error "invalid usageLimits.liveProviders provider: $value"; rc=1 ;;
      usage_integer) megabrain_error "invalid usageLimits.$field: expected an integer from 1 to 3600"; rc=1 ;;
      usage_notice) megabrain_error 'invalid usageLimits.notice: expected enabled and intervalSeconds'; rc=1 ;;
      chain_name) megabrain_error "invalid chain name: $value"; rc=1 ;;
      selector_object) megabrain_error "invalid chain $chain selector: expected a non-empty object"; rc=1 ;;
      selector_field) megabrain_error "invalid chain $chain selector: unsupported field $field"; rc=1 ;;
      selector_empty) megabrain_error "invalid chain $chain selector field $field: value cannot be empty"; rc=1 ;;
      selector_agent) megabrain_error "invalid chain $chain selector field parentAgent: unknown agent $value"; rc=1 ;;
      steps_empty) megabrain_error "invalid chain $chain: steps cannot be empty"; rc=1 ;;
      step_object) megabrain_error "invalid chain $chain step $index: expected an object"; rc=1 ;;
      step_field) megabrain_error "invalid chain $chain step $index: unsupported field $field"; rc=1 ;;
      agent_required) megabrain_error "invalid chain $chain step $index: agent is required"; rc=1 ;;
      agent_unknown) megabrain_error "invalid chain $chain step $index: unknown agent $value"; rc=1 ;;
      model_required) megabrain_error "invalid chain $chain step $index: model is required"; rc=1 ;;
      unknown_model)
        megabrain_error "unknown model '$value' for agent '$field'. Valid model ids:"
        ;;
      unknown_model_id) megabrain_error "  $value" ;;
      invalid_unknown_model)
        megabrain_error "invalid chain $chain step $index: model '$value' is not registered for agent '$field'"
        rc=1
        ;;
      migration_required)
        megabrain_error "chain migration required: chain $chain step $index uses unknown model '$value' for agent '$field'; run megabrain chain repair $chain --step $index --model <valid-id> --effort <level>"
        ;;
      lifecycle)
        if [ "$value" != - ]; then
          megabrain_error "Warning: model '$index' for agent '$chain' is $field (retirement date: $value)."
        else
          megabrain_error "Warning: model '$index' for agent '$chain' is $field."
        fi
        ;;
      embedded_header)
        megabrain_error "model '$value' for agent '$field' has effort as part of the model id; do not supply effort"
        megabrain_error 'Model ids by embedded reasoning level:'
        rc=1
        ;;
      embedded_level) megabrain_error "$value:" ;;
      embedded_id) megabrain_error "  $value" ;;
      missing_effort)
        megabrain_error "model '$value' for agent '$field' requires a separate reasoning level"
        rc=1
        ;;
      bad_effort_header)
        megabrain_error "model '$index' for agent '$chain' does not support reasoning level '$field'. Supported reasoning levels:"
        rc=1
        ;;
      bad_effort_level) megabrain_error "  $value" ;;
      bad_effort_none) megabrain_error '  none' ;;
      until_object)
        megabrain_error "invalid chain $chain step $index until: expected usedPercent and window"
        rc=1
        ;;
      until_used_percent)
        megabrain_error "invalid chain $chain step $index until.usedPercent: expected a number from 0 to 100"
        rc=1
        ;;
      until_window)
        megabrain_error "invalid chain $chain step $index until.window: unsupported window $value"
        rc=1
        ;;
      until_on_unknown)
        megabrain_error "invalid chain $chain step $index until.onUnknown: expected take or skip"
        rc=1
        ;;
    esac
  done <<<"$validation_output"
  return "$rc"
}

megabrain_chain_write() {
  local config="$1" tmp
  tmp="$(mktemp "$MEGABRAIN_STATE_DIR/chains.XXXXXX")" || return 1
  if ! printf '%s' "$config" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$MEGABRAIN_CHAIN_FILE"
}

megabrain_chain_format_list() {
  local config="$1" json="$2"
  if [ "$json" = true ]; then
    printf '%s' "$config" | jq -c '{chains: ([.chains | to_entries[] | .value + {name: .key}]), defaultSteps: .defaultSteps}'
  else
    printf '%-20s %-36s %s\n' NAME SELECTOR STEPS
    printf '%s' "$config" | jq -r '.chains | to_entries[] | [.key, (.value.when | tojson), (.value.steps | length)] | @tsv' |
      while IFS=$'\t' read -r chain selector count; do
        printf '%-20s %-36s %s\n' "$chain" "$selector" "$count"
      done
  fi
}

command_chain_list() {
  local json=false arg config
  for arg in "$@"; do
    case "$arg" in
      --json) json=true ;;
      -h|--help) megabrain_usage_show chain-list; return 0 ;;
      *) megabrain_error "unknown chain list option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  config="$(megabrain_chain_read)" || return 1
  megabrain_chain_validate_config "$config" true || return 1
  megabrain_chain_format_list "$config" "$json"
}

command_chain_add() {
  local name="" when_json='{}' steps_json='[]' json=false allow_unknown=false arg value chain config result registry
  case "${1:-}" in
    -h|--help) megabrain_usage_show chain-add; return 0 ;;
  esac
  [ "$#" -gt 0 ] || { megabrain_usage_fail chain-add; return "$MEGABRAIN_USAGE_ERROR"; }
  name="$1"
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --when) value="${2:-}"; [ -n "$value" ] || { megabrain_error '--when requires a value'; return "$MEGABRAIN_USAGE_ERROR"; }; when_json="$value"; shift 2 ;;
      --steps) value="${2:-}"; [ -n "$value" ] || { megabrain_error '--steps requires a value'; return "$MEGABRAIN_USAGE_ERROR"; }; steps_json="$value"; shift 2 ;;
      --step) value="${2:-}"; [ -n "$value" ] || { megabrain_error '--step requires a value'; return "$MEGABRAIN_USAGE_ERROR"; }; steps_json="$(printf '%s' "$steps_json" | jq --argjson step "$value" '. + [$step]' 2>/dev/null)" || { megabrain_error 'invalid --step JSON'; return 1; }; shift 2 ;;
      --parent-agent|--parent-model|--parent-effort)
        value="${2:-}"; [ -n "$value" ] || { megabrain_error "$arg requires a value"; return "$MEGABRAIN_USAGE_ERROR"; }
        case "$arg" in
          --parent-agent) when_json="$(printf '%s' "$when_json" | jq --arg value "$value" '. + {parentAgent: $value}')" ;;
          --parent-model) when_json="$(printf '%s' "$when_json" | jq --arg value "$value" '. + {parentModel: $value}')" ;;
          --parent-effort) when_json="$(printf '%s' "$when_json" | jq --arg value "$value" '. + {parentEffort: $value}')" ;;
        esac
        shift 2
        ;;
      --allow-unknown-model) allow_unknown=true; shift ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show chain-add; return 0 ;;
      *) megabrain_error "unknown chain add option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  megabrain_chain_name_valid "$name" || { megabrain_error "invalid chain name: $name"; return 1; }
  config="$(megabrain_chain_read)" || return 1
  if printf '%s' "$config" | jq -e --arg name "$name" '.chains | has($name)' >/dev/null 2>&1; then
    megabrain_error "chain already exists: $name"
    return 1
  fi
  if ! result="$(jq -n --argjson when "$when_json" --argjson steps "$steps_json" '{when: $when, steps: $steps}' 2>/dev/null)"; then
    megabrain_error "chain $name has invalid JSON definition"
    return 1
  fi
  if [ "$allow_unknown" = true ]; then
    registry="$(megabrain_model_read)" || return 1
    result="$(printf '%s' "$result" | jq --argjson models "$(printf '%s' "$registry" | jq '.models')" ' .steps |= map(. as $step | if any($models[]; .agent == $step.agent and .model == $step.model) then . else . + {unvalidated: true} end)')"
  fi
  config="$(printf '%s' "$config" | jq --arg name "$name" --argjson chain "$result" '.chains[$name] = $chain')"
  megabrain_chain_validate_config "$config" true || return 1
  megabrain_chain_write "$config" || return 1
  if [ "$json" = true ]; then
    printf '%s\n' "$result" | jq -c --arg name "$name" '. + {name: $name}'
  else
    printf 'chain added: %s\n' "$name"
  fi
}

command_chain_edit() {
  local name="" json=false allow_unknown=false arg config tmp edited editor registry
  case "${1:-}" in
    -h|--help) megabrain_usage_show chain-edit; return 0 ;;
  esac
  [ "$#" -gt 0 ] || { megabrain_usage_fail chain-edit; return "$MEGABRAIN_USAGE_ERROR"; }
  name="$1"
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --json) json=true; shift ;;
      --allow-unknown-model) allow_unknown=true; shift ;;
      -h|--help) megabrain_usage_show chain-edit; return 0 ;;
      *) megabrain_error "unknown chain edit option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  config="$(megabrain_chain_read)" || return 1
  if ! printf '%s' "$config" | jq -e --arg name "$name" '.chains | has($name)' >/dev/null 2>&1; then
    megabrain_error "chain not found: $name"
    return 1
  fi
  tmp="$(mktemp "$MEGABRAIN_STATE_DIR/chains-edit.XXXXXX")" || return 1
  megabrain_chain_temp_begin "$tmp"
  if ! cp "$MEGABRAIN_CHAIN_FILE" "$tmp"; then
    megabrain_chain_temp_end
    return 1
  fi
  editor="${EDITOR:-vi}"
  if ! "$editor" "$tmp"; then
    megabrain_chain_temp_end
    megabrain_error "editor failed while editing chain $name"
    return 1
  fi
  if cmp -s "$MEGABRAIN_CHAIN_FILE" "$tmp"; then
    megabrain_chain_temp_end
    if [ "$json" = true ]; then
      jq -n --arg name "$name" '{changed: false, name: $name}'
    else
      printf 'chain unchanged: %s\n' "$name"
    fi
    return 0
  fi
  edited="$(cat "$tmp")"
  megabrain_chain_temp_end
  if [ "$allow_unknown" = true ]; then
    registry="$(megabrain_model_read)" || return 1
    edited="$(printf '%s' "$edited" | jq --arg name "$name" --argjson models "$(printf '%s' "$registry" | jq '.models')" ' .chains[$name].steps |= map(. as $step | if any($models[]; .agent == $step.agent and .model == $step.model) then . else . + {unvalidated: true} end)')"
  fi
  megabrain_chain_validate_config "$edited" true || return 1
  if ! printf '%s' "$edited" | jq -e --arg name "$name" '.chains | has($name)' >/dev/null 2>&1; then
    megabrain_error "edited chain not found: $name"
    return 1
  fi
  megabrain_chain_write "$edited" || return 1
  if [ "$json" = true ]; then
    printf '%s' "$edited" | jq -c --arg name "$name" '.chains[$name] + {name: $name, changed: true}'
  else
    printf 'chain edited: %s\n' "$name"
  fi
}

command_chain_delete() {
  local name="" json=false arg config names result
  case "${1:-}" in
    -h|--help) megabrain_usage_show chain-delete; return 0 ;;
  esac
  [ "$#" -gt 0 ] || { megabrain_usage_fail chain-delete; return "$MEGABRAIN_USAGE_ERROR"; }
  name="$1"
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show chain-delete; return 0 ;;
      *) megabrain_error "unknown chain delete option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  config="$(megabrain_chain_read)" || return 1
  if ! printf '%s' "$config" | jq -e --arg name "$name" '.chains | has($name)' >/dev/null 2>&1; then
    names="$(printf '%s' "$config" | jq -r '.chains | keys | join(", ")')"
    megabrain_error "chain not found: $name; available chains: $names"
    return 1
  fi
  result="$(printf '%s' "$config" | jq --arg name "$name" 'del(.chains[$name])')"
  megabrain_chain_validate_config "$result" || return 1
  megabrain_chain_write "$result" || return 1
  if [ "$json" = true ]; then
    jq -n --arg name "$name" '{deleted: true, name: $name}'
  else
    printf 'chain deleted: %s\n' "$name"
  fi
}

command_chain_repair() {
  local name="${1:-}" step_number="" model="" effort="" json=false has_effort=false arg config result step agent
  case "$name" in
    -h|--help) megabrain_usage_show chain-repair; return 0 ;;
  esac
  [ -n "$name" ] || { megabrain_usage_fail chain-repair; return "$MEGABRAIN_USAGE_ERROR"; }
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --step) step_number="${2:-}"; shift 2 ;;
      --model) model="${2:-}"; shift 2 ;;
      --effort) effort="${2:-}"; has_effort=true; shift 2 ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show chain-repair; return 0 ;;
      *) megabrain_error "unknown chain repair option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  case "$step_number" in
    ''|*[!0-9]*|0) megabrain_error 'chain repair requires a positive --step number'; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
  [ -n "$model" ] || { megabrain_error '--model is required for chain repair'; return "$MEGABRAIN_USAGE_ERROR"; }
  config="$(megabrain_chain_read)" || return 1
  step="$(printf '%s' "$config" | jq -c --arg name "$name" --argjson index "$step_number" '.chains[$name].steps[$index - 1] // empty')"
  [ -n "$step" ] || { megabrain_error "chain step not found: $name step $step_number"; return 1; }
  agent="$(printf '%s' "$step" | jq -r '.agent')"
  megabrain_model_validate_step "$name" "$step_number" "$agent" "$model" "$effort" || return 1
  result="$(printf '%s' "$config" | jq --arg name "$name" --argjson index "$step_number" --arg model "$model" --arg effort "$effort" --argjson hasEffort "$has_effort" '.chains[$name].steps[$index - 1] |= (.model = $model | if $hasEffort then .effort = $effort else del(.effort) end | del(.unvalidated))')"
  megabrain_chain_validate_config "$result" || return 1
  megabrain_chain_write "$result" || return 1
  if [ "$json" = true ]; then
    printf '%s' "$result" | jq -c --arg name "$name" --argjson index "$step_number" '{repaired: true, chain: $name, step: $index, value: .chains[$name].steps[$index - 1]}'
  else
    printf 'chain repaired: %s step %s\n' "$name" "$step_number"
  fi
}

megabrain_chain_limits_update_providers() {
  local config="$1" action="$2" providers="$3" provider result
  result="$config"
  for provider in $(printf '%s' "$providers" | tr ',' ' '); do
    [ -n "$provider" ] || continue
    megabrain_chain_agent_known "$provider" || { megabrain_error "unknown provider: $provider"; return 1; }
    if [ "$action" = enable ]; then
      result="$(printf '%s' "$result" | jq --arg provider "$provider" '
        .usageLimits = ((.usageLimits // {}) + {liveProviders: ((.usageLimits.liveProviders // []) + [$provider] | unique), cacheTtlSeconds: (.usageLimits.cacheTtlSeconds // 30), timeoutSeconds: (.usageLimits.timeoutSeconds // 5), notice: (.usageLimits.notice // {enabled: false, intervalSeconds: 3600})})
      ')"
    else
      result="$(printf '%s' "$result" | jq --arg provider "$provider" '
        .usageLimits = ((.usageLimits // {}) + {liveProviders: ((.usageLimits.liveProviders // []) - [$provider]), cacheTtlSeconds: (.usageLimits.cacheTtlSeconds // 30), timeoutSeconds: (.usageLimits.timeoutSeconds // 5), notice: (.usageLimits.notice // {enabled: false, intervalSeconds: 3600})})
      ')"
    fi
  done
  printf '%s' "$result"
}

megabrain_chain_limits_print_rows() {
  local agent="$1" result="$2" source="$3" fetched_at="$4" reason="$5" requested_window="${6:-}" window used reset bucket reading_kind reading_basis
  reading_kind="$(printf '%s' "$result" | jq -r '.reading.kind // empty' 2>/dev/null || true)"
  reading_basis="$(printf '%s' "$result" | jq -r '.reading.basis // empty' 2>/dev/null || true)"
  if [ -n "$result" ]; then
    while IFS=$'\t' read -r window bucket used reset; do
      if [ "${MEGABRAIN_CHAIN_LIMIT_STATUS:-unknown}" = current ]; then
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t\t%s\t%s\t%s\n' "$agent" "$window" current "$used" "$reset" "$source" "$fetched_at" "$bucket" "$reading_kind" "$reading_basis"
      else
        printf '%s\t%s\tunknown\t\t\tunknown\t%s\t%s\t\t%s\t%s\n' "$agent" "$window" "$fetched_at" "$reason" "$reading_kind" "$reading_basis"
      fi
    done < <(printf '%s' "$result" | jq -r '.windows[]? | [.name, (.bucket // "default"), .usedPercent, .resetsAt] | @tsv')
  else
    if [ -n "$requested_window" ]; then
      printf '%s\t%s\tunknown\t\t\tunknown\t%s\t%s\t\t\t\n' "$agent" "$requested_window" "$fetched_at" "$reason"
    else
      for window in 5h weekly; do
        printf '%s\t%s\tunknown\t\t\tunknown\t%s\t%s\t\t\t\n' "$agent" "$window" "$fetched_at" "$reason"
      done
    fi
  fi
}

command_chain_limits() {
  local json=false enable="" disable="" notice_on=false notice_off=false notice_interval="" arg config result agent window rows line tmp_file first_reason
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --json) json=true ;;
      --enable) enable="${2:-}"; shift 2 ;;
      --disable) disable="${2:-}"; shift 2 ;;
      --notice-on) notice_on=true ;;
      --notice-off) notice_off=true ;;
      --notice-interval) notice_interval="${2:-}"; shift 2 ;;
      -h|--help) megabrain_usage_show chain-limits; return 0 ;;
      *) megabrain_error "unknown chain limits option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
    [ "$arg" = --enable ] || [ "$arg" = --disable ] || [ "$arg" = --notice-interval ] || shift
  done
  config="$(megabrain_chain_read)" || return 1
  megabrain_chain_validate_config "$config" || return 1
  result="$config"
  if [ -n "$enable" ]; then
    result="$(megabrain_chain_limits_update_providers "$result" enable "$enable")" || return 1
  fi
  if [ -n "$disable" ]; then
    result="$(megabrain_chain_limits_update_providers "$result" disable "$disable")" || return 1
  fi
  if [ "$notice_on" = true ] || [ "$notice_off" = true ] || [ -n "$notice_interval" ]; then
    if [ "$notice_on" = true ] && [ "$notice_off" = true ]; then
      megabrain_error 'cannot enable and disable the usage notice together'
      return "$MEGABRAIN_USAGE_ERROR"
    fi
    result="$(printf '%s' "$result" | jq --argjson turnOn "$( [ "$notice_on" = true ] && printf true || printf false )" --argjson turnOff "$( [ "$notice_off" = true ] && printf true || printf false )" --arg interval "$notice_interval" '
      .usageLimits = ((.usageLimits // {}) + {liveProviders: (.usageLimits.liveProviders // []), cacheTtlSeconds: (.usageLimits.cacheTtlSeconds // 30), timeoutSeconds: (.usageLimits.timeoutSeconds // 5), notice: {enabled: (if $turnOn then true elif $turnOff then false else (.usageLimits.notice.enabled // false) end), intervalSeconds: (if $interval == "" then (.usageLimits.notice.intervalSeconds // 3600) else ($interval | tonumber) end)}})
    ')" || return 1
  fi
  if [ "$result" != "$config" ]; then
    megabrain_chain_validate_config "$result" || return 1
    megabrain_chain_write "$result" || return 1
    config="$result"
  fi
  tmp_file="$(mktemp "$MEGABRAIN_STATE_DIR/chain-limits.XXXXXX")" || return 1
  for agent in codex claude agy; do
    megabrain_chain_limit_read "$agent" 5h
    if [ -n "$MEGABRAIN_CHAIN_LIMIT_RESULT" ]; then
      megabrain_chain_limits_print_rows "$agent" "$MEGABRAIN_CHAIN_LIMIT_RESULT" "$MEGABRAIN_CHAIN_LIMIT_SOURCE" "$MEGABRAIN_CHAIN_LIMIT_FETCHED_AT" "$MEGABRAIN_CHAIN_LIMIT_REASON" >>"$tmp_file"
    else
      first_reason="$MEGABRAIN_CHAIN_LIMIT_REASON"
      megabrain_chain_limit_read "$agent" weekly
      megabrain_chain_limits_print_rows "$agent" '' unknown "$MEGABRAIN_CHAIN_LIMIT_FETCHED_AT" "$first_reason" 5h >>"$tmp_file"
      megabrain_chain_limits_print_rows "$agent" '' unknown "$MEGABRAIN_CHAIN_LIMIT_FETCHED_AT" "$MEGABRAIN_CHAIN_LIMIT_REASON" weekly >>"$tmp_file"
    fi
  done
  if [ "$json" = true ]; then
    jq -Rn '[inputs | split("\t") | {provider: .[0], window: .[1], status: .[2], usedPercent: (if .[3] == "" then null else (.[3] | tonumber) end), resetsAt: (if .[4] == "" then null else .[4] end), source: .[5], fetchedAt: (if .[6] == "" then null else (.[6] | tonumber) end), reason: (if .[7] == "" then null else .[7] end), bucket: (if .[8] == "" then null else .[8] end), reading: (if .[9] == "" then null else {kind: .[9], basis: (if .[10] == "" then null else .[10] end)} end)}]' "$tmp_file"
  else
    printf '%-8s %-8s %-9s %-12s %-28s %-8s %s\n' PROVIDER WINDOW STATUS USED RESET SOURCE REASON
    while IFS=$'\t' read -r agent window line used reset result fetched_at reason; do
      printf '%-8s %-8s %-9s %-12s %-28s %-8s %s\n' "$agent" "$window" "$line" "${used:--}" "${reset:--}" "$result" "${reason:--}"
    done <"$tmp_file"
  fi
  rm -f "$tmp_file"
}

MEGABRAIN_CHAIN_LIMIT_STATUS="unknown"
MEGABRAIN_CHAIN_LIMIT_USED=""
MEGABRAIN_CHAIN_LIMIT_RESETS=""
MEGABRAIN_CHAIN_LIMIT_REASON=""
MEGABRAIN_CHAIN_LIMIT_SOURCE=""
MEGABRAIN_CHAIN_LIMIT_RESULT=""
MEGABRAIN_CHAIN_LIMIT_FETCHED_AT=""

megabrain_chain_codex_rollouts() {
  local window="${1:-5h}" root="$HOME/.codex/sessions" path="" mtime="" now="" cutoff="" max_age="" reference="" stamp=""
  case "$window" in
    5h) max_age=18000 ;;
    weekly) max_age=604800 ;;
    *) return 1 ;;
  esac
  [ -d "$root" ] || return 1
  now="$(date +%s)"
  cutoff=$((now - max_age - 1))
  reference="$(mktemp "${TMPDIR:-/tmp}/megabrain-chain-rollouts.XXXXXX")" || return 1
  if ! stamp="$(date -r "$cutoff" '+%Y%m%d%H%M.%S' 2>/dev/null)"; then
    stamp="$(date -d "@$cutoff" '+%Y%m%d%H%M.%S' 2>/dev/null)" || {
      rm -f "$reference"
      return 1
    }
  fi
  if ! touch -t "$stamp" "$reference"; then
    rm -f "$reference"
    return 1
  fi
  while IFS= read -r path; do
    [ -f "$path" ] || continue
    mtime="$(megabrain_path_mtime "$path" || printf '')"
    case "$mtime" in
      ''|*[!0-9]*) continue ;;
    esac
    printf '%s\t%s\n' "$mtime" "$path"
  done < <(find "$root" -type f -name 'rollout-*.jsonl' -newer "$reference" -print 2>/dev/null)
  rm -f "$reference"
}

megabrain_chain_limit_unknown() {
  local agent="$1" window="$2" reason="$3"
  MEGABRAIN_CHAIN_LIMIT_STATUS=unknown
  MEGABRAIN_CHAIN_LIMIT_USED=""
  MEGABRAIN_CHAIN_LIMIT_RESETS=""
  MEGABRAIN_CHAIN_LIMIT_SOURCE=unknown
  MEGABRAIN_CHAIN_LIMIT_RESULT=""
  MEGABRAIN_CHAIN_LIMIT_FETCHED_AT=""
  MEGABRAIN_CHAIN_LIMIT_REASON="$agent $window window unknown ($reason)"
}

megabrain_chain_limit_config() {
  megabrain_chain_init || return 1
  cat "$MEGABRAIN_CHAIN_FILE"
}

megabrain_chain_live_enabled() {
  local agent="$1" config
  config="$(megabrain_chain_limit_config)" || return 1
  printf '%s' "$config" | jq -e --arg agent "$agent" '(.usageLimits.liveProviders // []) | index($agent) != null' >/dev/null 2>&1
}

megabrain_chain_limit_ttl() {
  local config value
  if [ -n "${MEGABRAIN_CHAIN_LIMIT_TTL_SECONDS:-}" ]; then
    printf '%s\n' "$MEGABRAIN_CHAIN_LIMIT_TTL_SECONDS"
    return 0
  fi
  config="$(megabrain_chain_limit_config)" || return 1
  value="$(printf '%s' "$config" | jq -r '.usageLimits.cacheTtlSeconds // 30')"
  printf '%s\n' "$value"
}

megabrain_chain_limit_timeout() {
  local config value
  if [ -n "${MEGABRAIN_CHAIN_LIMIT_TIMEOUT_SECONDS:-}" ]; then
    printf '%s\n' "$MEGABRAIN_CHAIN_LIMIT_TIMEOUT_SECONDS"
    return 0
  fi
  config="$(megabrain_chain_limit_config)" || return 1
  value="$(printf '%s' "$config" | jq -r '.usageLimits.timeoutSeconds // 5')"
  printf '%s\n' "$value"
}

megabrain_chain_limit_cache_path() {
  printf '%s/usage-limits-%s.json\n' "$MEGABRAIN_STATE_DIR" "$1"
}

megabrain_chain_limit_cache_read() {
  local agent="$1" window="$2" path now fetched_at ttl cached
  path="$(megabrain_chain_limit_cache_path "$agent")"
  [ -f "$path" ] || return 1
  cached="$(cat "$path" 2>/dev/null || true)"
  printf '%s' "$cached" | jq -e --arg provider "$agent" '.provider == $provider and (.fetchedAt | type == "number") and (.windows | type == "array")' >/dev/null 2>&1 || return 1
  fetched_at="$(printf '%s' "$cached" | jq -r '.fetchedAt')"
  now="$(date +%s)"
  ttl="$(megabrain_chain_limit_ttl)"
  case "$fetched_at:$ttl" in
    ''|*[!0-9:]*) return 1 ;;
  esac
  [ "$fetched_at" -le "$now" ] && [ $((now - fetched_at)) -lt "$ttl" ] || return 1
  megabrain_chain_limit_apply "$cached" "$agent" "$window" cache
  [ "$MEGABRAIN_CHAIN_LIMIT_STATUS" = current ]
}

megabrain_chain_limit_cache_write() {
  local agent="$1" result="$2" path tmp
  mkdir -p "$MEGABRAIN_STATE_DIR" || return 1
  path="$(megabrain_chain_limit_cache_path "$agent")"
  tmp="$(mktemp "$MEGABRAIN_STATE_DIR/usage-limits.XXXXXX")" || return 1
  if ! printf '%s' "$result" | jq -e --arg provider "$agent" '.provider == $provider and (.fetchedAt | type == "number") and (.windows | type == "array")' >/dev/null 2>&1; then
    rm -f "$tmp"
    return 1
  fi
  if ! printf '%s' "$result" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$path"
}

megabrain_chain_usage_notice_config() {
  local config
  config="$(megabrain_chain_limit_config)" || return 1
  printf '%s' "$config" | jq -c '.usageLimits.notice // {enabled: false, intervalSeconds: 3600}'
}

megabrain_chain_usage_notice_report() {
  local agent result summary report="Usage limits:"
  for agent in codex claude agy; do
    megabrain_chain_limit_read "$agent" 5h
    result="$MEGABRAIN_CHAIN_LIMIT_RESULT"
    if [ -n "$result" ]; then
      summary="$(printf '%s' "$result" | jq -r '[.windows[] | ((.bucket // "default") + " " + .name + " " + (.usedPercent | tostring) + "% used, resets " + .resetsAt)] | join("; ")')"
    else
      summary="unknown (${MEGABRAIN_CHAIN_LIMIT_REASON#* window unknown (}"
      summary="${summary%)}"
    fi
    report="$report $agent $summary;"
  done
  printf '%s\n' "$report"
}

megabrain_chain_usage_notice_state_path() {
  printf '%s/usage-limit-notice.json\n' "$MEGABRAIN_STATE_DIR"
}

megabrain_chain_usage_notice_due() {
  local notice="$1" path now sent_at interval
  printf '%s' "$notice" | jq -e '.enabled == true' >/dev/null 2>&1 || return 1
  interval="$(printf '%s' "$notice" | jq -r '.intervalSeconds // 3600')"
  path="$(megabrain_chain_usage_notice_state_path)"
  sent_at=0
  if [ -f "$path" ]; then
    sent_at="$(jq -r '.sentAt // 0' "$path" 2>/dev/null || printf '0')"
  fi
  now="$(date +%s)"
  case "$sent_at:$interval" in
    ''|*[!0-9:]*) return 1 ;;
  esac
  [ "$sent_at" -gt "$now" ] || [ $((now - sent_at)) -ge "$interval" ]
}

megabrain_chain_usage_notice_mark() {
  local path tmp now
  mkdir -p "$MEGABRAIN_STATE_DIR" || return 1
  path="$(megabrain_chain_usage_notice_state_path)"
  tmp="$(mktemp "$MEGABRAIN_STATE_DIR/usage-limit-notice.XXXXXX")" || return 1
  now="$(date +%s)"
  jq -n --argjson sentAt "$now" '{sentAt: $sentAt}' >"$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$path"
}

megabrain_chain_usage_notice_maybe() {
  local dispatch_id="$1" notice meta report
  notice="$(megabrain_chain_usage_notice_config)" || return 0
  megabrain_chain_usage_notice_due "$notice" || return 0
  report="$(megabrain_chain_usage_notice_report)" || return 0
  meta="$(megabrain_dispatch_meta_read "$dispatch_id" 2>/dev/null || true)"
  [ -n "$meta" ] || return 0
  # megabrain:usage is actionable mail, so message_append itself creates the parent
  # delivery and fires the pointer; a second notify here would just double-nudge the pane.
  megabrain_dispatch_message_append "$dispatch_id" megabrain usage "$report" "${MEGABRAIN_SESSION_ID:-megabrain}" >/dev/null 2>&1 || return 0
  megabrain_chain_usage_notice_mark >/dev/null 2>&1 || true
}

megabrain_chain_limit_apply() {
  local result="$1" agent="$2" window="$3" source="$4" entry
  entry="$(printf '%s' "$result" | jq -c --arg window "$window" '
    [.windows[]? | select(.name == $window)] | first // empty
  ' 2>/dev/null)"
  MEGABRAIN_CHAIN_LIMIT_RESULT="$result"
  MEGABRAIN_CHAIN_LIMIT_FETCHED_AT="$(printf '%s' "$result" | jq -r '.fetchedAt // empty' 2>/dev/null)"
  MEGABRAIN_CHAIN_LIMIT_SOURCE="$source"
  if [ -z "$entry" ] || ! printf '%s' "$entry" | jq -e '
    (.usedPercent | type == "number") and
    (.remainingPercent | type == "number") and
    (.resetsAt | type == "string") and (.resetsAt | length > 0)
  ' >/dev/null 2>&1; then
    megabrain_chain_limit_unknown "$agent" "$window" 'provider response has no usable window'
    MEGABRAIN_CHAIN_LIMIT_RESULT="$result"
    MEGABRAIN_CHAIN_LIMIT_FETCHED_AT="$(printf '%s' "$result" | jq -r '.fetchedAt // empty' 2>/dev/null)"
    return 0
  fi
  MEGABRAIN_CHAIN_LIMIT_USED="$(printf '%s' "$entry" | jq -r '.usedPercent')"
  MEGABRAIN_CHAIN_LIMIT_RESETS="$(printf '%s' "$entry" | jq -r '.resetsAt')"
  MEGABRAIN_CHAIN_LIMIT_STATUS=current
  MEGABRAIN_CHAIN_LIMIT_REASON="$agent $window window at $(megabrain_chain_percent_text "$MEGABRAIN_CHAIN_LIMIT_USED") percent"
}

megabrain_chain_percent_text() {
  printf '%.1f\n' "$1"
}

megabrain_chain_limit_result_codex() {
  local snapshot="$1" fetched_at="$2"
  jq -cn --argjson snapshot "$snapshot" --argjson fetchedAt "$fetched_at" '
    def usable:
      (.value | type == "object") and
      (.value.window_minutes | type == "number") and
      (.value.used_percent | type == "number") and
      (.value.resets_at | type == "number");
    def name:
      if .value.window_minutes == 300 then "5h"
      elif .value.window_minutes == 10080 then "weekly"
      else (.key + "-" + (.value.window_minutes | tostring) + "m")
      end;
    {provider: "codex", fetchedAt: $fetchedAt, reading: {kind: "floor", basis: "last-recorded-turn", fetchedAt: $fetchedAt}, windows: [
      $snapshot | to_entries[] | select(usable) |
      {name: name, bucket: "default", usedPercent: .value.used_percent,
       remainingPercent: (100 - .value.used_percent),
       resetsAt: (.value.resets_at | tostring), windowMinutes: .value.window_minutes}
    ]}
  '
}

megabrain_chain_claude_credentials() {
  local credentials
  credentials="$(security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null)" || return 1
  MEGABRAIN_CHAIN_CLAUDE_TOKEN="$(printf '%s' "$credentials" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)"
  MEGABRAIN_CHAIN_CLAUDE_EXPIRES="$(printf '%s' "$credentials" | jq -r '.claudeAiOauth.expiresAt // empty' 2>/dev/null)"
  unset credentials
  [ -n "$MEGABRAIN_CHAIN_CLAUDE_TOKEN" ] || return 2
  return 0
}

megabrain_chain_claude_usage() {
  local requested_window="$1" response http_status curl_rc=0 url result now expires credential_rc timeout
  MEGABRAIN_CHAIN_CLAUDE_TOKEN=""
  MEGABRAIN_CHAIN_CLAUDE_EXPIRES=""
  if megabrain_chain_claude_credentials; then
    credential_rc=0
  else
    credential_rc=$?
  fi
  if [ "$credential_rc" -ne 0 ]; then
    case "$credential_rc" in
      1) megabrain_chain_limit_unknown claude "$requested_window" 'Keychain item is missing' ;;
      *) megabrain_chain_limit_unknown claude "$requested_window" 'Keychain credential has no access token' ;;
    esac
    return 0
  fi
  now="$(date +%s)"
  expires="$MEGABRAIN_CHAIN_CLAUDE_EXPIRES"
  if [ -n "$expires" ]; then
    case "$expires" in
      *[!0-9]*)
        megabrain_chain_limit_unknown claude "$requested_window" 'credential expiry is malformed'
        unset MEGABRAIN_CHAIN_CLAUDE_TOKEN MEGABRAIN_CHAIN_CLAUDE_EXPIRES
        return 0
        ;;
      *) [ "$expires" -gt 100000000000 ] && expires=$((expires / 1000)) ;;
    esac
    if [ "$expires" -le "$now" ]; then
      megabrain_chain_limit_unknown claude "$requested_window" "credential is expired at $expires; refreshing requires a separate OAuth flow"
      unset MEGABRAIN_CHAIN_CLAUDE_TOKEN MEGABRAIN_CHAIN_CLAUDE_EXPIRES
      return 0
    fi
  fi
  timeout="$(megabrain_chain_limit_timeout)" || timeout=5
  url="${MEGABRAIN_CHAIN_CLAUDE_USAGE_URL:-https://api.anthropic.com/api/oauth/usage}"
  response="$(curl -sS --connect-timeout "$timeout" --max-time "$timeout" \
    -H "Authorization: Bearer $MEGABRAIN_CHAIN_CLAUDE_TOKEN" \
    -H 'anthropic-beta: oauth-2025-04-20' -H 'anthropic-version: 2023-06-01' \
    -w '\nMEGABRAIN_HTTP_STATUS:%{http_code}' "$url" 2>/dev/null)" || curl_rc=$?
  unset MEGABRAIN_CHAIN_CLAUDE_TOKEN MEGABRAIN_CHAIN_CLAUDE_EXPIRES
  http_status="${response##*MEGABRAIN_HTTP_STATUS:}"
  response="${response%$'\n'MEGABRAIN_HTTP_STATUS:*}"
  if [ "$curl_rc" -eq 28 ]; then
    megabrain_chain_limit_unknown claude "$requested_window" 'request timed out'
    return 0
  fi
  if [ "$curl_rc" -ne 0 ] || [ "$http_status" = 000 ]; then
    megabrain_chain_limit_unknown claude "$requested_window" 'network request failed'
    return 0
  fi
  if [ "$http_status" -lt 200 ] || [ "$http_status" -ge 300 ]; then
    megabrain_chain_limit_unknown claude "$requested_window" "provider returned HTTP $http_status"
    return 0
  fi
  now="$(date +%s)"
  result="$(printf '%s' "$response" | jq -c --argjson fetchedAt "$now" '
    [(.five_hour // empty), (.seven_day // empty)] |
    to_entries |
    map(select((.value | type) == "object") |
      select((.value.utilization | type) == "number") |
      select((.value.resets_at | type) == "string" and (.value.resets_at | length) > 0) |
      {name: (if .key == 0 then "5h" else "weekly" end), bucket: "default",
       usedPercent: .value.utilization,
       remainingPercent: (100 - .value.utilization), resetsAt: .value.resets_at}) |
    {provider: "claude", fetchedAt: $fetchedAt, windows: .}
  ' 2>/dev/null)" || result=""
  if [ -z "$result" ] || ! printf '%s' "$result" | jq -e '.windows | length > 0' >/dev/null 2>&1; then
    megabrain_chain_limit_unknown claude "$requested_window" 'response body is unparseable or incomplete'
    return 0
  fi
  MEGABRAIN_CHAIN_LIMIT_RESULT="$result"
  MEGABRAIN_CHAIN_LIMIT_FETCHED_AT="$now"
}

megabrain_chain_agy_credentials() {
  local credentials encoded
  credentials="$(security find-generic-password -s gemini -w 2>/dev/null)" || return 1
  case "$credentials" in
    go-keyring-base64:*) encoded="${credentials#go-keyring-base64:}" ;;
    *) unset credentials; return 2 ;;
  esac
  # BSD base64 calls decode -D; GNU base64 uses the lowercase -d spelling.
  credentials="$(printf '%s' "$encoded" | base64 -D 2>/dev/null || printf '%s' "$encoded" | base64 -d 2>/dev/null)" || {
    unset encoded
    return 2
  }
  MEGABRAIN_CHAIN_AGY_TOKEN="$(printf '%s' "$credentials" | jq -r '.token // empty' 2>/dev/null)"
  unset credentials encoded
  [ -n "$MEGABRAIN_CHAIN_AGY_TOKEN" ] || return 3
  return 0
}

megabrain_chain_agy_usage() {
  local requested_window="$1" response http_status curl_rc=0 url result now credential_rc timeout
  MEGABRAIN_CHAIN_AGY_TOKEN=""
  if megabrain_chain_agy_credentials; then
    credential_rc=0
  else
    credential_rc=$?
  fi
  if [ "$credential_rc" -ne 0 ]; then
    case "$credential_rc" in
      1) megabrain_chain_limit_unknown agy "$requested_window" 'Keychain item is missing' ;;
      2) megabrain_chain_limit_unknown agy "$requested_window" 'Keychain credential wrapper is unsupported' ;;
      *) megabrain_chain_limit_unknown agy "$requested_window" 'Keychain credential has no token' ;;
    esac
    return 0
  fi
  timeout="$(megabrain_chain_limit_timeout)" || timeout=5
  url="${MEGABRAIN_CHAIN_AGY_USAGE_URL:-https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary}"
  # WHY: this is an undocumented client endpoint and its response contract can change.
  response="$(curl -sS --connect-timeout "$timeout" --max-time "$timeout" \
    -X POST -H "Authorization: Bearer $MEGABRAIN_CHAIN_AGY_TOKEN" -H 'Content-Type: application/json' \
    -d '{}' -w '\nMEGABRAIN_HTTP_STATUS:%{http_code}' "$url" 2>/dev/null)" || curl_rc=$?
  unset MEGABRAIN_CHAIN_AGY_TOKEN
  http_status="${response##*MEGABRAIN_HTTP_STATUS:}"
  response="${response%$'\n'MEGABRAIN_HTTP_STATUS:*}"
  if [ "$curl_rc" -eq 28 ]; then
    megabrain_chain_limit_unknown agy "$requested_window" 'request timed out'
    return 0
  fi
  if [ "$curl_rc" -ne 0 ] || [ "$http_status" = 000 ]; then
    megabrain_chain_limit_unknown agy "$requested_window" 'network request failed'
    return 0
  fi
  if [ "$http_status" -lt 200 ] || [ "$http_status" -ge 300 ]; then
    megabrain_chain_limit_unknown agy "$requested_window" "provider returned HTTP $http_status"
    return 0
  fi
  now="$(date +%s)"
  result="$(printf '%s' "$response" | jq -c --argjson fetchedAt "$now" '
    def reset_at:
      (.reset_at // .resets_at // .reset_time // .resetTime // empty) as $reset |
      if ($reset | type) == "string" then $reset
      elif ($reset | type) == "object" and ($reset.seconds? | type) == "number" then ($reset.seconds | todateiso8601)
      else empty end;
    def quota_entries($bucket):
      to_entries |
      map(select((.value.remaining_fraction | type) == "number") |
        select((.value | reset_at) != "") |
        {name: (if (.key | endswith("-5h")) then "5h" elif (.key | endswith("-weekly")) then "weekly" else empty end),
         bucket: $bucket,
         usedPercent: ((100 - (.value.remaining_fraction * 100)) | if . < 0 then 0 elif . > 100 then 100 else . end),
         remainingPercent: ((.value.remaining_fraction * 100) | if . < 0 then 0 elif . > 100 then 100 else . end),
         resetsAt: (.value | reset_at)}) |
      map(select(.name != null));
    ((.quota // {}) | if type == "object" then quota_entries("default") else [] end) as $legacy |
    (if (.buckets? | type) == "array" then
       [.buckets[] | . as $group | (($group.quota // $group) | if type == "object" then quota_entries($group.displayName // $group.name // "unknown") else [] end)] | add
     else [] end) as $groups |
    {provider: "agy", fetchedAt: $fetchedAt, windows: ($legacy + $groups)}
  ' 2>/dev/null)" || result=""
  if [ -z "$result" ] || ! printf '%s' "$result" | jq -e '.windows | length > 0' >/dev/null 2>&1; then
    megabrain_chain_limit_unknown agy "$requested_window" 'response body is unparseable or incomplete'
    return 0
  fi
  MEGABRAIN_CHAIN_LIMIT_RESULT="$result"
  MEGABRAIN_CHAIN_LIMIT_FETCHED_AT="$now"
}

megabrain_chain_limit_read() {
  local agent="$1" window="$2" rollout snapshot="" latest_snapshot="" matching_snapshot="" candidate="" candidate_snapshot="" candidate_matches="" field expected_minutes now fetched_at result observed window_count actual_window
  MEGABRAIN_CHAIN_LIMIT_STATUS=unknown
  MEGABRAIN_CHAIN_LIMIT_USED=""
  MEGABRAIN_CHAIN_LIMIT_RESETS=""
  MEGABRAIN_CHAIN_LIMIT_REASON=""
  MEGABRAIN_CHAIN_LIMIT_SOURCE=""
  MEGABRAIN_CHAIN_LIMIT_RESULT=""
  MEGABRAIN_CHAIN_LIMIT_FETCHED_AT=""
  case "$agent" in
    claude|agy)
      if ! megabrain_chain_live_enabled "$agent"; then
        megabrain_chain_limit_unknown "$agent" "$window" 'live provider is not enabled'
        return 0
      fi
      if megabrain_chain_limit_cache_read "$agent" "$window"; then
        return 0
      fi
      if [ "$agent" = claude ]; then
        megabrain_chain_claude_usage "$window"
        if [ -n "$MEGABRAIN_CHAIN_LIMIT_RESULT" ]; then
          megabrain_chain_limit_apply "$MEGABRAIN_CHAIN_LIMIT_RESULT" claude "$window" live
          [ "$MEGABRAIN_CHAIN_LIMIT_STATUS" = current ] && megabrain_chain_limit_cache_write claude "$MEGABRAIN_CHAIN_LIMIT_RESULT" >/dev/null 2>&1 || true
        else
          [ -n "$MEGABRAIN_CHAIN_LIMIT_REASON" ] || megabrain_chain_limit_unknown claude "$window" 'provider reader returned no result'
        fi
      else
        megabrain_chain_agy_usage "$window"
        if [ -n "$MEGABRAIN_CHAIN_LIMIT_RESULT" ]; then
          megabrain_chain_limit_apply "$MEGABRAIN_CHAIN_LIMIT_RESULT" agy "$window" live
          [ "$MEGABRAIN_CHAIN_LIMIT_STATUS" = current ] && megabrain_chain_limit_cache_write agy "$MEGABRAIN_CHAIN_LIMIT_RESULT" >/dev/null 2>&1 || true
        else
          [ -n "$MEGABRAIN_CHAIN_LIMIT_REASON" ] || megabrain_chain_limit_unknown agy "$window" 'provider reader returned no result'
        fi
      fi
      return 0
      ;;
    codex) ;;
    *)
      MEGABRAIN_CHAIN_LIMIT_REASON="$agent $window window unknown (unsupported provider)"
      return 0
      ;;
  esac
  case "$window" in
    5h) expected_minutes=300 ;;
    weekly) expected_minutes=10080 ;;
    *)
      MEGABRAIN_CHAIN_LIMIT_REASON="codex $window window unknown (unsupported window)"
      return 0
      ;;
  esac
  while IFS= read -r rollout; do
    candidate="$(jq -c --argjson minutes "$expected_minutes" '
      (.payload.rate_limits? // .rate_limits?) as $limits |
      select(($limits | type) == "object") |
      ([ $limits | to_entries[] |
        select((.value | type) == "object") |
        select((.value.window_minutes | type) == "number")
      ]) as $windows |
      select(($windows | length) > 0) |
      {snapshot: $limits, matches: ([$windows[] | select(.value.window_minutes == $minutes)] | length)}
    ' "$rollout" 2>/dev/null | tail -n 1)"
    if [ -n "$candidate" ]; then
      candidate_snapshot="$(printf '%s' "$candidate" | jq -c '.snapshot')"
      latest_snapshot="$candidate_snapshot"
      candidate_matches="$(printf '%s' "$candidate" | jq -r '.matches')"
      if [ "$candidate_matches" -gt 0 ] && [ -z "$matching_snapshot" ]; then
        matching_snapshot="$candidate_snapshot"
      fi
    fi
  done < <(megabrain_chain_codex_rollouts "$window" 2>/dev/null | LC_ALL=C sort -k1,1nr -k2,2r | head -n "$MEGABRAIN_CHAIN_CODEX_ROLLOUT_SCAN_LIMIT" | cut -f2- || true)
  if [ -n "$matching_snapshot" ]; then
    snapshot="$matching_snapshot"
  else
    snapshot="$latest_snapshot"
  fi
  if [ -z "$snapshot" ]; then
    megabrain_chain_limit_unknown codex "$window" 'rollout has no rate limit snapshot'
    return 0
  fi
  observed="$(printf '%s' "$snapshot" | jq -r '
    [to_entries[] |
      select((.value | type) == "object") |
      select((.value.window_minutes | type) == "number") |
      (.key + " " + (.value.window_minutes | tostring) + " minutes")
    ] | join(", ")
  ' 2>/dev/null)"
  field="$(printf '%s' "$snapshot" | jq -r --argjson minutes "$expected_minutes" '
    [to_entries[] |
      select((.value | type) == "object") |
      select((.value.window_minutes | type) == "number") |
      select(.value.window_minutes == $minutes) |
      .key
    ] | first // empty
  ' 2>/dev/null)"
  if [ -z "$field" ]; then
    window_count="$(printf '%s' "$snapshot" | jq -r '
      [to_entries[] |
        select((.value | type) == "object") |
        select((.value.window_minutes | type) == "number")
      ] | length
    ' 2>/dev/null)"
    # WHY: with one reported window it is the account's only governing quota;
    # with several, choosing one would invent a policy the provider did not state.
    case "$window_count" in
      1) ;;
      *)
      megabrain_chain_limit_unknown codex "$window" "snapshot reports $observed; requested window is not present"
      return 0
      ;;
    esac
    field="$(printf '%s' "$snapshot" | jq -r '
      [to_entries[] |
        select((.value | type) == "object") |
        select((.value.window_minutes | type) == "number") |
        .key
      ] | first // empty
    ' 2>/dev/null)"
    actual_window="$(printf '%s' "$snapshot" | jq -r --arg field "$field" '
      .[$field].window_minutes as $minutes |
      if $minutes == 300 then "5h"
      elif $minutes == 10080 then "weekly"
      else ($field + "-" + ($minutes | tostring) + "m")
      end
    ' 2>/dev/null)"
  else
    actual_window="$window"
  fi
  if ! printf '%s' "$snapshot" | jq -e --arg field "$field" '
    (.[$field].used_percent | type == "number") and
    (.[$field].resets_at | type == "number")
  ' >/dev/null 2>&1; then
    megabrain_chain_limit_unknown codex "$window" "snapshot reports $field $expected_minutes minutes but its usage data is incomplete"
    return 0
  fi
  MEGABRAIN_CHAIN_LIMIT_USED="$(printf '%s' "$snapshot" | jq -r --arg field "$field" '.[$field].used_percent')"
  MEGABRAIN_CHAIN_LIMIT_RESETS="$(printf '%s' "$snapshot" | jq -r --arg field "$field" '.[$field].resets_at')"
  now="$(date +%s)"
  # WHY: a recorded reset means the snapshot no longer describes the current window.
  if [ "$MEGABRAIN_CHAIN_LIMIT_RESETS" -le "$now" ]; then
    megabrain_chain_limit_unknown codex "$window" "recorded window has already reset at $MEGABRAIN_CHAIN_LIMIT_RESETS and carries no information about the current window"
    return 0
  fi
  fetched_at="$(megabrain_path_mtime "$rollout" 2>/dev/null || printf '%s' "$now")"
  case "$fetched_at" in
    ''|*[!0-9]*) fetched_at="$now" ;;
  esac
  result="$(megabrain_chain_limit_result_codex "$snapshot" "$fetched_at")"
  MEGABRAIN_CHAIN_LIMIT_RESULT="$result"
  MEGABRAIN_CHAIN_LIMIT_FETCHED_AT="$fetched_at"
  MEGABRAIN_CHAIN_LIMIT_STATUS=current
  MEGABRAIN_CHAIN_LIMIT_SOURCE=disk
  MEGABRAIN_CHAIN_LIMIT_REASON="codex $actual_window window at $(megabrain_chain_percent_text "$MEGABRAIN_CHAIN_LIMIT_USED") percent"
}

MEGABRAIN_CHAIN_SELECTED_NAME=""
MEGABRAIN_CHAIN_SELECTED_STEPS="[]"
MEGABRAIN_CHAIN_SELECTION_REASON=""
MEGABRAIN_CHAIN_SELECTION_DEFAULT=false

megabrain_chain_select() {
  local config="$1" explicit_name="${2:-}" parent_agent="${3:-}" parent_model="${4:-}" parent_effort="${5:-}" explicit_source="${6:-name}"
  local chain required actual matched specificity best_specificity=-1 candidates='' count=0 selection_filter selected_steps best_steps='' selector_fields=0
  MEGABRAIN_CHAIN_SELECTED_NAME=""
  MEGABRAIN_CHAIN_SELECTED_STEPS='[]'
  MEGABRAIN_CHAIN_SELECTION_REASON=""
  MEGABRAIN_CHAIN_SELECTION_DEFAULT=false
  selection_filter="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/chain-selection.jq"
  if [ -n "$explicit_name" ]; then
    if ! selected_steps="$(printf '%s' "$config" | jq -c --arg name "$explicit_name" 'if (.chains | has($name)) then .chains[$name].steps else empty end')"; then
      megabrain_error "chain not found: $explicit_name; list chains with megabrain chain list"
      return 1
    fi
    [ -n "$selected_steps" ] || {
      megabrain_error "chain not found: $explicit_name; list chains with megabrain chain list"
      return 1
    }
    MEGABRAIN_CHAIN_SELECTED_NAME="$explicit_name"
    MEGABRAIN_CHAIN_SELECTED_STEPS="$selected_steps"
    if [ "$explicit_source" = flag ]; then
      MEGABRAIN_CHAIN_SELECTION_REASON="explicit --chain requested"
    else
      MEGABRAIN_CHAIN_SELECTION_REASON="explicit name given"
    fi
    return 0
  fi
  while IFS=$'\t' read -r chain required_agent required_model required_effort selected_steps; do
    matched=true
    specificity=0
    for field in parentAgent parentModel parentEffort; do
      case "$field" in
        parentAgent) required="$required_agent" ;;
        parentModel) required="$required_model" ;;
        parentEffort) required="$required_effort" ;;
      esac
      [ "$required" != - ] || continue
      selector_fields=$((selector_fields + 1))
      specificity=$((specificity + 1))
      case "$field" in
        parentAgent) actual="$parent_agent" ;;
        parentModel) actual="$parent_model" ;;
        parentEffort) actual="$parent_effort" ;;
      esac
      if [ -z "$actual" ] || [ "$actual" != "$required" ]; then
        matched=false
      fi
    done
    [ "$matched" = true ] || continue
    if [ "$specificity" -gt "$best_specificity" ]; then
      best_specificity="$specificity"
      candidates="$chain"
      best_steps="$selected_steps"
      count=1
    elif [ "$specificity" -eq "$best_specificity" ]; then
      candidates="$candidates, $chain"
      count=$((count + 1))
    fi
  done < <(printf '%s' "$config" | jq -r -f "$selection_filter")
  if [ "$count" -gt 1 ]; then
    megabrain_error "chain selection is ambiguous: candidates: $candidates"
    return 1
  fi
  if [ "$count" -eq 1 ]; then
    MEGABRAIN_CHAIN_SELECTED_NAME="$candidates"
    MEGABRAIN_CHAIN_SELECTED_STEPS="$best_steps"
    MEGABRAIN_CHAIN_SELECTION_REASON="selector match with $best_specificity field(s)"
    return 0
  fi
  MEGABRAIN_CHAIN_SELECTION_DEFAULT=true
  if [ "$selector_fields" -gt 0 ] && [ -z "$parent_agent" ]; then
    MEGABRAIN_CHAIN_SELECTION_REASON="parent agent is unknown; no selector matched; using defaultSteps"
  else
    MEGABRAIN_CHAIN_SELECTION_REASON="no selector matched; using defaultSteps"
  fi
  MEGABRAIN_CHAIN_SELECTED_STEPS="$(printf '%s' "$config" | jq -c '.defaultSteps')"
}

megabrain_chain_run_spawn() {
  local worktree="$1" repo="$2" branch="$3" base="$4" slug="$5" prompt="$6" label="$7" tmux_choice="$8" model="$9" effort="${10}" agent="${11}" browser="${12:-false}"
  local -a agent_args=() spawn_args=() arg
  shift 12
  [ "$#" -eq 0 ] || agent_args=("$@")
  if [ -n "$worktree" ]; then
    spawn_args+=(--worktree "$worktree")
  else
    spawn_args+=(--repo "$repo" --branch "$branch")
    [ -n "$base" ] && spawn_args+=(--base "$base")
    [ -n "$slug" ] && spawn_args+=(--name "$slug")
  fi
  spawn_args+=(--agent "$agent" --model "$model")
  [ -n "$effort" ] && spawn_args+=(--effort "$effort")
  spawn_args+=(--prompt "$prompt" --json)
  [ -n "$label" ] && spawn_args+=(--label "$label")
  [ -n "$tmux_choice" ] && spawn_args+=(--tmux "$tmux_choice")
  [ "$browser" = true ] && spawn_args+=(--browser)
  if [ "${#agent_args[@]}" -gt 0 ]; then
    for arg in "${agent_args[@]}"; do
      spawn_args+=(--agent-arg "$arg")
    done
  fi
  command_orchestrate spawn "${spawn_args[@]}"
}

megabrain_chain_reset_display() {
  local reset_at="$1"
  date -u -r "$reset_at" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '%s' "$reset_at"
}

megabrain_chain_clear_dispatch_context() {
  MEGABRAIN_CHAIN_NAME=""
  MEGABRAIN_CHAIN_STEP=""
  MEGABRAIN_CHAIN_TOTAL=""
  MEGABRAIN_CHAIN_REASON=""
  MEGABRAIN_CHAIN_DEFAULT=false
}

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

# WHY: chain run and orchestrate spawn are two front doors to the same fallback
# policy. Keeping the limit checks and launch retry in one walk prevents the front
# door from silently bypassing a chain's usage windows.
megabrain_chain_walk() {
  local worktree="$1" repo="$2" branch="$3" base="$4" slug="$5" prompt="$6" label="$7" tmux_choice="$8"
  local model_override="$9" effort_override="${10}" model_explicit="${11}" effort_explicit="${12}"
  local browser="${13:-false}"
  local step_count index step agent model effort until_json threshold window on_unknown limit_reason reason reset_text failure_reason final_reason report_chain start_index
  local spawn_output spawn_json spawn_error error_file dispatch_id spawn_succeeded
  local -a agent_args=()
  # WHY: callers from before --browser supplied twelve positional arguments; keep that
  # private helper compatible while recognizing the new boolean slot when present.
  if [ "$#" -ge 13 ] && { [ "${13:-}" = true ] || [ "${13:-}" = false ]; }; then
    shift 13
  else
    browser=false
    shift 12
  fi
  [ "$#" -gt 0 ] && agent_args=("$@")
  MEGABRAIN_CHAIN_WALK_OUTPUT=""
  MEGABRAIN_CHAIN_WALK_SPAWN_JSON=null
  MEGABRAIN_CHAIN_WALK_AGENT=""
  MEGABRAIN_CHAIN_WALK_STEP=""
  MEGABRAIN_CHAIN_WALK_TOTAL=""
  MEGABRAIN_CHAIN_WALK_REASON=""
  MEGABRAIN_CHAIN_WALK_SKIPPED='[]'
  MEGABRAIN_CHAIN_WALK_DISPATCH_ID=""
  start_index="${MEGABRAIN_CHAIN_WALK_START_INDEX:-0}"
  case "$start_index" in
    ''|*[!0-9]*) return 1 ;;
  esac
  step_count="$(printf '%s' "$MEGABRAIN_CHAIN_SELECTED_STEPS" | jq 'length')" || return 1
  report_chain="$MEGABRAIN_CHAIN_SELECTED_NAME"
  [ "$MEGABRAIN_CHAIN_SELECTION_DEFAULT" = true ] && report_chain=defaultSteps
  MEGABRAIN_CHAIN_WALK_TOTAL="$step_count"
  if [ "$step_count" -eq 0 ]; then
    MEGABRAIN_CHAIN_WALK_REASON='chain has no usable steps; add a chain with megabrain chain add'
    megabrain_error 'no usable chain steps; add a chain with megabrain chain add'
    return 1
  fi
  error_file="$(mktemp "$MEGABRAIN_STATE_DIR/chain-run.XXXXXX")" || return 1
  megabrain_chain_temp_begin "$error_file"
  index=0
  while IFS= read -r step; do
    index=$((index + 1))
    [ "$index" -gt "$start_index" ] || continue
    agent="$(printf '%s' "$step" | jq -r '.agent')"
    model="$(printf '%s' "$step" | jq -r '.model')"
    effort="$(printf '%s' "$step" | jq -r '.effort // empty')"
    [ "$model_explicit" = true ] && model="$model_override"
    [ "$effort_explicit" = true ] && effort="$effort_override"
    if [ "$model_explicit" = true ] || [ "$effort_explicit" = true ]; then
      if ! megabrain_model_known "$agent" "$model"; then
        megabrain_chain_temp_end
        megabrain_error "--model '$model' is not valid for chain-selected agent '$agent'; list models with megabrain model list"
        return "$MEGABRAIN_USAGE_ERROR"
      fi
      if ! megabrain_model_validate_reasoning "$agent" "$model" "$effort"; then
        megabrain_chain_temp_end
        return "$MEGABRAIN_USAGE_ERROR"
      fi
    fi
    until_json="$(printf '%s' "$step" | jq -c '.until // empty')"
    limit_reason=""
    MEGABRAIN_CHAIN_LIMIT_RESETS=""
    if [ -n "$until_json" ]; then
      threshold="$(printf '%s' "$until_json" | jq -r '.usedPercent')"
      window="$(printf '%s' "$until_json" | jq -r '.window')"
      on_unknown="$(printf '%s' "$until_json" | jq -r '.onUnknown // "take"')"
      megabrain_chain_limit_read "$agent" "$window"
      limit_reason="$MEGABRAIN_CHAIN_LIMIT_REASON"
      if [ "$MEGABRAIN_CHAIN_LIMIT_STATUS" = unknown ]; then
        if [ "$on_unknown" = skip ]; then
          reason="$limit_reason"
          MEGABRAIN_CHAIN_WALK_SKIPPED="$(printf '%s' "$MEGABRAIN_CHAIN_WALK_SKIPPED" | jq --argjson step "$index" --arg agent "$agent" --arg reason "$reason" '. + [{step: $step, agent: $agent, kind: "limit", reason: $reason}]')"
          continue
        fi
        printf 'chain step %s (%s) usage limit is unknown; taking step (onUnknown=take)\n' "$index" "$agent" >&2
      fi
      if [ "$MEGABRAIN_CHAIN_LIMIT_STATUS" = current ] && awk -v used="$MEGABRAIN_CHAIN_LIMIT_USED" -v threshold="$threshold" 'BEGIN { exit !(used >= threshold) }'; then
        reset_text=""
        [ -n "$MEGABRAIN_CHAIN_LIMIT_RESETS" ] && reset_text="; resets at $(megabrain_chain_reset_display "$MEGABRAIN_CHAIN_LIMIT_RESETS")"
        reason="$MEGABRAIN_CHAIN_LIMIT_REASON$reset_text"
        MEGABRAIN_CHAIN_WALK_SKIPPED="$(printf '%s' "$MEGABRAIN_CHAIN_WALK_SKIPPED" | jq --argjson step "$index" --arg agent "$agent" --arg reason "$reason" '. + [{step: $step, agent: $agent, kind: "limit", reason: $reason}]')"
        continue
      fi
    fi
    final_reason="$(printf '%s' "$MEGABRAIN_CHAIN_WALK_SKIPPED" | jq -r '[.[].reason] | join("; ")')"
    [ -n "$final_reason" ] || final_reason='no earlier steps skipped'
    if [ "$MEGABRAIN_CHAIN_SELECTION_DEFAULT" = true ]; then
      final_reason="used defaultSteps; $final_reason"
    else
      final_reason="$final_reason; $MEGABRAIN_CHAIN_SELECTION_REASON"
    fi
    [ "$model_explicit" = true ] && final_reason="$final_reason; explicit --model override"
    [ "$effort_explicit" = true ] && final_reason="$final_reason; explicit --effort override"
    [ -n "$limit_reason" ] && [ "$MEGABRAIN_CHAIN_LIMIT_STATUS" = unknown ] && final_reason="$final_reason; $limit_reason"
    MEGABRAIN_CHAIN_NAME="$report_chain"
    MEGABRAIN_CHAIN_STEP="$index"
    MEGABRAIN_CHAIN_TOTAL="$step_count"
    MEGABRAIN_CHAIN_REASON="$final_reason"
    MEGABRAIN_CHAIN_DEFAULT="$MEGABRAIN_CHAIN_SELECTION_DEFAULT"
    spawn_succeeded=false
    if [ "${#agent_args[@]}" -gt 0 ]; then
      if spawn_output="$(megabrain_chain_run_spawn "$worktree" "$repo" "$branch" "$base" "$slug" "$prompt" "$label" "$tmux_choice" "$model" "$effort" "$agent" "$browser" "${agent_args[@]}" 2>"$error_file")"; then
        spawn_succeeded=true
      fi
    else
      if spawn_output="$(megabrain_chain_run_spawn "$worktree" "$repo" "$branch" "$base" "$slug" "$prompt" "$label" "$tmux_choice" "$model" "$effort" "$agent" "$browser" 2>"$error_file")"; then
        spawn_succeeded=true
      fi
    fi
    if [ "$spawn_succeeded" = true ]; then
      cat "$error_file" >&2
      if printf '%s' "$spawn_output" | jq -e . >/dev/null 2>&1; then
        spawn_json="$spawn_output"
      else
        spawn_json=null
      fi
      dispatch_id="$(printf '%s' "$spawn_json" | jq -r '.dispatchId // empty' 2>/dev/null)"
      if [ -n "$dispatch_id" ]; then
        megabrain_chain_usage_notice_maybe "$dispatch_id"
      fi
      MEGABRAIN_CHAIN_WALK_OUTPUT="$spawn_output"
      MEGABRAIN_CHAIN_WALK_SPAWN_JSON="$spawn_json"
      MEGABRAIN_CHAIN_WALK_AGENT="$agent"
      MEGABRAIN_CHAIN_WALK_STEP="$index"
      MEGABRAIN_CHAIN_WALK_REASON="$final_reason"
      MEGABRAIN_CHAIN_WALK_DISPATCH_ID="$dispatch_id"
      megabrain_dispatch_meta_update_chain_context "$dispatch_id" "$prompt" >/dev/null 2>&1 || true
      MEGABRAIN_CHAIN_WALK_START_INDEX=0
      megabrain_chain_temp_end
      return 0
    fi
    spawn_error="$(cat "$error_file")"
    [ -n "$spawn_error" ] || spawn_error='launch failed'
    failure_reason="$agent launch failed: $spawn_error"
    [ -n "$limit_reason" ] && [ "$MEGABRAIN_CHAIN_LIMIT_STATUS" = unknown ] && failure_reason="$failure_reason; $limit_reason"
    MEGABRAIN_CHAIN_WALK_SKIPPED="$(printf '%s' "$MEGABRAIN_CHAIN_WALK_SKIPPED" | jq --argjson step "$index" --arg agent "$agent" --arg reason "$failure_reason" '. + [{step: $step, agent: $agent, kind: "failure", reason: $reason}]')"
  done < <(printf '%s' "$MEGABRAIN_CHAIN_SELECTED_STEPS" | jq -c '.[]')
  megabrain_chain_temp_end
  MEGABRAIN_CHAIN_WALK_REASON="$(printf '%s' "$MEGABRAIN_CHAIN_WALK_SKIPPED" | jq -r '[.[].reason] | join("; ")')"
  [ -n "$MEGABRAIN_CHAIN_WALK_REASON" ] || MEGABRAIN_CHAIN_WALK_REASON='chain has no usable steps; add a chain with megabrain chain add'
  MEGABRAIN_CHAIN_WALK_START_INDEX=0
  return 1
}

megabrain_chain_continue_refused() {
  local dispatch_id="$1" meta chain_name chain_step chain_total chain_default prompt worktree label runtime config
  local selected_steps
  meta="$(megabrain_dispatch_meta_read "$dispatch_id" 2>/dev/null || true)"
  [ -n "$meta" ] || return 1
  [ "$(printf '%s' "$meta" | jq -r '.reconcileOutcome // empty')" = limit-refused ] || return 1
  chain_name="$(printf '%s' "$meta" | jq -r '.chain.name // empty')"
  chain_step="$(printf '%s' "$meta" | jq -r '.chain.step // empty')"
  chain_total="$(printf '%s' "$meta" | jq -r '.chain.total // empty')"
  chain_default="$(printf '%s' "$meta" | jq -r '.chain.usedDefault // false')"
  prompt="$(printf '%s' "$meta" | jq -r '.chain.prompt // empty')"
  worktree="$(printf '%s' "$meta" | jq -r '.worktreePath // empty')"
  label="$(printf '%s' "$meta" | jq -r '.label // empty')"
  runtime="$(printf '%s' "$meta" | jq -r '.runtime // "host"')"
  case "$chain_step" in
    ''|*[!0-9]*|0) return 1 ;;
  esac
  case "$chain_total" in
    ''|*[!0-9]*|0) return 1 ;;
  esac
  [ -n "$prompt" ] && [ -n "$worktree" ] || return 1
  [ "$chain_step" -lt "$chain_total" ] || return 1
  config="$(megabrain_chain_read)" || return 1
  megabrain_chain_validate_config "$config" || return 1
  if [ "$chain_default" = true ] || [ "$chain_name" = defaultSteps ]; then
    selected_steps="$(printf '%s' "$config" | jq -c '.defaultSteps')"
    MEGABRAIN_CHAIN_SELECTION_DEFAULT=true
    MEGABRAIN_CHAIN_SELECTED_NAME=defaultSteps
  else
    selected_steps="$(printf '%s' "$config" | jq -c --arg name "$chain_name" '.chains[$name].steps // empty')"
    MEGABRAIN_CHAIN_SELECTION_DEFAULT=false
    MEGABRAIN_CHAIN_SELECTED_NAME="$chain_name"
  fi
  [ -n "$selected_steps" ] || return 1
  MEGABRAIN_CHAIN_SELECTED_STEPS="$selected_steps"
  MEGABRAIN_CHAIN_SELECTION_REASON="continued after limit refusal at step $chain_step"
  MEGABRAIN_CHAIN_WALK_START_INDEX="$chain_step"
  case "$runtime" in
    tmux) runtime=tmux ;;
    *) runtime=host ;;
  esac
  megabrain_chain_walk "$worktree" '' '' '' '' "$prompt" "$label" "$runtime" '' '' false false false
}

command_chain_run() {
  local explicit_name="" chain_option="" selection_name="" selection_source=name parent_agent="" parent_model="" parent_effort=""
  local repo="" branch="" base="" slug="" worktree="" prompt="" label="" tmux_choice="" json=false browser=false arg config step_count index step agent model effort until_json threshold window
  local spawn_output spawn_json spawn_error error_file reason limit_reason reset_text failure_reason final_reason report_chain reasons_json spawn_succeeded dispatch_id walk_status
  local -a agent_args=()
  megabrain_resolve_parent_context
  parent_agent="$MEGABRAIN_PARENT_AGENT"
  parent_model="$MEGABRAIN_PARENT_MODEL"
  parent_effort="$MEGABRAIN_PARENT_EFFORT"
  if [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; then
    explicit_name="$1"
    shift
  fi
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --chain)
        [ "$#" -ge 2 ] && [ -n "${2:-}" ] || { megabrain_error '--chain requires a non-empty value'; return "$MEGABRAIN_USAGE_ERROR"; }
        [ -z "$explicit_name" ] || { megabrain_error 'chain run accepts either a positional chain name or --chain, not both'; return "$MEGABRAIN_USAGE_ERROR"; }
        chain_option="$2"
        selection_source=flag
        shift 2
        ;;
      --parent-agent) parent_agent="${2:-}"; shift 2 ;;
      --parent-model) parent_model="${2:-}"; shift 2 ;;
      --parent-effort) parent_effort="${2:-}"; shift 2 ;;
      --repo) repo="${2:-}"; shift 2 ;;
      --branch) branch="${2:-}"; shift 2 ;;
      --base) base="${2:-}"; shift 2 ;;
      --name) slug="${2:-}"; shift 2 ;;
      --worktree) worktree="${2:-}"; shift 2 ;;
      --prompt) prompt="${2:-}"; shift 2 ;;
      --label) label="${2:-}"; shift 2 ;;
      --tmux) tmux_choice="${2:-}"; shift 2 ;;
      --browser) browser=true; shift ;;
      --agent-arg)
        [ "$#" -ge 2 ] && [ -n "${2:-}" ] || { megabrain_error '--agent-arg requires a non-empty value'; return "$MEGABRAIN_USAGE_ERROR"; }
        agent_args+=("$2")
        shift 2
        ;;
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show chain-run; return 0 ;;
      *) megabrain_error "unknown chain run option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  [ -n "$prompt" ] || { megabrain_error '--prompt is required for chain run'; return "$MEGABRAIN_USAGE_ERROR"; }
  if [ -z "$worktree" ]; then
    [ -n "$repo" ] || { megabrain_error '--repo is required for chain run unless --worktree is used'; return "$MEGABRAIN_USAGE_ERROR"; }
    [ -n "$branch" ] || { megabrain_error '--branch is required for chain run unless --worktree is used'; return "$MEGABRAIN_USAGE_ERROR"; }
  fi
  config="$(megabrain_chain_read)" || return 1
  megabrain_chain_validate_config "$config" || return 1
  selection_name="$explicit_name"
  if [ -n "$chain_option" ]; then
    selection_name="$chain_option"
  fi
  megabrain_chain_select "$config" "$selection_name" "$parent_agent" "$parent_model" "$parent_effort" "$selection_source" || return 1
  if [ "${#agent_args[@]}" -gt 0 ]; then
      if megabrain_chain_walk "$worktree" "$repo" "$branch" "$base" "$slug" "$prompt" "$label" "$tmux_choice" "" "" false false "$browser" "${agent_args[@]}"; then
      walk_status=0
    else
      walk_status="$?"
    fi
  elif megabrain_chain_walk "$worktree" "$repo" "$branch" "$base" "$slug" "$prompt" "$label" "$tmux_choice" "" "" false false "$browser"; then
    walk_status=0
  else
    walk_status="$?"
  fi
  step_count="$MEGABRAIN_CHAIN_WALK_TOTAL"
  report_chain="$MEGABRAIN_CHAIN_SELECTED_NAME"
  [ "$MEGABRAIN_CHAIN_SELECTION_DEFAULT" = true ] && report_chain=defaultSteps
  reasons_json="$MEGABRAIN_CHAIN_WALK_SKIPPED"
  if [ "$walk_status" -eq 0 ]; then
    spawn_output="$MEGABRAIN_CHAIN_WALK_OUTPUT"
    spawn_json="$MEGABRAIN_CHAIN_WALK_SPAWN_JSON"
    index="$MEGABRAIN_CHAIN_WALK_STEP"
    agent="$MEGABRAIN_CHAIN_WALK_AGENT"
    final_reason="$MEGABRAIN_CHAIN_WALK_REASON"
    if [ "$json" = true ]; then
      jq -cn --arg chain "$report_chain" --argjson step "$index" --argjson total "$step_count" --arg reason "$final_reason" --argjson skipped "$reasons_json" --arg agent "$agent" --argjson spawn "$spawn_json" '{ok: true, chain: $chain, step: $step, totalSteps: $total, agent: $agent, reason: $reason, skipped: $skipped, dispatch: $spawn}'
    else
      printf 'chain %s, step %s of %s, reason: %s\n' "$report_chain" "$index" "$step_count" "$final_reason"
      printf '%s\n' "$spawn_output"
    fi
    megabrain_chain_clear_dispatch_context
    return 0
  fi
  final_reason="$MEGABRAIN_CHAIN_WALK_REASON"
  megabrain_chain_clear_dispatch_context
  if [ "$json" = true ]; then
    jq -cn --arg chain "$report_chain" --argjson total "$step_count" --arg reason "$final_reason" --argjson skipped "$reasons_json" '{ok: false, chain: $chain, totalSteps: $total, reason: $reason, skipped: $skipped}'
  else
    printf 'chain %s failed after %s steps, reason: %s\n' "$report_chain" "$step_count" "$final_reason"
  fi
  return 1
}

command_chain() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  local subcommand="${1:-}"
  if [ -x "$typescript_binary" ]; then
    case "$subcommand" in
      list|limits|add|edit|delete|repair) "$typescript_binary" chain "$@"; return $? ;;
    esac
  fi
  shift || true
  case "$subcommand" in
    list) command_chain_list "$@" ;;
    limits) command_chain_limits "$@" ;;
    add) command_chain_add "$@" ;;
    edit) command_chain_edit "$@" ;;
    delete) command_chain_delete "$@" ;;
    run) command_chain_run "$@" ;;
    repair) command_chain_repair "$@" ;;
    -h|--help|"")
      megabrain_usage_show chain
      ;;
    *) megabrain_error "unknown chain command: $subcommand"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}
