#!/usr/bin/env bash

megabrain_model_error_unknown() {
  local agent="$1" model="$2" id
  megabrain_error "unknown model '$model' for agent '$agent'. Valid model ids:"
  while IFS= read -r id; do
    [ -n "$id" ] && megabrain_error "  $id"
  done < <(megabrain_model_list_ids "$agent")
}

megabrain_model_effort_separate() {
  local entry
  entry="$(megabrain_model_entry "$1" "$2")"
  [ -n "$entry" ] || return 1
  [ "$(printf '%s' "$entry" | jq -r '.reasoning.separateAxis')" = true ]
}

megabrain_model_warn_lifecycle() {
  local agent="$1" model="$2" entry status retirement_date
  entry="$(megabrain_model_entry "$agent" "$model")"
  status="$(printf '%s' "$entry" | jq -r '.status // "active"')"
  case "$status" in
    retired|deprecated)
      retirement_date="$(printf '%s' "$entry" | jq -r '.retirementDate // empty')"
      if [ -n "$retirement_date" ]; then
        megabrain_error "Warning: model '$model' for agent '$agent' is $status (retirement date: $retirement_date)."
      else
        megabrain_error "Warning: model '$model' for agent '$agent' is $status."
      fi
      ;;
  esac
}

megabrain_model_validate_step() {
  local chain="$1" index="$2" agent="$3" model="$4" effort="$5"
  if ! megabrain_model_known "$agent" "$model"; then
    megabrain_model_error_unknown "$agent" "$model"
    megabrain_error "invalid chain $chain step $index: model '$model' is not registered for agent '$agent'"
    return 1
  fi
  megabrain_model_warn_lifecycle "$agent" "$model"
  megabrain_model_validate_reasoning "$agent" "$model" "$effort" || {
    megabrain_error "invalid chain $chain step $index: unsupported reasoning level '$effort' for model '$model'"
    return 1
  }
}
