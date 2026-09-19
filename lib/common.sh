#!/usr/bin/env bash

MEGABRAIN_USAGE_ERROR=2
MEGABRAIN_STATE_DIR_EXPLICIT=false
if [ "${MEGABRAIN_STATE_DIR+x}" = x ]; then
  MEGABRAIN_STATE_DIR_EXPLICIT=true
else
  MEGABRAIN_STATE_DIR="$HOME/.megabrain"
fi
MEGABRAIN_STATE_FILE="$MEGABRAIN_STATE_DIR/state.json"
MEGABRAIN_CHAIN_FILE="$MEGABRAIN_STATE_DIR/chains.json"
MEGABRAIN_DISPATCH_DIR="$MEGABRAIN_STATE_DIR/dispatches"
MEGABRAIN_TMUX_SESSION_DIR="$MEGABRAIN_STATE_DIR/sessions"
MEGABRAIN_TERMINAL_DIR="${MEGABRAIN_TERMINAL_DIR:-$MEGABRAIN_STATE_DIR/terminals}"
MEGABRAIN_SHARED_ROOT=""
MEGABRAIN_SESSION_ID=""
MEGABRAIN_SESSION_HOST=""
MODULE_STATUS=""
MODULE_REASON=""
MODULE_DETAILS=""
MODULE_UNCERTAIN_DISPATCHES=0
MODULE_RETAINED_TERMINALS=0
MODULE_LEAKED_DISPATCH_SESSIONS=0
MODULE_PRUNABLE_DISPATCHES=0
MEGABRAIN_STATE_RECONCILIATION=""
MEGABRAIN_PARENT_AGENT=""
MEGABRAIN_PARENT_MODEL=""
MEGABRAIN_PARENT_EFFORT=""
MEGABRAIN_PARENT_REASON=""
MEGABRAIN_DISPATCH_OPEN_STATES='spawning
running
waiting_for_reply'

# Resolve the session's parent once for all callers. Superset exposes the complete
# tuple directly; other hosts expose the agent descriptor through AI_AGENT and may
# expose the remaining fields through the corresponding AI_* variables. A versioned
# descriptor is accepted only when its provider and shape are known.
megabrain_resolve_parent_context() {
  local descriptor="${AI_AGENT:-}" identity=""
  MEGABRAIN_PARENT_AGENT="${SUPERSET_AGENT_ID:-}"
  MEGABRAIN_PARENT_MODEL="${SUPERSET_AGENT_MODEL:-}"
  MEGABRAIN_PARENT_EFFORT="${SUPERSET_AGENT_EFFORT:-}"
  MEGABRAIN_PARENT_REASON=""

  if [ -z "$MEGABRAIN_PARENT_AGENT" ]; then
    case "$descriptor" in
      claude|codex|agy) identity="$descriptor" ;;
    esac
    if [[ "$descriptor" =~ ^claude-code_[0-9]+-[0-9]+-[0-9]+_agent$ ]]; then
      identity=claude
    elif [[ "$descriptor" =~ ^codex_[0-9]+-[0-9]+-[0-9]+_agent$ ]]; then
      identity=codex
    elif [[ "$descriptor" =~ ^agy_[0-9]+-[0-9]+-[0-9]+_agent$ ]]; then
      identity=agy
    elif [ -z "$descriptor" ] && [ -n "${CODEX_SESSION_ID:-}" ]; then
      identity=codex
    fi
    MEGABRAIN_PARENT_AGENT="$identity"
  fi
  [ -n "$MEGABRAIN_PARENT_MODEL" ] || MEGABRAIN_PARENT_MODEL="${AI_MODEL:-}"
  [ -n "$MEGABRAIN_PARENT_EFFORT" ] || MEGABRAIN_PARENT_EFFORT="${AI_EFFORT:-}"
  if [ -n "$MEGABRAIN_PARENT_AGENT" ]; then
    MEGABRAIN_PARENT_REASON="parent resolved as $MEGABRAIN_PARENT_AGENT"
  elif [ -n "$descriptor" ]; then
    MEGABRAIN_PARENT_REASON="parent agent is unknown: unrecognised AI_AGENT descriptor"
  else
    MEGABRAIN_PARENT_REASON="parent agent is unknown: no host identity was provided"
  fi
}

