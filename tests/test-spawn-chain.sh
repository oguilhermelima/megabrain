#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-spawn-chain.XXXXXX")"
state_dir="$state_root/state"
before_worktrees=""
spawn_count=0
fail_agent=""
limit_agent=""
limit_used=""
limit_resets=""

cleanup() {
  local rc=$?
  rm -rf "$state_root"
  return "$rc"
}
trap cleanup EXIT

export HOME="$state_root/home"
export MEGABRAIN_STATE_DIR="$state_dir"
export SUPERSET_TERMINAL_ID=parent-terminal
export SUPERSET_AGENT_ID=codex
mkdir -p "$state_dir"

source "$root/lib/common.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-model.sh"
source "$root/lib/module-model-validation.sh"
source "$root/lib/module-worktree.sh"
source "$root/lib/module-chain.sh"

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

megabrain_context_detect() {
  printf 'superset\n'
}

megabrain_workspace_id_for_target() {
  printf 'workspace-test\n'
}

megabrain_resolve_spawn_runtime() {
  MEGABRAIN_SPAWN_RUNTIME=ide
  MEGABRAIN_SPAWN_CONTEXT=superset
}

megabrain_launch_agent() {
  local worktree="$1" workspace="$2" agent="$3" model="$4" effort="$5" prompt="$6" label="${7:-}"
  local dispatch_id
  if [ "$agent" = "$fail_agent" ]; then
    printf 'simulated launch failure for %s\n' "$agent" >&2
    return 1
  fi
  spawn_count=$((spawn_count + 1))
  dispatch_id="dispatch-test-$spawn_count"
  printf '%s\t%s\t%s\t%s\t%s\n' "$agent" "$model" "$effort" "$prompt" "$label" >"$state_root/last-spawn"
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal superset superset "$workspace" child-terminal \
    "$worktree" main "$agent" "$label" spawning "$model" true "$agent" "" "" host ide >/dev/null
  MEGABRAIN_LAST_DISPATCH="$dispatch_id"
  MEGABRAIN_LAST_SPAWN_RUNTIME=ide
}

megabrain_chain_limit_read() {
  local agent="$1" window="$2"
  MEGABRAIN_CHAIN_LIMIT_STATUS=unknown
  MEGABRAIN_CHAIN_LIMIT_USED=""
  MEGABRAIN_CHAIN_LIMIT_RESETS=""
  MEGABRAIN_CHAIN_LIMIT_REASON="$agent $window window unknown (test fixture)"
  if [ "$agent" = "$limit_agent" ]; then
    MEGABRAIN_CHAIN_LIMIT_STATUS=current
    MEGABRAIN_CHAIN_LIMIT_USED="$limit_used"
    MEGABRAIN_CHAIN_LIMIT_RESETS="$limit_resets"
    MEGABRAIN_CHAIN_LIMIT_REASON="$agent $window window at $limit_used percent"
  fi
}

write_config() {
  rm -rf "$MEGABRAIN_STATE_DIR"
  mkdir -p "$MEGABRAIN_STATE_DIR"
  printf '%s\n' "$1" >"$MEGABRAIN_CHAIN_FILE"
}

clear_state() {
  rm -rf "$MEGABRAIN_STATE_DIR"
  mkdir -p "$MEGABRAIN_STATE_DIR"
  spawn_count=0
  fail_agent=""
  limit_agent=""
  limit_used=""
  limit_resets=""
}

run_spawn() {
  command_orchestrate spawn --worktree "$root" --prompt spawn-test --tmux false --json "$@"
}

# 1. An explicit agent is the escape hatch and does not initialize or consult chains.
clear_state
run_spawn --agent codex --model gpt-5.6-luna --effort high >/dev/null
assert_equal "$(cut -f1 "$state_root/last-spawn")" codex
[ ! -f "$MEGABRAIN_CHAIN_FILE" ] || fail 'explicit --agent consulted chain configuration'
printf 'explicit agent without chains: passed\n'

