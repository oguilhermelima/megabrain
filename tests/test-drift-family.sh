#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-drift-family.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$1' to contain '$2'" ;;
  esac
}

assert_missing() {
  [ ! -e "$1" ] || fail "expected path to be absent: $1"
}

installer_source="$work/install-functions.sh"
sed '$d' "$root/install.sh" >"$installer_source"
# shellcheck disable=SC1090
source "$installer_source"
SOURCE_ROOT="$root"

pointer_file="$work/AGENTS.md"
printf '%s\n' '# megabrain recipes (old)' >"$pointer_file"
installer_append_pointer "$pointer_file" '# megabrain recipes (new)' >/dev/null
assert_equal "$(grep -Fxc '# megabrain recipes (old)' "$pointer_file")" 0
assert_equal "$(grep -Fxc '# megabrain recipes (new)' "$pointer_file")" 1
printf 'scenario 1: changed AGENTS pointer replaces the old generated line\n'

agy() {
  case "${1:-}:${2:-}" in
    plugin:list) jq -n '{imports:[{name:"megabrain",source:"claude-code",components:["skills"]}]}' ;;
    *) return 1 ;;
  esac
}
if ! installer_verify_plugin agy; then
  fail 'matching agy import metadata was reported stale'
fi
agy() {
  jq -n '{imports:[{name:"megabrain",source:"other",components:["skills"]}]}'
}
if installer_verify_plugin agy; then
  fail 'drifted agy import source was reported current'
fi
printf 'scenario 2: agy plugin validates import source and components\n'

chain_state="$work/chain-state"
mkdir -p "$chain_state"
export MEGABRAIN_STATE_DIR="$chain_state"
source "$root/lib/common.sh"
source "$root/lib/module-model.sh"
source "$root/lib/module-chain.sh"
printf '%s\n' '{"chains":{},"defaultSteps":[],"usageLimits":{"liveProviders":["claude"],"notice":{"enabled":true}}}' >"$MEGABRAIN_CHAIN_FILE"
megabrain_chain_init
assert_equal "$(jq -r '.usageLimits.cacheTtlSeconds' "$MEGABRAIN_CHAIN_FILE")" 30
assert_equal "$(jq -r '.usageLimits.timeoutSeconds' "$MEGABRAIN_CHAIN_FILE")" 5
assert_equal "$(jq -r '.usageLimits.notice.intervalSeconds' "$MEGABRAIN_CHAIN_FILE")" 3600
assert_equal "$(jq -r '.usageLimits.notice.enabled' "$MEGABRAIN_CHAIN_FILE")" true
printf 'scenario 3: chain initialization reconciles newly seeded usage-limit fields\n'

tmux_state="$work/tmux-state"
mkdir -p "$tmux_state/sessions"
export MEGABRAIN_STATE_DIR="$tmux_state"
MEGABRAIN_TMUX_SESSION_DIR="$tmux_state/sessions"
source "$root/lib/module-tmux-runtime.sh"
printf '%s\n' '{"tmuxSession":"broken"}' >"$MEGABRAIN_TMUX_SESSION_DIR/broken.json"
assert_contains "$(megabrain_tmux_session_registry_drift)" broken.json
megabrain_tmux_available() { return 0; }
megabrain_tmux_version() { printf 'tmux 3.5\n'; }
megabrain_runtime_enabled() { return 0; }
megabrain_tmux_tuning_config_path() { printf '%s/tmux.conf\n' "$MEGABRAIN_STATE_DIR"; }
megabrain_tmux_wrapper_config_path() { printf '%s/.zshrc\n' "$MEGABRAIN_STATE_DIR"; }
megabrain_tmux_tuning_block_present() { return 0; }
megabrain_tmux_tuning_installed_current() { return 0; }
megabrain_tmux_wrapper_block_present() { return 0; }
megabrain_tmux_wrapper_installed_current() { return 0; }
megabrain_tmux_tuning_server_running() { return 1; }
megabrain_tmux_config_applied() { return 1; }
if module_tmux_runtime_doctor >/dev/null 2>&1; then
  fail 'tmux doctor reported ok with a malformed session registry record'
fi
assert_contains "$MODULE_REASON" 'session registry'
printf 'scenario 4: malformed session registry makes tmux doctor non-ok\n'

manifest="$work/install-manifest.json"
INSTALL_MANIFEST="$manifest"
SELECTED_AGENTS=claude
SELECTED_MODULES=tmux-runtime
SKILL_MODE=global
AGENTS_MODE=global
jq -n '{agents:["codex"],modules:["tmux-runtime"],skill:"global",agentsMd:"global"}' >"$manifest"
if installer_manifest_matches_selection; then
  fail 'drifted install manifest was reported current'
fi
printf '%s\n' '{"agents":["claude"],"modules":["tmux-runtime"],"skill":"global","agentsMd":"global"}' >"$manifest"
if ! installer_manifest_matches_selection; then
  fail 'matching install manifest was reported stale'
fi
printf 'scenario 5: install manifest compares selected configuration fields\n'

dispatch_state="$work/dispatch-state"
export MEGABRAIN_STATE_DIR="$dispatch_state"
export MEGABRAIN_DISPATCH_DIR="$dispatch_state/dispatches"
export MEGABRAIN_ROOT="$root"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
mkdir -p "$MEGABRAIN_DISPATCH_DIR"
megabrain_dispatch_meta_write missing-terminal parent-terminal superset superset workspace child-terminal \
  "$root" main codex label spawning gpt-5 true codex '' '' host ide >/dev/null
megabrain_dispatch_meta_update_process_state missing-terminal start-unproven
megabrain_dispatch_meta_update_state missing-terminal running
megabrain_dispatch_meta_update_terminal_state missing-terminal retained
megabrain_dispatch_terminal_status() { MEGABRAIN_TERMINAL_STATUS=missing; }
megabrain_dispatch_reconcile_one missing-terminal
assert_equal "$(jq -r '.terminalState' "$MEGABRAIN_DISPATCH_DIR/missing-terminal/meta.json")" missing
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/missing-terminal/meta.json")" failed

megabrain_dispatch_meta_write running-live parent-terminal superset superset workspace child-terminal \
  "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
old='2020-01-01T00:00:00Z'
for dispatch_id in missing-terminal running-live; do
  jq --arg old "$old" '.createdAt=$old | .updatedAt=$old' \
    "$MEGABRAIN_DISPATCH_DIR/$dispatch_id/meta.json" >"$work/$dispatch_id.json"
  mv "$work/$dispatch_id.json" "$MEGABRAIN_DISPATCH_DIR/$dispatch_id/meta.json"
done
dry_run="$("$root/.build/megabrain" orchestrate prune --dry-run --json)"
assert_equal "$(jq -r '.archived' <<<"$dry_run")" 1
assert_equal "$(jq -r '.dryRun' <<<"$dry_run")" true
assert_contains "$dry_run" 'missing-terminal'
assert_missing "$MEGABRAIN_DISPATCH_DIR/archive"
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/running-live/meta.json")" running
printf 'scenario 6: reconcile settles missing terminals, dry-run lists only terminal debris, and running stays\n'

printf 'ok: drift family scenarios\n'