megabrain_dispatch_state_is_open() {
  [ -n "${1:-}" ] || return 1
  printf '%s\n' "$MEGABRAIN_DISPATCH_OPEN_STATES" | grep -Fx "$1" >/dev/null 2>&1
}

megabrain_dispatch_open_states_json() {
  printf '%s\n' "$MEGABRAIN_DISPATCH_OPEN_STATES" | jq -Rsc 'split("\n") | map(select(length > 0))'
}

megabrain_error() {
  printf 'megabrain: %s\n' "$*" >&2
}

megabrain_info() {
  printf '%s\n' "$*"
}

# WHY: advice is not a result. Keeping it off stdout is what lets --json callers
# capture a module's output without a human sentence landing inside the JSON.
megabrain_notice() {
  printf '%s\n' "$*" >&2
}

MEGABRAIN_BINARY_FRESHNESS_WARNING_SHOWN=false

megabrain_warn_if_typescript_binary_stale() {
  local typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  local source_directory="${MEGABRAIN_ROOT:-}/src" newer_source=''
  # WHY: binary-only wrappers call this after their missing-binary refusal; keeping freshness
  # separate from routing preserves the notice when a migrated verb has no shell fallback.
  if [ "${MEGABRAIN_SKIP_BINARY_FRESHNESS_CHECK:-false}" != true ] &&
    [ "${MEGABRAIN_BINARY_FRESHNESS_WARNING_SHOWN:-false}" != true ] &&
    [ -x "$typescript_binary" ] && [ -d "$source_directory" ]; then
    newer_source="$(find "$source_directory" -name '*.ts' -newer "$typescript_binary" -print -quit 2>/dev/null || true)"
    if [ -n "$newer_source" ]; then
      megabrain_notice "compiled binary is stale; newer source: $newer_source; run bun run build"
      MEGABRAIN_BINARY_FRESHNESS_WARNING_SHOWN=true
    fi
  fi
}

megabrain_should_use_typescript_binary() {
  local implementation="${1:-}" typescript_binary="${MEGABRAIN_ROOT:-}/.build/megabrain"
  [ -x "$typescript_binary" ] || return 1
  [ "$implementation" != shell ] || return 1
  megabrain_warn_if_typescript_binary_stale
  return 0
}

megabrain_require_command() {
  command -v "$1" >/dev/null 2>&1
}

# WHY: the plugin manifest is the version the marketplaces publish, and it ships
# next to this script, so reading it keeps one number instead of two that drift.
megabrain_version() {
  local manifest="${MEGABRAIN_ROOT:-}/.claude-plugin/plugin.json" version=''
  [ -f "$manifest" ] && version="$(jq -r '.version // empty' "$manifest" 2>/dev/null || true)"
  printf 'megabrain %s\n' "${version:-unknown}"
}

megabrain_superset_binary() {
  local path
  path="$(type -P superset 2>/dev/null || true)"
  if [ -n "$path" ]; then
    printf '%s\n' "$path"
  elif [ -x "$HOME/.superset/bin/superset" ]; then
    printf '%s\n' "$HOME/.superset/bin/superset"
  fi
}

megabrain_superset_available() {
  [ -n "$(megabrain_superset_binary)" ]
}

megabrain_superset() {
  local binary
  binary="$(megabrain_superset_binary)"
  [ -n "$binary" ] || return 127
  "$binary" "$@"
}

