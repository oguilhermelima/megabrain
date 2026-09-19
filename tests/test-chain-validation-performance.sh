#!/usr/bin/env bash

set -euo pipefail

# Scenarios written before the implementation:
# 1. Invalid chain validation names the chain, step, and offending field.
# 2. JSON chain list output stays byte-identical for several chains.
# 3. onUnknown accepts take and skip, and rejects other values.
# 4. Chain-list jq process count does not grow with the number of chains.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-chain-validation.XXXXXX")"
wrapper_dir="$state_root/bin"
real_jq="$(command -v jq)"
path_without_wrapper="$PATH"

cleanup() {
  local rc=$?
  rm -rf "$state_root"
  return "$rc"
}
trap cleanup EXIT

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

mkdir -p "$wrapper_dir"
printf '%s\n' '#!/usr/bin/env bash' \
  'count=$(cat "$MEGABRAIN_TEST_JQ_COUNT")' \
  'count=$((count + 1))' \
  'printf "%s\\n" "$count" >"$MEGABRAIN_TEST_JQ_COUNT"' \
  'exec "$MEGABRAIN_TEST_JQ_REAL" "$@"' >"$wrapper_dir/jq"
chmod +x "$wrapper_dir/jq"

valid_step='[{"agent":"agy","model":"gemini-3.8-flash-high"}]'
usage_limits='"usageLimits":{"liveProviders":[],"cacheTtlSeconds":30,"timeoutSeconds":5,"notice":{"enabled":false,"intervalSeconds":3600}}'
several_chains="{\"chains\":{\"alpha\":{\"when\":{\"parentAgent\":\"codex\"},\"steps\":$valid_step},\"beta\":{\"when\":{\"parentAgent\":\"claude\"},\"steps\":[{\"agent\":\"agy\",\"model\":\"gemini-3.8-flash-medium\"}]}},\"defaultSteps\":[{\"agent\":\"agy\",\"model\":\"gemini-3.8-flash-low\"}],$usage_limits}"
expected_list='{"chains":[{"when":{"parentAgent":"codex"},"steps":[{"agent":"agy","model":"gemini-3.8-flash-high"}],"name":"alpha"},{"when":{"parentAgent":"claude"},"steps":[{"agent":"agy","model":"gemini-3.8-flash-medium"}],"name":"beta"}],"defaultSteps":[{"agent":"agy","model":"gemini-3.8-flash-low"}]}'

prepare_state() {
  local name="$1" config="$2" case_dir
  case_dir="$state_root/$name"
  mkdir -p "$case_dir/home" "$case_dir/state"
  export HOME="$case_dir/home"
  export MEGABRAIN_STATE_DIR="$case_dir/state"
  PATH="$path_without_wrapper" "$root/megabrain" model list --json >/dev/null
  printf '%s\n' "$config" >"$MEGABRAIN_STATE_DIR/chains.json"
}

# 1. Keep the operator-facing location details from validation failures.
invalid_config="{\"chains\":{\"broken-chain\":{\"when\":{\"parentAgent\":\"codex\"},\"steps\":[{\"agent\":\"agy\",\"model\":\"gemini-3.8-flash-high\",\"unexpected\":true}]}},\"defaultSteps\":[],$usage_limits}"
prepare_state invalid "$invalid_config"
if invalid_output="$(PATH="$path_without_wrapper" "$root/megabrain" chain list --json 2>&1)"; then
  fail 'invalid chain unexpectedly passed validation'
fi
assert_contains "$invalid_output" 'invalid chain broken-chain step 1: unsupported field unexpected'
printf 'invalid chain: chain, step, and field are named\n'

valid_policy_config="{\"chains\":{\"policy\":{\"when\":{\"parentAgent\":\"codex\"},\"steps\":[{\"agent\":\"codex\",\"model\":\"gpt-5.6-luna\",\"effort\":\"high\",\"until\":{\"usedPercent\":95,\"window\":\"5h\",\"onUnknown\":\"skip\"}}]}},\"defaultSteps\":[],$usage_limits}"
prepare_state valid-policy "$valid_policy_config"
PATH="$path_without_wrapper" "$root/megabrain" chain list --json >/dev/null
printf 'onUnknown skip policy: accepted\n'

invalid_policy_config="{\"chains\":{\"broken-policy\":{\"when\":{\"parentAgent\":\"codex\"},\"steps\":[{\"agent\":\"codex\",\"model\":\"gpt-5.6-luna\",\"effort\":\"high\",\"until\":{\"usedPercent\":95,\"window\":\"5h\",\"onUnknown\":\"defer\"}}]}},\"defaultSteps\":[],$usage_limits}"
prepare_state invalid-policy "$invalid_policy_config"
if invalid_policy_output="$(PATH="$path_without_wrapper" "$root/megabrain" chain list --json 2>&1)"; then
  fail 'invalid onUnknown policy unexpectedly passed validation'
fi
assert_contains "$invalid_policy_output" 'until.onUnknown'
printf 'onUnknown invalid policy: rejected with a named field\n'

# 2. Pin the exact JSON bytes for multiple chains and default steps.
prepare_state several "$several_chains"
list_output="$(PATH="$path_without_wrapper" "$root/megabrain" chain list --json)"
assert_equal "$list_output" "$expected_list"
printf 'chain list JSON: byte-identical shape for several chains\n'

count_chain_list() {
  local name="$1" config="$2" case_dir
  case_dir="$state_root/$name"
  prepare_state "$name" "$config"
  export MEGABRAIN_TEST_JQ_REAL="$real_jq"
  export MEGABRAIN_TEST_JQ_COUNT="$case_dir/jq-count"
  printf '0\n' >"$MEGABRAIN_TEST_JQ_COUNT"
  PATH="$wrapper_dir:$path_without_wrapper" "$root/megabrain" chain list --json >/dev/null
  cat "$MEGABRAIN_TEST_JQ_COUNT"
}

one_chain="{\"chains\":{\"chain1\":{\"when\":{\"parentAgent\":\"codex\"},\"steps\":$valid_step}},\"defaultSteps\":[],$usage_limits}"
three_chains="{\"chains\":{\"chain1\":{\"when\":{\"parentAgent\":\"codex\"},\"steps\":$valid_step},\"chain2\":{\"when\":{\"parentAgent\":\"codex\"},\"steps\":$valid_step},\"chain3\":{\"when\":{\"parentAgent\":\"codex\"},\"steps\":$valid_step}},\"defaultSteps\":[],$usage_limits}"
one_count="$(count_chain_list one "$one_chain")"
three_count="$(count_chain_list three "$three_chains")"
count_growth=$((three_count - one_count))
[ "$count_growth" -le 6 ] || fail "chain list jq count grew by $count_growth (one=$one_count, three=$three_count)"
printf 'chain list jq count: one=%s, three=%s, growth=%s\n' "$one_count" "$three_count" "$count_growth"

printf 'ok: chain validation errors, output shape, and bounded jq cost\n'
