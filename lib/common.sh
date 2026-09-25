#!/usr/bin/env bash

MEGABRAIN_USAGE_ERROR=2

megabrain_error() {
  printf 'megabrain: %s\n' "$*" >&2
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

# WHY: the plugin manifest is the version the marketplaces publish, and it ships
# next to this script, so reading it keeps one number instead of two that drift.
megabrain_version() {
  local manifest="${MEGABRAIN_ROOT:-}/.claude-plugin/plugin.json" version=''
  [ -f "$manifest" ] && version="$(jq -r '.version // empty' "$manifest" 2>/dev/null || true)"
  printf 'megabrain %s\n' "${version:-unknown}"
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
    web-capture) printf 'web capture --url URL --screen NAME [--settle default|scroll] [--scroll-timeout MS] [options]' ;;
    web-measure) printf 'web measure --url URL --screen NAME [--settle default|scroll] [--scroll-timeout MS] [options]' ;;
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

# WHY: a file that cannot be parsed used to fail this read exactly like an absent flag, so
# every spawn silently dropped from a tmux pane to an IDE tab and doctor blamed the module
# instead of the file. An unreadable state file is a different answer from a disabled one
# and has to say so.