# WHY the output is validated instead of the exit status: GNU stat accepts -f and succeeds
# with filesystem information, so an || fallback never fires on Linux and the answer comes
# back as a paragraph of text. Each form is tried and kept only if it produced a number.
megabrain_path_mtime() {
  local path="$1" mtime
  mtime="$(stat -c %Y "$path" 2>/dev/null || true)"
  [[ "$mtime" =~ ^[0-9]+$ ]] || mtime="$(stat -f %m "$path" 2>/dev/null || true)"
  [[ "$mtime" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$mtime"
}

megabrain_iso_now() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

# WHY it lives here and not with the dispatch code: megabrain_session_id needs it, and
# common.sh is the one file every entry point sources. Defined anywhere else, a caller
# that loads only this file gets an unknown host instead of a tmux one, silently.

# WHY it lives here and not with the dispatch code: megabrain_session_id needs it, and
# common.sh is the one file every entry point sources. Defined anywhere else, a caller
# that loads only this file gets an unknown host instead of a tmux one, silently.
megabrain_dispatch_tmux_caller_session() {
  [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] || return 1
  tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null
}

megabrain_session_id() {
  local tmux_session
  MEGABRAIN_SESSION_ID=""
  MEGABRAIN_SESSION_HOST="unknown"
  if [ -n "${SUPERSET_TERMINAL_ID:-}" ]; then
    MEGABRAIN_SESSION_ID="$SUPERSET_TERMINAL_ID"
    MEGABRAIN_SESSION_HOST="superset"
  elif [ -n "${ORCA_TERMINAL_HANDLE:-}" ]; then
    MEGABRAIN_SESSION_ID="$ORCA_TERMINAL_HANDLE"
    MEGABRAIN_SESSION_HOST="orca"
  elif [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ]; then
    tmux_session="$(megabrain_dispatch_tmux_caller_session 2>/dev/null || true)"
    if [ -n "$tmux_session" ]; then
      MEGABRAIN_SESSION_ID="$tmux_session:$TMUX_PANE"
      MEGABRAIN_SESSION_HOST="tmux"
    fi
  fi
  printf '%s\n' "$MEGABRAIN_SESSION_ID"
}

megabrain_state_init() {
  mkdir -p "$MEGABRAIN_STATE_DIR" || return 1
  if [ ! -f "$MEGABRAIN_STATE_FILE" ]; then
    printf '{}\n' >"$MEGABRAIN_STATE_FILE"
  elif ! jq empty "$MEGABRAIN_STATE_FILE" >/dev/null 2>&1; then
    megabrain_error "state file is not valid JSON: $MEGABRAIN_STATE_FILE"
    return 1
  fi
}

megabrain_state_set() {
  local module="$1"
  local installed="$2"
  local details="$3"
  local configured_at
  local tmp

  megabrain_state_init || return 1
  configured_at="$(megabrain_iso_now)"
  tmp="$(mktemp "$MEGABRAIN_STATE_DIR/state.XXXXXX")" || return 1
  if ! jq --arg moduleName "$module" \
    --argjson installed "$installed" \
    --arg configuredAt "$configured_at" \
    --arg details "$details" \
    '._meta = {kind: "installation-record", recordedAt: $configuredAt, source: "megabrain install", liveStatusCommand: "megabrain doctor"} |
     .[$moduleName] = {installed: $installed, configuredAt: $configuredAt, statusSource: "megabrain install", details: $details}' \
    "$MEGABRAIN_STATE_FILE" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$MEGABRAIN_STATE_FILE"
}

megabrain_state_recorded_status() {
  local module="$1" recorded
  [ -f "$MEGABRAIN_STATE_FILE" ] || {
    printf 'unknown\n'
    return 0
  }
  recorded="$(jq -r --arg moduleName "$module" '
    if ((.[$moduleName] // null) | type) == "object" and (.[$moduleName].installed | type) == "boolean" then
      .[$moduleName].installed | tostring
    else
      "unknown"
    end
  ' "$MEGABRAIN_STATE_FILE" 2>/dev/null || printf 'unknown\n')"
  case "$recorded" in
    true|false) printf '%s\n' "$recorded" ;;
    *) printf 'unknown\n' ;;
  esac
}

megabrain_state_reconcile() {
  local module="$1"
  local observed_status="$2"
  local details="$3"
  local recorded_status checked_at tmp

  MEGABRAIN_STATE_RECONCILIATION=""
  recorded_status="$(megabrain_state_recorded_status "$module")"
  megabrain_state_init || return 1
  checked_at="$(megabrain_iso_now)"
  tmp="$(mktemp "$MEGABRAIN_STATE_DIR/state.XXXXXX")" || return 1
  if ! jq --arg moduleName "$module" \
    --arg observedStatus "$observed_status" \
    --arg checkedAt "$checked_at" \
    --arg details "$details" \
    'if (._meta // null) == null then
       ._meta = {kind: "installation-record", recordedAt: $checkedAt, source: "megabrain doctor", liveStatusCommand: "megabrain doctor"}
     else . end |
     .[$moduleName] = ((.[$moduleName] // {}) +
       (if $observedStatus == "unknown" then {}
        else {installed: ($observedStatus == "ok")}
        end) + {
          checkedAt: $checkedAt,
          status: $observedStatus,
          statusSource: "megabrain doctor",
          details: $details
        })' \
    "$MEGABRAIN_STATE_FILE" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$MEGABRAIN_STATE_FILE" || return 1

  if [ "$observed_status" = unknown ]; then
    MEGABRAIN_STATE_RECONCILIATION="state check unknown: $module installed state preserved"
  else
    local installed=false
    [ "$observed_status" = ok ] && installed=true
    if [ "$recorded_status" != "$installed" ]; then
      if [ "$recorded_status" = unknown ]; then
        MEGABRAIN_STATE_RECONCILIATION="state reconciled: $module recorded as installed=$installed"
      else
        MEGABRAIN_STATE_RECONCILIATION="state reconciled: $module installed $recorded_status -> $installed"
      fi
    fi
  fi
}

# WHY: one string per command. Help output, group listings and missing-argument
# errors all read from here, so the three cannot drift apart the way they did while
# each site carried its own copy.
megabrain_usage_line() {
  case "$1" in
    install) printf 'install [module-id] [--browser chromium|firefox|both] [--yes] [--revert]' ;;
    doctor) printf 'doctor [module-id] [--json]' ;;
    context) printf 'context [--json]' ;;
    worktree) printf 'worktree create|pr|finish|list|adopt ...' ;;
    worktree-create) printf 'worktree create --repo <name|path> --branch <branch> [--from <ref>] [--base <ref>] [--parent <branch:branch|path:path>] [--no-parent] [--issue <number>] [--linear-issue <identifier-or-url>] [--pr <number>] [--name <slug>] [--agent <id>] [--model <id>] [--effort <level>] [--prompt <text>] [--label <text>] [--tmux true|false] [--agent-arg <flag>] [--json]' ;;
    worktree-pr) printf 'worktree pr <branch|path|slug> [--base <ref>] [--title <text>] [--body <text>] [--json]' ;;
    worktree-finish) printf 'worktree finish <branch|path|slug> [--delete-branch] [--base <ref>] [--force] [--json]' ;;
    worktree-list) printf 'worktree list [--repo <name|path>] [--tree|--flat] [--json]' ;;
    worktree-adopt) printf 'worktree adopt <path|branch> [--json]' ;;
    terminal-create) printf 'terminal create [--worktree <path>] [--command <cmd>] [--title <text>] [--port <port>] [--json]' ;;
    terminal-list) printf 'terminal list [--worktree <path>] [--json]' ;;
    terminal-restart) printf 'terminal restart <selector> [--command <cmd>] [--wait-port <port>] [--timeout <seconds>] [--json]' ;;
    terminal-close) printf 'terminal close <selector> [--json]' ;;
    orchestrate-spawn) printf 'orchestrate spawn --repo <name|path> --branch <branch> [--agent <id>] [--chain <name>] [--model <id>] [--base <ref>] [--name <slug>] [--effort <level>] [--prompt <text>] [--label <text>] [--worktree <path>] [--tmux true|false] [--browser] [--agent-arg <flag>] [--json]' ;;
    orchestrate-list) printf 'orchestrate list [--all|--orphans|--uncertain] [--json]' ;;
    orchestrate-prune) printf 'orchestrate prune [--older-than <days>] [--state <list>] [--archive|--delete] [--dry-run] [--json]' ;;
    orchestrate-reconcile) printf 'orchestrate reconcile <dispatch-id> [--all] [--json]' ;;
    orchestrate-liveness) printf 'orchestrate liveness <dispatch-id> [--json]' ;;
    orchestrate-watch) printf 'orchestrate watch <dispatch-id> [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode nudge|poll] [--consumer <id>] [--generation <number>] [--full] [--json]' ;;
    orchestrate-read) printf 'orchestrate read <dispatch-id> [--lines <count>] [--json]' ;;
    orchestrate-ack) printf 'orchestrate ack <dispatch-id> <delivery-id> [--consumer <id>] [--generation <number>] [--close] [--json]' ;;
    orchestrate-reply) printf 'orchestrate reply <dispatch-id> --text <answer> [--supersede] [--json]' ;;
    orchestrate-stop) printf 'orchestrate stop <dispatch-id> [--json]' ;;
    orchestrate-change) printf 'orchestrate change <dispatch-id> --text <text> [--json]' ;;
    orchestrate-close) printf 'orchestrate close <dispatch-id> [--force-release] [--json]' ;;
    ask) printf 'ask "question"' ;;
    done) printf 'done "summary"' ;;
    received) printf 'received' ;;
    check) printf 'check [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode poll] [--consumer <id>] [--generation <number>] [--full] [--json]' ;;
    ack) printf 'ack <delivery-id> [--consumer <id>] [--generation <number>] [--json]' ;;
    chain) printf 'chain list|limits|add|edit|delete|run|repair ...' ;;
    chain-list) printf 'chain list [--json]' ;;
    chain-limits) printf 'chain limits [--json] [--enable <providers>] [--disable <providers>] [--notice-on|--notice-off] [--notice-interval <seconds>]' ;;
    chain-add) printf 'chain add <name> --when <json> --steps <json> [--step <json>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--allow-unknown-model] [--json]' ;;
    chain-edit) printf 'chain edit <name> [--allow-unknown-model] [--json]' ;;
    chain-delete) printf 'chain delete <name> [--json]' ;;
    chain-repair) printf 'chain repair <name> --step <number> --model <id> [--effort <level>] [--json]' ;;
    chain-run) printf 'chain run [name] [--chain <name>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--repo <name|path>] [--branch <branch>] [--base <ref>] [--name <slug>] [--worktree <path>] [--prompt <text>] [--label <text>] [--tmux true|false] [--browser] [--agent-arg <flag>] [--json]' ;;
    model) printf 'model list|add|refresh ...' ;;
    model-list) printf 'model list [--json]' ;;
    model-add) printf 'model add <agent> <model> --reasoning <levels>' ;;
    model-refresh) printf 'model refresh <agent>' ;;
    fact) printf 'fact list|add|edit|remove ...' ;;
    fact-list) printf 'fact list [--json]' ;;
    fact-add) printf 'fact add <id> --measurement <text> --who <name> --when <timestamp> --command <command> [--scope global|repository] [--repository <id>] [--json]' ;;
    fact-edit) printf 'fact edit <id> [--json]' ;;
    fact-remove) printf 'fact remove <id> [--json]' ;;
    native-appium) printf 'native appium start|stop|status' ;;
    native-sim-list) printf 'native sim list <phone|tv> [--json]' ;;
    native-runtime-list) printf 'native runtime list [<ios|tvos>] (--installed|--available) [--json]' ;;
    native-runtime-install) printf 'native runtime install <ios|tvos> <version> [--json]' ;;
    native-sim-ensure) printf 'native sim ensure <phone|tv> [--device <name-or-udid>] [--timeout <seconds>] [--json]' ;;
    native-app-reload) printf 'native app reload <phone|tv> [--route <r>] [--bundle-id <id>] [--url-template <tpl>] [--device <name-or-udid>] [--metro-port <p>] [--timeout <s>] [--json]' ;;
    native-health) printf 'native health <phone|tv> [--bundle-id <id>] [--device <name-or-udid>] [--metro-port <p>] [--control-frame <path>] [--json]' ;;
    native-crashes) printf 'native crashes <phone|tv> [--last N] [--json]' ;;
    native-build) printf 'native build <phone|tv> [--runtime <version>] [--json]' ;;
    tv-connect) printf 'tv connect <ip> [--port <port>]' ;;
    tv-disconnect) printf 'tv disconnect [<ip>]' ;;
    tmux-tune) printf 'tmux tune [--yes] [--dry-run] [--revert] [--json]' ;;
    tmux-wrapper) printf 'tmux wrapper [--yes] [--dry-run] [--revert] [--json]' ;;
    web) printf 'web [--device SLUG|--category NAME|--viewport WxH] ...' ;;
    web-capture) printf 'web capture --url URL --screen NAME [options]' ;;
    web-measure) printf 'web measure --url URL --screen NAME [options]' ;;
    web-session) printf 'web session save --url URL --output FILE [options]' ;;
    web-viewport) printf 'web viewport set|show|devices ...' ;;
    web-viewport-set) printf 'web viewport set [--browser chromium|firefox|both] [--viewport WxH|--device SLUG|--category NAME|--width W --height H] [--orientation portrait|landscape]' ;;
    web-viewport-show) printf 'web viewport show [--browser chromium|firefox|both]' ;;
    web-devices) printf 'web devices list [FILTER] [--orientation portrait|landscape|all] | add SLUG --viewport WxH --source SOURCE [options] | remove SLUG' ;;
    web-userscript) printf 'web userscript install|list|remove ...' ;;
    web-userscript-install) printf 'web userscript install <file.user.js> [--viewport WxH|--device SLUG|--category NAME] [--orientation portrait|landscape]' ;;
    web-userscript-list) printf 'web userscript list' ;;
    web-userscript-remove) printf 'web userscript remove <file.user.js> [--viewport WxH|--device SLUG|--category NAME] [--orientation portrait|landscape]' ;;
    *) return 1 ;;
  esac
}

