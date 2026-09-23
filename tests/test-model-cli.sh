#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-model-cli.XXXXXX")"
state="$work/state"
home="$work/home"
trap 'rm -rf "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled model binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

run_binary() {
  MEGABRAIN_STATE_DIR="$state" HOME="$home" "$root/.build/megabrain" "$@"
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

assert_failure() {
  local expected_status="$1" expected_message="$2" output status
  shift 2
  if output="$(run_binary "$@" 2>&1)"; then status=0; else status=$?; fi
  [ "$status" -eq "$expected_status" ] || fail "$*: expected status $expected_status, got $status: $output"
  assert_contains "$output" "$expected_message"
}

mkdir -p "$home"

# Scenario: list --json initializes the fixture registry and exposes its actual inventory.
# Falsification: a no-op or shell comparison would not create the fixture registry or satisfy
# the independent inventory assertions below.
list_output="$(run_binary model list --json)"
[ -f "$state/models.json" ] || fail 'model list did not initialize the fixture registry'
assert_equal "$(printf '%s' "$list_output" | jq '.version')" 1
assert_equal "$(printf '%s' "$list_output" | jq '[.models[] | select(.agent == "codex")] | length')" 12
assert_equal "$(printf '%s' "$list_output" | jq '[.models[] | select(.agent == "claude")] | length')" 19
assert_equal "$(printf '%s' "$list_output" | jq '[.models[] | select(.agent == "agy")] | length')" 14
assert_equal "$(printf '%s' "$list_output" | jq -r '.models[] | select(.agent == "agy" and .model == "gemini-3.8-flash-high") | .provenance.kind')" live
printf 'registry-json: binary lists the fixture registry and provenance\n'

# Scenario: an unset state directory uses HOME, without creating a checkout-relative state path.
# Falsification: resolving against the caller or repository would miss this HOME registry or
# create state in the checkout.
home_state="$work/home-state"
mkdir -p "$home_state/.megabrain"
cp "$root/.megabrain/models.json" "$home_state/.megabrain/models.json"
rm -rf "$root/.megabrain-state"
default_output="$(env -u MEGABRAIN_STATE_DIR HOME="$home_state" "$root/.build/megabrain" model list --json)"
assert_equal "$(printf '%s' "$default_output" | jq '.version')" 1
[ ! -e "$root/.megabrain-state" ] || fail 'default state resolution wrote into the checkout'
printf 'default-state-directory: binary resolves state through HOME\n'

# Scenario: the human table contains the binary's documented columns and a real registry row.
# Falsification: returning JSON, an empty table, or stale shell formatting fails these exact
# structural expectations.
table_output="$(run_binary model list)"
assert_contains "$table_output" 'AGENT      MODEL                                  REASONING        STATUS      MODEL-PROVENANCE   EFFORT-PROVENANCE'
assert_contains "$table_output" 'codex      gpt-6-astra'
printf 'registry-table: binary formats the documented table\n'

# Scenario: each help branch returns its own documented usage without touching the registry.
# Falsification: routing to a removed shell branch would change or omit one of these usages.
assert_equal "$(run_binary model --help)" 'Usage: megabrain model list|add|refresh ...'
assert_equal "$(run_binary model list --help)" 'Usage: megabrain model list [--json]'
assert_equal "$(run_binary model add --help)" 'Usage: megabrain model add <agent> <model> --reasoning <levels>'
assert_equal "$(run_binary model refresh --help)" 'Usage: megabrain model refresh <agent>'
printf 'help: binary documents model, list, add, and refresh\n'

# Scenario: an unsupported list option is rejected with the usage exit status.
# Falsification: ignoring the option or accepting it would return status 0.
assert_failure 2 'unknown model list option: --invalid' model list --invalid
printf 'invalid-option: binary refuses unknown list flags\n'

# Scenario: refresh refuses agents whose registry is manually curated.
# Falsification: a no-op success would claim that codex was refreshed despite no live listing.
assert_failure 1 'codex has no live model listing' model refresh codex
printf 'unavailable-refresh: binary refuses non-live model refresh\n'

printf 'ok: compiled model scenarios assert output, effects, and failures directly\n'
