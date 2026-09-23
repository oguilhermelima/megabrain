#!/usr/bin/env bash

# Thin wrapper: locates the compiled binary and execs `megabrain hook turn-end` with this
# script's own arguments and stdin. All of the hook's decisions, side effects, and never-fail
# behaviour now live in src/cli/commands/hook-turn-end.ts. This file keeps its path because
# installed agent settings (see lib/module-orchestration-hooks.sh) already point at it.

MEGABRAIN_HOOK_RESPONSE='{}'
[ "${MEGABRAIN_HOOK_AGENT:-}" = cursor ] && MEGABRAIN_HOOK_RESPONSE='{"continue":true}'

megabrain_hook_finish() {
  printf '%s\n' "$MEGABRAIN_HOOK_RESPONSE"
  exit 0
}

MEGABRAIN_HOOK_SOURCE="${BASH_SOURCE[0]}"
MEGABRAIN_HOOK_ROOT="$(cd -P "$(dirname "$MEGABRAIN_HOOK_SOURCE")/.." 2>/dev/null && pwd -P)" || megabrain_hook_finish

MEGABRAIN_HOOK_BINARY="$MEGABRAIN_HOOK_ROOT/.build/megabrain"
[ -x "$MEGABRAIN_HOOK_BINARY" ] || megabrain_hook_finish

exec "$MEGABRAIN_HOOK_BINARY" hook turn-end "$@"
