#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-wrapper-session-identity.XXXXXX")"
trap 'rm -rf "$work"' EXIT

source "$root/tests/fixtures/entrypoint-routing.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }

write_env_capture_binary() {
  local fixture="$1"
  printf '#!/usr/bin/env bash\nprintf '\''MEGABRAIN_SESSION_ID=%%s MEGABRAIN_SESSION_HOST=%%s\\n'\'' "${MEGABRAIN_SESSION_ID:-}" "${MEGABRAIN_SESSION_HOST:-}"\n' >"$fixture/.build/megabrain"
  chmod +x "$fixture/.build/megabrain"
}

scenario_wrapper_keeps_caller_session_for_verb() {
  local verb="$1" fixture output
  fixture="$work/verb-$verb"
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_env_capture_binary "$fixture"
  output="$(env -i HOME="$work/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" \
    ORCA_TERMINAL_HANDLE=term_2997abc \
    "$fixture/megabrain" orchestrate "$verb" some-dispatch --json)"
  assert_equal "$output" "MEGABRAIN_SESSION_ID= MEGABRAIN_SESSION_HOST="
  printf 'orchestrate %s leaves MEGABRAIN_SESSION_ID for the binary to resolve\n' "$verb"
}

mkdir -p "$work/home"
scenario_wrapper_keeps_caller_session_for_verb reconcile
scenario_wrapper_keeps_caller_session_for_verb liveness
scenario_wrapper_keeps_caller_session_for_verb read
scenario_wrapper_keeps_caller_session_for_verb stop
printf 'ok: orchestrate reconcile, liveness, read, and stop no longer override the caller session\n'
