#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd -P)"
state_root="$(mktemp -d /tmp/megabrain-model-registry-upgrade.XXXXXX)"

cleanup() {
  local rc=$?
  rm -rf "$state_root"
  return "$rc"
}
trap cleanup EXIT

export HOME="$state_root/home"
export MEGABRAIN_STATE_DIR="$state_root/state"
mkdir -p "$HOME" "$MEGABRAIN_STATE_DIR"

template="$root/.megabrain/models.json"

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

assert_failure_contains() {
  local expected="$1" output
  shift
  if output="$("$@" 2>&1)"; then
    fail "expected command to fail: $*"
  fi
  assert_contains "$output" "$expected"
}

reset_state() {
  rm -rf "$MEGABRAIN_STATE_DIR"
  mkdir -p "$MEGABRAIN_STATE_DIR"
}

write_old_registry() {
  local output="$MEGABRAIN_STATE_DIR/models.old"
  jq '
    .models |= map(select(
      .agent == "agy" or
      (.agent == "codex" and .model == "gpt-6-astra") or
      (.agent == "claude" and .model == "claude-sonnet-5") or
      (.agent == "codex" and .model == "operator-model")
    ))
    | .models |= map(
        if .agent == "codex" and .model == "gpt-6-astra" then
          .reasoning.levels = ["low", "medium", "high", "xhigh", "max", "ultra"]
        elif .agent == "claude" and .model == "claude-sonnet-5" then
          .reasoning.levels = ["low", "medium", "high"]
        else .
        end
      )
  ' "$MEGABRAIN_STATE_DIR/models.json" >"$output"
  mv -f "$output" "$MEGABRAIN_STATE_DIR/models.json"
}

# 1. A fresh registry accepts every Claude level in the template and refuses an unknown one.
reset_state
list_output="$($root/megabrain model list --json)"
assert_equal "$(printf '%s' "$list_output" | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-6-astra") | .provenance.kind')" sourced
assert_equal "$(printf '%s' "$list_output" | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-6-astra") | .reasoning.provenance.kind')" verified
assert_equal "$(printf '%s' "$list_output" | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-6-astra") | .reasoning.provenance.command')" /Users/gui/.local/bin/codex
assert_equal "$(printf '%s' "$list_output" | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-6-astra") | .reasoning.provenance.method')" 'embedded model_reasoning_effort enum'
assert_equal "$(printf '%s' "$list_output" | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-6-astra") | .reasoning.provenance.obtainedAt')" 2026-09-08
assert_equal "$(printf '%s' "$list_output" | jq -r '.models[] | select(.agent == "claude" and .model == "claude-sonnet-5") | .provenance.kind')" sourced
assert_equal "$(printf '%s' "$list_output" | jq -r '.models[] | select(.agent == "claude" and .model == "claude-sonnet-5") | .reasoning.provenance.kind')" verified
assert_equal "$(printf '%s' "$list_output" | jq -r '.models[] | select(.agent == "claude" and .model == "claude-sonnet-5") | .reasoning.provenance.command')" 'claude --help'
printf 'fresh registry: model documentation and reasoning evidence stay distinct\n'
claude_model="$(jq -r '.models[] | select(.agent == "claude") | .model' "$template" | head -n 1)"
claude_levels="$(jq -r --arg model "$claude_model" '.models[] | select(.agent == "claude" and .model == $model) | .reasoning.levels[]' "$template" | sort -u)"
for level in $claude_levels; do
  "$root/megabrain" chain add "fresh-claude-$level" \
    --when '{"parentAgent":"codex"}' \
    --steps "$(jq -nc --arg model "$claude_model" --arg effort "$level" '[{agent:"claude",model:$model,effort:$effort}]')" >/dev/null
done
assert_failure_contains 'does not support reasoning level' "$root/megabrain" chain add fresh-claude-bogus \
  --when '{"parentAgent":"codex"}' \
  --steps "$(jq -nc --arg model "$claude_model" '[{agent:"claude",model:$model,effort:"bogus"}]')"