megabrain_usage_show() {
  local key first=true
  for key in "$@"; do
    if [ "$first" = true ]; then
      printf 'Usage: megabrain %s\n' "$(megabrain_usage_line "$key")"
      first=false
    else
      printf '       megabrain %s\n' "$(megabrain_usage_line "$key")"
    fi
  done
}

megabrain_usage_fail() {
  megabrain_error "Usage: megabrain $(megabrain_usage_line "$1")"
  return "$MEGABRAIN_USAGE_ERROR"
}

megabrain_set_status() {
  MODULE_STATUS="$1"
  MODULE_REASON="$2"
  MODULE_DETAILS="${3:-$2}"
}

megabrain_status_line() {
  printf '%-18s %s: %s\n' "$1" "$2" "$3"
}

megabrain_bool_json() {
  case "$1" in
    true|1|yes) printf 'true\n' ;;
    *) printf 'false\n' ;;
  esac
}

megabrain_trim() {
  awk '{$1=$1; print}'
}

megabrain_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

megabrain_validate_module() {
  case "$1" in
    orchestration|orchestration-hooks|worktree|simulator-web|simulator-native|simulator-tv|tv-adb|tmux-runtime|skill-sync) return 0 ;;
    *) return 1 ;;
  esac
}

megabrain_module_ids() {
  printf '%s\n' orchestration orchestration-hooks worktree simulator-web simulator-native simulator-tv tv-adb tmux-runtime skill-sync
}

