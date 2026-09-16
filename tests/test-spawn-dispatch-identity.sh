#!/usr/bin/env bash
set -euo pipefail

# Scenarios written before implementation: a tmux spawn reports the durable dispatch id and
# pane from metadata, and a host spawn reports an explicit null pane.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-spawn-identity.XXXXXX")"
trap 'rm -rf "$state"' EXIT

export MEGABRAIN_ROOT="$root"
export MEGABRAIN_STATE_DIR="$state"
export MEGABRAIN_SESSION_ID=parent-terminal
export MEGABRAIN_SESSION_HOST=superset
export SUPERSET_TERMINAL_ID=parent-terminal

source "$root/lib/common.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-worktree.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

megabrain_workspace_id_for_target() { printf 'workspace-test\n'; }
megabrain_resolve_spawn_runtime() {
  MEGABRAIN_SPAWN_RUNTIME="${1:-auto}"
  [ "$MEGABRAIN_SPAWN_RUNTIME" = false ] && MEGABRAIN_SPAWN_RUNTIME=host
  [ "$MEGABRAIN_SPAWN_RUNTIME" = true ] && MEGABRAIN_SPAWN_RUNTIME=tmux
  MEGABRAIN_SPAWN_CONTEXT=superset
}
megabrain_launch_agent() {
  local dispatch_id="dispatch-identity-test"
  local runtime="${MEGABRAIN_SPAWN_RUNTIME:-host}"
  local pane=""
  [ "$runtime" = tmux ] && pane='%42'
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal superset superset workspace-test \
    child-terminal "$root" main codex label spawning gpt-5 true codex child-session "$pane" \
    "$runtime" "$runtime" >/dev/null
  MEGABRAIN_LAST_DISPATCH="$dispatch_id"
  MEGABRAIN_LAST_SPAWN_RUNTIME="$runtime"
}

tmux_json="$(command_orchestrate spawn --worktree "$root" --agent codex --model gpt-5 --effort medium \
  --prompt identity-test --tmux true --json)"
[ "$(printf '%s' "$tmux_json" | jq -r '.dispatch')" = dispatch-identity-test ] || fail 'spawn omitted dispatch id'
[ "$(printf '%s' "$tmux_json" | jq -r '.tmuxPane')" = '%42' ] || fail 'spawn omitted tmux pane'
printf 'tmux spawn reports dispatch id and pane\n'

host_json="$(command_orchestrate spawn --worktree "$root" --agent codex --model gpt-5 --effort medium \
  --prompt identity-test --tmux false --json)"
[ "$(printf '%s' "$host_json" | jq -r '.dispatch')" = dispatch-identity-test ] || fail 'host spawn omitted dispatch id'
[ "$(printf '%s' "$host_json" | jq -r '.tmuxPane')" = null ] || fail 'host spawn did not report null tmux pane'
printf 'host spawn reports explicit null pane\n'
