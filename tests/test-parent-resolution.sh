#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-parent-resolution.XXXXXX")"
cleanup() {
  local rc=$?
  rm -rf "$state_dir"
  return "$rc"
}
trap cleanup EXIT

export HOME="$state_dir/home"
export MEGABRAIN_STATE_DIR="$state_dir/state"
mkdir -p "$MEGABRAIN_STATE_DIR"

source "$root/lib/common.sh"
source "$root/lib/module-context.sh"

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

unset SUPERSET_AGENT_ID SUPERSET_AGENT_MODEL SUPERSET_AGENT_EFFORT
export AI_AGENT=claude-code_2-1-270_agent
megabrain_resolve_parent_context
assert_equal "$MEGABRAIN_PARENT_AGENT" claude
assert_equal "$MEGABRAIN_PARENT_MODEL" ''
assert_equal "$MEGABRAIN_PARENT_EFFORT" ''

# chain run is answered by the compiled binary (megabrain_chain_select no longer
# exists in shell), so selection is driven and observed through it as a black box.
# defaultSteps is empty, so the run always fails once selection has picked a chain
# (no usable steps to spawn) — that failure report still names the chosen chain,
# which is all this test needs.
config='{"chains":{"claude-parent":{"when":{"parentAgent":"claude"},"steps":[{"agent":"codex","model":"m","effort":"e"}]}},"defaultSteps":[]}'
printf '%s\n' "$config" >"$MEGABRAIN_CHAIN_FILE"
select_output="$(MEGABRAIN_ROOT="$state_dir" "$root/.build/megabrain" chain run --worktree "$state_dir" --prompt test --json)" || true
assert_equal "$(printf '%s' "$select_output" | jq -r '.chain')" claude-parent
printf 'non-Superset parent selects matching chain\n'

unset AI_AGENT
export CODEX_SESSION_ID=codex-session
megabrain_resolve_parent_context
assert_equal "$MEGABRAIN_PARENT_AGENT" codex
printf 'Codex session identity resolves without Superset\n'
unset CODEX_SESSION_ID

export SUPERSET_AGENT_ID=codex
export SUPERSET_AGENT_MODEL=superset-model
export SUPERSET_AGENT_EFFORT=high
export AI_AGENT=claude-code_2-1-270_agent
megabrain_resolve_parent_context
assert_equal "$MEGABRAIN_PARENT_AGENT" codex
assert_equal "$MEGABRAIN_PARENT_MODEL" superset-model
assert_equal "$MEGABRAIN_PARENT_EFFORT" high
printf 'Superset parent variables retain precedence\n'

unset SUPERSET_AGENT_ID SUPERSET_AGENT_MODEL SUPERSET_AGENT_EFFORT AI_AGENT
megabrain_resolve_parent_context
assert_equal "$MEGABRAIN_PARENT_AGENT" ''
# The "parent agent is unknown; ..." selection reason itself is not observable
# through chain run's report: a defaultSteps fallback always reports "used
# defaultSteps; ..." regardless of why defaultSteps was chosen (module-chain.sh's
# own command_chain_run discarded the selection reason the same way before this
# was migrated). Only the resulting fallback-to-defaultSteps is checked here.
select_output="$(MEGABRAIN_ROOT="$state_dir" "$root/.build/megabrain" chain run --worktree "$state_dir" --prompt test --json)" || true
assert_equal "$(printf '%s' "$select_output" | jq -r '.chain')" defaultSteps
printf 'unknown parent does not match and falls back to defaultSteps\n'

export AI_AGENT=claude-code_2-1-270_agent
megabrain_resolve_parent_context
context_json="$(command_context --json)"
assert_equal "$(printf '%s' "$context_json" | jq -r '.agentId')" claude
unset AI_AGENT
context_json="$(command_context --json)"
assert_equal "$(printf '%s' "$context_json" | jq -r '.agentId')" null
printf 'context reports known parent and preserves unknown\n'

printf 'explicit agent remains outside chain selection\n'
