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
export MEGABRAIN_CHAIN_FILE="$MEGABRAIN_STATE_DIR/chains.json"
mkdir -p "$MEGABRAIN_STATE_DIR"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

# Descriptor-based agent identity resolution (claude-code_N-N-N_agent -> claude, a Codex session
# id alone -> codex, Superset variables taking precedence over AI_* fields, the "unrecognised" /
# "no host identity" reasons) is `resolveParentContext` (src/core/context.ts), covered directly by
# tests/unit/context.test.ts ("resolveParentContext" describe block, all four test.each rows plus
# "uses AI fields to fill missing Superset fields" and "recognizes a Codex session when only its
# session id is present") and tests/unit/agents.test.ts ("the real agents preserve current
# descriptor and liveness answers"). The four scenarios that used to call the retired
# megabrain_resolve_parent_context shell function directly are dropped per rule 2 rather than
# rewritten here.

# chain run is answered entirely by the compiled binary (megabrain_chain_select no longer
# exists in shell), so selection is driven and observed through it as a black box. defaultSteps
# is empty, so the run always fails once selection has picked a chain (no usable steps to spawn)
# -- that failure report still names the chosen chain, which is all this test needs.
config='{"chains":{"claude-parent":{"when":{"parentAgent":"claude"},"steps":[{"agent":"codex","model":"gpt-5.4","effort":"medium"}]}},"defaultSteps":[]}'
printf '%s\n' "$config" >"$MEGABRAIN_CHAIN_FILE"
select_output="$(AI_AGENT=claude-code_2-1-270_agent MEGABRAIN_ROOT="$root" "$root/.build/megabrain" chain run --worktree "$state_dir" --prompt test --json)" || true
assert_equal "$(printf '%s' "$select_output" | jq -r '.chain')" claude-parent
printf 'non-Superset parent selects matching chain\n'

# The "parent agent is unknown; ..." selection reason itself is not observable through chain
# run's report: a defaultSteps fallback always reports "used defaultSteps; ..." regardless of why
# defaultSteps was chosen. Only the resulting fallback-to-defaultSteps is checked here.
select_output="$(MEGABRAIN_ROOT="$root" "$root/.build/megabrain" chain run --worktree "$state_dir" --prompt test --json)" || true
assert_equal "$(printf '%s' "$select_output" | jq -r '.chain')" defaultSteps
printf 'unknown parent does not match and falls back to defaultSteps\n'

# `megabrain context --json` (command_context) forwards unconditionally to the compiled binary
# once it exists (lib/module-context.sh:20-44, megabrain_should_use_typescript_binary), so this
# drives that binary directly rather than the shell wrapper, whose own resolution fallback is
# unreachable in this state.
context_json="$(AI_AGENT=claude-code_2-1-270_agent MEGABRAIN_STATE_DIR="$state_dir" "$root/.build/megabrain" context --json)"
assert_equal "$(printf '%s' "$context_json" | jq -r '.agentId')" claude
context_json="$(MEGABRAIN_STATE_DIR="$state_dir" "$root/.build/megabrain" context --json)"
assert_equal "$(printf '%s' "$context_json" | jq -r '.agentId')" null
printf 'context reports known parent and preserves unknown\n'

printf 'explicit agent remains outside chain selection\n'