# WHY: a file that cannot be parsed used to fail this read exactly like an absent flag, so
# every spawn silently dropped from a tmux pane to an IDE tab and doctor blamed the module
# instead of the file. An unreadable state file is a different answer from a disabled one
# and has to say so.
megabrain_runtime_enabled() {
  [ -f "$MEGABRAIN_STATE_FILE" ] || return 1
  if ! jq empty "$MEGABRAIN_STATE_FILE" >/dev/null 2>&1; then
    megabrain_notice "state file is not valid JSON, treating every module as uninstalled: $MEGABRAIN_STATE_FILE"
    return 1
  fi
  jq -e '."tmux-runtime".installed == true' "$MEGABRAIN_STATE_FILE" >/dev/null 2>&1
}

megabrain_backup_path() {
  local path="$1" stamp suffix=1 backup
  [ -f "$path" ] || return 0
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  backup="${path}.megabrain-backup-${stamp}"
  while [ -e "$backup" ]; do
    backup="${path}.megabrain-backup-${stamp}-${suffix}"
    suffix=$((suffix + 1))
  done
  printf '%s\n' "$backup"
}

megabrain_backup_file() {
  local path="$1" backup
  [ -f "$path" ] || return 0
  backup="$(megabrain_backup_path "$path")"
  cp -p "$path" "$backup" || return 1
  MEGABRAIN_LAST_BACKUP_PATH="$backup"
  printf '%s\n' "$backup"
}

megabrain_latest_backup() {
  local path="$1" candidate latest=''
  for candidate in "${path}.megabrain-backup-"*; do
    [ -f "$candidate" ] || continue
    [ -z "$latest" ] || [ "$candidate" ">" "$latest" ] || continue
    latest="$candidate"
  done
  [ -n "$latest" ] || return 1
  printf '%s\n' "$latest"
}
