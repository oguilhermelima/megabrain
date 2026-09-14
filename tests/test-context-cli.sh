#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-context-cli.XXXXXX")"

cleanup() {
  rm -rf "$work_dir"
  return 0
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
    *) fail "expected output to contain '$2', got: $1" ;;
  esac
}

run_cli() {
  env -i \
    HOME="$work_dir/home" \
    PATH="/usr/bin:/bin" \
    MEGABRAIN_STATE_DIR="$work_dir/state" \
    "$@"
}

mkdir -p "$work_dir/home"

# The default form is the host name, with no framing or extra fields.
default_output="$(run_cli SUPERSET_TERMINAL_ID=terminal-test "$root/megabrain" context)"
assert_equal "$default_output" superset
printf 'default output reports the detected host\n'

# JSON has a stable, exact top-level shape and preserves all context values.
json_output="$(run_cli \
  SUPERSET_TERMINAL_ID=terminal-test \
  SUPERSET_WORKSPACE_ID=workspace-test \
  SUPERSET_AGENT_ID=agent-test \
  "$root/megabrain" context --json)"
assert_equal "$(printf '%s' "$json_output" | jq -S -c 'keys')" '["agentId","host","terminalId","workspaceId"]'
assert_equal "$(printf '%s' "$json_output" | jq -r '.host')" superset
assert_equal "$(printf '%s' "$json_output" | jq -r '.workspaceId')" workspace-test
assert_equal "$(printf '%s' "$json_output" | jq -r '.terminalId')" terminal-test
assert_equal "$(printf '%s' "$json_output" | jq -r '.agentId')" agent-test
printf 'JSON output has the exact key set and values\n'

# With no orchestrator identity or available Orca CLI, the host is explicitly unknown.
unknown_output="$(run_cli "$root/megabrain" context)"
assert_equal "$unknown_output" unknown
unknown_json="$(run_cli "$root/megabrain" context --json)"
assert_equal "$(printf '%s' "$unknown_json" | jq -r '.host')" unknown
assert_equal "$(printf '%s' "$unknown_json" | jq -r '.workspaceId')" null
assert_equal "$(printf '%s' "$unknown_json" | jq -r '.terminalId')" null
assert_equal "$(printf '%s' "$unknown_json" | jq -r '.agentId')" null
printf 'an undetermined host is reported as unknown with null identities\n'

# Unsupported options must fail as CLI usage errors instead of being ignored.
set +e
error_output="$(run_cli "$root/megabrain" context --unsupported 2>&1)"
error_status=$?
set -e
assert_equal "$error_status" 2
assert_contains "$error_output" 'unknown context option: --unsupported'
printf 'unknown flags are rejected with a usage error\n'

printf 'ok: context CLI behaviour is covered\n'
