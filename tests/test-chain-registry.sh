#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-chain-registry.XXXXXX")"
trap 'rm -rf "$work"' EXIT

source "$root/tests/fixtures/entrypoint-routing.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected '$1' to contain '$2'" ;; esac; }
assert_empty() { [ -z "$1" ] || fail "expected empty output, got '$1'"; }

fixture="$work/checkout"
state="$work/state"
mkdir -p "$fixture/.build" "$fixture/.megabrain" "$state"
cp "$root/.build/megabrain" "$fixture/.build/megabrain"
cp "$root/package.json" "$fixture/package.json"
cp "$root/.megabrain/models.json" "$fixture/.megabrain/models.json"
cp -R "$root/skills" "$fixture/skills"
chmod +x "$fixture/.build/megabrain" "$fixture/.build/megabrain"

write_chain() {
  local name="$1" model="$2" unvalidated="${3:-false}"
  if [ "$unvalidated" = true ]; then
    cat >"$state/chains.json" <<EOF
{"chains":{"$name":{"when":{"parentAgent":"codex"},"steps":[{"agent":"codex","model":"$model","effort":"medium","unvalidated":true}]}},"defaultSteps":[]}
EOF
  else
    cat >"$state/chains.json" <<EOF
{"chains":{"$name":{"when":{"parentAgent":"codex"},"steps":[{"agent":"codex","model":"$model","effort":"medium"}]}},"defaultSteps":[]}
EOF
  fi
}

run_binary() {
  local output_file="$1" error_file="$2" status
  if MEGABRAIN_STATE_DIR="$state" "$fixture/.build/megabrain" chain list --json >"$output_file" 2>"$error_file"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$status"
}

known_output="$work/known.out"
known_error="$work/known.err"
write_chain known gpt-6-astra
known_status="$(run_binary "$known_output" "$known_error")"
[ "$known_status" -eq 0 ] || fail "known model was rejected: $(cat "$known_error")"
jq -e '.chains | length == 1' "$known_output" >/dev/null || fail 'known registry output was not JSON'
assert_empty "$(cat "$known_error")"
printf 'registry present and model known: validated without notice\n'

unknown_output="$work/unknown.out"
unknown_error="$work/unknown.err"
write_chain unknown not-registered
unknown_status="$(run_binary "$unknown_output" "$unknown_error")"
[ "$unknown_status" -eq 1 ] || fail "unknown model was accepted: $(cat "$unknown_error")"
assert_contains "$(cat "$unknown_error")" "unknown model 'not-registered'"
assert_contains "$(cat "$unknown_error")" 'gpt-6-astra'
printf 'registry present and model unknown: refused with valid ids\n'

bypass_output="$work/bypass.out"
bypass_error="$work/bypass.err"
write_chain bypass not-registered true
MEGABRAIN_STATE_DIR="$state" "$fixture/.build/megabrain" chain list --json >"$bypass_output" 2>"$bypass_error" || fail "deliberate unvalidated opt-out was rejected: $(cat "$bypass_error")"
assert_empty "$(cat "$bypass_error")"
printf 'registry present and unvalidated model: deliberate opt-out remains distinct\n'

routing_fixture="$work/routing-fixture"
make_entrypoint_routing_fixture "$root" "$routing_fixture" 97
if MEGABRAIN_STATE_DIR="$state" "$routing_fixture/.build/megabrain" chain list --json >"$work/routing.out" 2>&1; then
  fail 'default chain entrypoint did not reach the compiled implementation'
else
  routing_status=$?
fi
[ "$routing_status" -eq 97 ] || fail "default chain entrypoint returned status $routing_status"
printf 'chain default route reaches the compiled implementation\n'

MEGABRAIN_CHAIN_IMPLEMENTATION=shell MEGABRAIN_STATE_DIR="$state" "$fixture/.build/megabrain" chain list --json >"$work/shell.out" 2>"$work/shell.err" || fail "shell chain implementation failed: $(cat "$work/shell.err")"
jq -e '.chains | length == 1' "$work/shell.out" >/dev/null || fail 'shell chain output was not JSON'
printf 'chain shell route remains reachable\n'

rm "$fixture/.megabrain/models.json"
write_chain unknown not-registered
absent_output="$work/absent.out"
absent_error="$work/absent.err"
absent_status="$(run_binary "$absent_output" "$absent_error")"
[ "$absent_status" -eq 0 ] || fail "missing registry broke a valid install: $(cat "$absent_error")"
jq -e '.chains | length == 1' "$absent_output" >/dev/null || fail 'missing registry output was not JSON'
assert_contains "$(cat "$absent_error")" 'model registry'
assert_contains "$(cat "$absent_error")" 'validation was skipped'
printf 'registry absent: command succeeds with an explicit validation notice\n'