printf 'fresh registry: Claude levels accepted and unknown level refused\n'

# 2. An old registry gains missing template entries and corrected reasoning levels.
reset_state
"$root/megabrain" model list --json >/dev/null
write_old_registry
upgraded="$("$root/megabrain" model list --json)"
assert_equal "$(printf '%s' "$upgraded" | jq '[.models[] | select(.agent == "agy")] | length')" 14
assert_equal "$(printf '%s' "$upgraded" | jq '[.models[] | select(.agent == "codex")] | length')" 10
assert_equal "$(printf '%s' "$upgraded" | jq '[.models[] | select(.agent == "claude")] | length')" 18
assert_equal "$(printf '%s' "$upgraded" | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-6-astra") | .reasoning.levels | join(",")')" 'minimal,low,medium,high,xhigh,max,ultra'
assert_equal "$(printf '%s' "$upgraded" | jq -r '.models[] | select(.agent == "claude" and .model == "claude-sonnet-5") | .reasoning.levels | join(",")')" 'low,medium,high,xhigh,max'
assert_equal "$(printf '%s' "$upgraded" | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-6-astra") | .provenance.kind')" sourced
assert_equal "$(printf '%s' "$upgraded" | jq -r '.models[] | select(.agent == "codex" and .model == "gpt-6-astra") | .reasoning.provenance.kind')" verified
assert_equal "$(printf '%s' "$upgraded" | jq -r '.models[] | select(.agent == "claude" and .model == "claude-sonnet-5") | .provenance.kind')" sourced
assert_equal "$(printf '%s' "$upgraded" | jq -r '.models[] | select(.agent == "claude" and .model == "claude-sonnet-5") | .reasoning.provenance.kind')" verified
printf 'registry upgrade: missing entries added and corrected levels applied\n'

# 3. A model added with model add is curated and wins over the template during upgrade.
reset_state
"$root/megabrain" model add codex operator-model --reasoning high >/dev/null
curated_before="$(jq -c '.models[] | select(.agent == "codex" and .model == "operator-model")' "$MEGABRAIN_STATE_DIR/models.json")"
write_old_registry
upgraded="$("$root/megabrain" model list --json)"
curated_after="$(printf '%s' "$upgraded" | jq -c '.models[] | select(.agent == "codex" and .model == "operator-model")')"
assert_equal "$curated_after" "$curated_before"
assert_equal "$(printf '%s' "$upgraded" | jq -r '.models[] | select(.model == "operator-model") | .provenance.kind')" curated
assert_equal "$(printf '%s' "$upgraded" | jq -r '.models[] | select(.model == "operator-model") | .reasoning.levels | join(",")')" high
printf 'curated registry entry: levels and provenance survive upgrade\n'

# 4. model add accepts every level shipped by the template and refuses an unknown one.
reset_state
for level in $(jq -r '.models[].reasoning.levels[]' "$template" | sort -u); do
  "$root/megabrain" model add codex "accepted-$level" --reasoning "$level" >/dev/null
done
assert_failure_contains 'unknown reasoning level' "$root/megabrain" model add codex rejected-level --reasoning bogus
printf 'model add vocabulary: every shipped level accepted and unknown level refused\n'

# 5. A dispatch metadata record carries the effort used for its launch.
reset_state
MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" bash -c '
  source "$1/lib/common.sh"
  source "$1/lib/module-orchestrate.sh"
  megabrain_dispatch_meta_write dispatch-level parent superset superset workspace terminal "$1" main codex label spawning gpt-5 true codex "" "" host ide "" "" "" "" "" "" "" false high >/dev/null
' _ "$root"
assert_equal "$(jq -r '.model' "$MEGABRAIN_STATE_DIR/dispatches/dispatch-level/meta.json")" gpt-5
assert_equal "$(jq -r '.effort' "$MEGABRAIN_STATE_DIR/dispatches/dispatch-level/meta.json")" high
printf 'dispatch metadata: launched effort recorded next to model\n'

printf 'ok: model registry levels, upgrade ownership, and dispatch effort\n'