# 2. A selector supplies the agent, while explicit model and effort override their fields.
write_config '{"chains":{"codex-path":{"when":{"parentAgent":"codex"},"steps":[{"agent":"claude","model":"claude-sonnet-5","effort":"medium"}]}},"defaultSteps":[]}'
spawn_json="$(run_spawn --model claude-opus-5 --effort high)"
dispatch_id="$(printf '%s' "$spawn_json" | jq -r '.dispatchId')"
assert_equal "$(cut -f1 "$state_root/last-spawn")" claude
assert_equal "$(cut -f2 "$state_root/last-spawn")" claude-opus-5
assert_equal "$(cut -f3 "$state_root/last-spawn")" high
assert_equal "$(jq -r '.chain.name' "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json")" codex-path
assert_equal "$(jq -r '.chain.step' "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json")" 1
assert_contains "$(jq -r '.chain.reason' "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json")" 'selector match'
assert_contains "$(jq -r '.chain.reason' "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json")" 'model override'
printf 'selector chain and field overrides: passed\n'

# 3. An empty configuration fails before creating a dispatch or worktree.
clear_state
before_worktrees="$(git -C "$root" worktree list --porcelain)"
if error="$(run_spawn 2>&1 >/dev/null)"; then
  fail 'spawn without agent and chains unexpectedly succeeded'
fi
assert_contains "$error" 'megabrain chain add'
[ ! -d "$MEGABRAIN_DISPATCH_DIR" ] || fail 'failed chain selection created a dispatch directory'
assert_equal "$(git -C "$root" worktree list --porcelain)" "$before_worktrees"
printf 'empty chain failure has no side effects: passed\n'

# 4. With no selector match, defaultSteps supplies the first step.
write_config '{"chains":{"other":{"when":{"parentAgent":"claude"},"steps":[{"agent":"claude","model":"claude-sonnet-5","effort":"medium"}]}},"defaultSteps":[{"agent":"agy","model":"gemini-3.8-flash-high"}]}'
spawn_json="$(run_spawn)"
dispatch_id="$(printf '%s' "$spawn_json" | jq -r '.dispatchId')"
assert_equal "$(cut -f1 "$state_root/last-spawn")" agy
assert_equal "$(jq -r '.chain.name' "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json")" defaultSteps
assert_equal "$(jq -r '.chain.usedDefault' "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json")" true
printf 'defaultSteps selection: passed\n'

# 5. A fresh state directory has no seeded chains.
fresh_dir="$state_root/fresh"
fresh_json="$(HOME="$state_root/fresh-home" MEGABRAIN_STATE_DIR="$fresh_dir" "$root/megabrain" chain list --json)"
assert_equal "$(printf '%s' "$fresh_json" | jq '.chains | length')" 0
printf 'fresh chain state is empty: passed\n'

# 6. --chain bypasses a non-matching selector and records the explicit choice.
write_config '{"chains":{"forced":{"when":{"parentAgent":"claude"},"steps":[{"agent":"claude","model":"claude-sonnet-5","effort":"medium"}]}},"defaultSteps":[{"agent":"agy","model":"gemini-3.8-flash-high"}]}'
spawn_json="$(run_spawn --chain forced)"
dispatch_id="$(printf '%s' "$spawn_json" | jq -r '.dispatchId')"
assert_equal "$(cut -f1 "$state_root/last-spawn")" claude
assert_equal "$(jq -r '.chain.name' "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json")" forced
assert_contains "$(jq -r '.chain.reason' "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json")" 'explicit --chain'
printf 'explicit chain bypass: passed\n'

# 7. An unknown --chain fails before any dispatch is written.
clear_state
write_config '{"chains":{"known":{"when":{"parentAgent":"codex"},"steps":[{"agent":"claude","model":"claude-sonnet-5","effort":"medium"}]}},"defaultSteps":[]}'
if error="$(run_spawn --chain missing 2>&1 >/dev/null)"; then
  fail 'unknown --chain unexpectedly succeeded'
fi
assert_contains "$error" 'megabrain chain list'
[ ! -d "$MEGABRAIN_DISPATCH_DIR" ] || fail 'unknown chain created a dispatch directory'
printf 'unknown explicit chain failure has no dispatch: passed\n'

# 8. Spawn walks past a step whose usage window is over the threshold.
write_config '{"chains":{"fallback":{"when":{"parentAgent":"codex"},"steps":[{"agent":"codex","model":"gpt-5.6-luna","effort":"high","until":{"usedPercent":95,"window":"5h"}},{"agent":"claude","model":"claude-sonnet-5","effort":"medium"}]}} ,"defaultSteps":[]}'
limit_agent=codex
limit_used=99
limit_resets=4102444800
spawn_json="$(run_spawn)"
dispatch_id="$(printf '%s' "$spawn_json" | jq -r '.dispatchId')"
assert_equal "$(cut -f1 "$state_root/last-spawn")" claude
assert_equal "$(jq -r '.chain.step' "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json")" 2
assert_contains "$(jq -r '.chain.reason' "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json")" 'codex 5h window at 99 percent'
printf 'spawn skips an exhausted first step: passed\n'

