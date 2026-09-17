#!/usr/bin/env bash

MEGABRAIN_MODEL_TEMPLATE_FILE="${MEGABRAIN_ROOT:-$(cd "$(dirname "$(dirname "${BASH_SOURCE[0]}")")" && pwd -P)}/.megabrain/models.json"
# Keep the model-add vocabulary and embedded-effort diagnostics in one place.
MEGABRAIN_MODEL_REASONING_LEVELS='none minimal low medium high xhigh max ultra'
if [ "${MEGABRAIN_MODEL_FILE+x}" = x ]; then
  MEGABRAIN_MODEL_FILE_EXPLICIT=true
else
  MEGABRAIN_MODEL_FILE_EXPLICIT=false
  MEGABRAIN_MODEL_FILE="$MEGABRAIN_STATE_DIR/models.json"
fi

megabrain_model_upgrade() {
  local tmp
  tmp="$(mktemp "$MEGABRAIN_STATE_DIR/models.XXXXXX")" || return 1
  if ! jq --argjson template "$(cat "$MEGABRAIN_MODEL_TEMPLATE_FILE")" '
    reduce $template.models[] as $template_model (.;
      if any(.models[]; .agent == $template_model.agent and .model == $template_model.model) then
        .models |= map(
          if .agent == $template_model.agent and
             .model == $template_model.model and
             (.provenance.kind // "") != "curated" then
            .reasoning = $template_model.reasoning
          else .
          end
        )
      else
        .models += [$template_model]
      end
    )
  ' "$MEGABRAIN_MODEL_FILE" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if cmp -s "$tmp" "$MEGABRAIN_MODEL_FILE"; then
    rm -f "$tmp"
  else
    mv -f "$tmp" "$MEGABRAIN_MODEL_FILE"
  fi
}

megabrain_model_init() {
  local tmp
  if [ "$MEGABRAIN_MODEL_FILE_EXPLICIT" = false ]; then
    MEGABRAIN_MODEL_FILE="$MEGABRAIN_STATE_DIR/models.json"
  fi
  mkdir -p "$MEGABRAIN_STATE_DIR" || return 1
  [ -f "$MEGABRAIN_MODEL_TEMPLATE_FILE" ] || {
    megabrain_error "model registry template is missing: $MEGABRAIN_MODEL_TEMPLATE_FILE"
    return 1
  }
  if ! jq -e '.version == 1 and (.models | type == "array")' "$MEGABRAIN_MODEL_TEMPLATE_FILE" >/dev/null 2>&1; then
    megabrain_error "model registry template is not valid JSON: $MEGABRAIN_MODEL_TEMPLATE_FILE"
    return 1
  fi
  if [ ! -f "$MEGABRAIN_MODEL_FILE" ]; then
    tmp="$(mktemp "$MEGABRAIN_STATE_DIR/models.XXXXXX")" || return 1
    if ! cp "$MEGABRAIN_MODEL_TEMPLATE_FILE" "$tmp"; then
      rm -f "$tmp"
      return 1
    fi
    mv -f "$tmp" "$MEGABRAIN_MODEL_FILE"
  elif ! jq -e '.version == 1 and (.models | type == "array")' "$MEGABRAIN_MODEL_FILE" >/dev/null 2>&1; then
    megabrain_error "model registry is not valid JSON: $MEGABRAIN_MODEL_FILE"
    return 1
  else
    megabrain_model_upgrade || return 1
  fi
  if ! jq -e '.version == 1 and (.models | type == "array")' "$MEGABRAIN_MODEL_FILE" >/dev/null 2>&1; then
    megabrain_error "model registry is not valid JSON: $MEGABRAIN_MODEL_FILE"
    return 1
  fi
}

megabrain_model_read() {
  megabrain_model_init || return 1
  cat "$MEGABRAIN_MODEL_FILE"
}

megabrain_model_list_ids() {
  local agent="$1" registry
  registry="$(megabrain_model_read)" || return 1
  printf '%s' "$registry" | jq -r --arg agent "$agent" '.models[] | select(.agent == $agent) | .model'
}

megabrain_model_entry() {
  local agent="$1" model="$2" registry
  registry="$(megabrain_model_read)" || return 1
  printf '%s' "$registry" | jq -c --arg agent "$agent" --arg model "$model" \
    '.models[] | select(.agent == $agent and .model == $model)' | head -n 1
}

megabrain_model_known() {
  [ -n "$(megabrain_model_entry "$1" "$2")" ]
}

command_model_list() {
  local json=false arg registry
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --json) json=true; shift ;;
      -h|--help) megabrain_usage_show model-list; return 0 ;;
      *) megabrain_error "unknown model list option: $arg"; return "$MEGABRAIN_USAGE_ERROR" ;;
    esac
  done
  registry="$(megabrain_model_read)" || return 1
  if [ "$json" = true ]; then
    printf '%s\n' "$registry"
  else
    printf '%-10s %-38s %-16s %-11s %-18s %s\n' AGENT MODEL REASONING STATUS MODEL-PROVENANCE EFFORT-PROVENANCE
    # WHY: Model ids and effort spellings have independent evidence.
    printf '%s' "$registry" | jq -r '.models[] | [.agent, .model, (.reasoning.levels | join(",")), (.status // "active"), ((.provenance.kind // "unknown") + " (" + (.provenance.fetchedAt // .provenance.obtainedAt // "undated") + ")"), (.reasoning.provenance.kind // "unknown")] | @tsv' |
      while IFS=$'\t' read -r agent model levels status model_provenance effort_provenance; do
        printf '%-10s %-38s %-16s %-11s %-18s %s\n' "$agent" "$model" "$levels" "$status" "$model_provenance" "$effort_provenance"
      done
  fi
}

# WHY: One dispatcher prevents module load-order shadowing across model features.
command_model() {
  local subcommand="${1:-}"
  shift || true
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  if megabrain_should_use_typescript_binary "${MEGABRAIN_MODEL_IMPLEMENTATION:-}"; then
    "$typescript_binary" model "$subcommand" "$@"
    return $?
  fi
  case "$subcommand" in
    list) command_model_list "$@" ;;
    add) command_model_add "$@" ;;
    refresh) command_model_refresh "$@" ;;
    -h|--help|"") megabrain_usage_show model ;;
    *) megabrain_error "unknown model command: $subcommand"; return "$MEGABRAIN_USAGE_ERROR" ;;
  esac
}