# 9. Spawn falls through after a launch failure just as chain run does.
clear_state
write_config '{"chains":{"fallback":{"when":{"parentAgent":"codex"},"steps":[{"agent":"codex","model":"gpt-5.6-luna","effort":"high"},{"agent":"claude","model":"claude-sonnet-5","effort":"medium"}]}} ,"defaultSteps":[]}'
fail_agent=codex
spawn_json="$(run_spawn)"
dispatch_id="$(printf '%s' "$spawn_json" | jq -r '.dispatchId')"
assert_equal "$(cut -f1 "$state_root/last-spawn")" claude
assert_equal "$(jq -r '.chain.step' "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json")" 2
assert_contains "$(jq -r '.chain.reason' "$MEGABRAIN_STATE_DIR/dispatches/$dispatch_id/meta.json")" 'codex launch failed'
printf 'spawn falls through after launch failure: passed\n'

# 10. Chain run keeps the existing success fields and the skipped list.
clear_state
write_config '{"chains":{"fallback":{"when":{"parentAgent":"codex"},"steps":[{"agent":"codex","model":"gpt-5.6-luna","effort":"high","until":{"usedPercent":95,"window":"5h"}},{"agent":"claude","model":"claude-sonnet-5","effort":"medium"}]}} ,"defaultSteps":[]}'
limit_agent=codex
limit_used=99
limit_resets=4102444800
chain_json="$(command_chain run --chain fallback --worktree "$root" --prompt chain-test --tmux false --json)"
assert_equal "$(printf '%s' "$chain_json" | jq -r '.ok,.chain,.step,.totalSteps,.agent' | paste -sd ' ' -)" 'true fallback 2 2 claude'
assert_equal "$(printf '%s' "$chain_json" | jq -r '.skipped[0].kind,.skipped[0].step,.skipped[0].agent' | paste -sd ' ' -)" 'limit 1 codex'
assert_contains "$(printf '%s' "$chain_json" | jq -r '.reason')" 'codex 5h window at 99 percent'
printf 'chain run preserves skipped-step reporting: passed\n'

# A refusal recorded by the parent hook is a failed chain step. Continuation starts
# at the following step and reuses the original prompt without replaying step 1.
clear_state
write_config '{"chains":{"fallback":{"when":{"parentAgent":"codex"},"steps":[{"agent":"codex","model":"gpt-5.6-luna","effort":"high"},{"agent":"agy","model":"gemini-3.8-flash-medium"}]}},"defaultSteps":[]}'
megabrain_dispatch_meta_write refused-chain parent-terminal superset superset workspace-test refused-terminal \
  "$root" main codex label running gpt-5 true codex '' '' host ide '' '' workspace-test fallback 1 2 'initial chain step' false >/dev/null
jq '.chain.prompt = "resume-prompt"' "$MEGABRAIN_STATE_DIR/dispatches/refused-chain/meta.json" >"$state_root/refused-meta.json"
mv -f "$state_root/refused-meta.json" "$MEGABRAIN_STATE_DIR/dispatches/refused-chain/meta.json"
megabrain_dispatch_mark_limit_refused refused-chain 'codex refused: usage limit marker'
megabrain_chain_run_spawn() {
  local dispatch_id=dispatch-test-continuation
  printf '%s\t%s\n' agy resume-prompt >"$state_root/continuation-spawn"
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal superset superset workspace-test child-terminal \
    "$root" main agy label spawning gemini-3.8-flash-high true agy '' '' host ide >/dev/null
  printf '{"dispatch":"%s"}\n' "$dispatch_id"
}
megabrain_chain_continue_refused refused-chain
assert_equal "$(cut -f1 "$state_root/continuation-spawn")" agy
assert_equal "$(cut -f2 "$state_root/continuation-spawn")" resume-prompt
assert_equal "$MEGABRAIN_CHAIN_WALK_STEP" 2
printf 'refused chain continuation: advanced from the recorded failure\n'

printf 'ok: spawn chain scenarios\n'
