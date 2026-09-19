#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-child-mailbox.XXXXXX")"
trap 'rm -rf "$work"' EXIT

source "$root/tests/fixtures/entrypoint-routing.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_json() { printf '%s' "$1" | jq -e "$2" >/dev/null || fail "JSON assertion failed: $2\n$1"; }

write_fixture_binary() {
  local fixture="$1" content="$2" status="${3:-73}"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" %q\nexit %s\n' "$content" "$status" >"$fixture/.build/megabrain"
  chmod +x "$fixture/.build/megabrain"
}

run_fixture_function() {
  local fixture="$1" state="$2" function="$3"
  shift 3
  env -i HOME="$work/home" PATH="$PATH" MEGABRAIN_ROOT="$fixture" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_ORCHESTRATE_WATCH_IMPLEMENTATION=shell MEGABRAIN_ORCHESTRATE_ACK_IMPLEMENTATION=shell \
    SUPERSET_TERMINAL_ID=child-terminal bash -c '
      source "$1/lib/common.sh"
      source "$1/lib/module-orchestrate.sh"
      "$2" "${@:3}"
    ' _ "$fixture" "$function" "$@"
}

scenario_child_watch_route_preserves_content() {
  local fixture="$work/watch-route" state="$work/watch-state" output status
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_fixture_binary "$fixture" '{"verb":"check"}'
  mkdir -p "$state"
  set +e
  output="$(run_fixture_function "$fixture" "$state" megabrain_dispatch_child_check --timeout 0 --poll-interval 0 --wait-mode poll --json 2>"$work/watch.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  assert_equal "$output" '{"verb":"check"}'
  printf 'child watch route reaches the compiled binary and preserves content\n'
}

scenario_child_ack_route_preserves_content() {
  local fixture="$work/ack-route" state="$work/ack-state" output status
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_fixture_binary "$fixture" '{"verb":"ack"}'
  mkdir -p "$state"
  set +e
  output="$(env -i HOME="$work/home" PATH="$PATH" MEGABRAIN_ROOT="$fixture" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_ORCHESTRATE_ACK_IMPLEMENTATION=shell SUPERSET_TERMINAL_ID=child-terminal \
    "$fixture/megabrain" ack delivery-fixed --json 2>"$work/ack.err")"
  status=$?
  set -e
  assert_equal "$status" 73
  assert_equal "$output" '{"verb":"ack"}'
  printf 'child ack route reaches the compiled binary and preserves content\n'
}

scenario_check_content_honors_nonblocking_poll() {
  local state="$work/check-content" output
  mkdir -p "$state/dispatches/check/messages" "$state/dispatches/check/deliveries"
  printf '%s\n' '{"dispatchId":"check","terminalId":"child-terminal","childHost":"superset","runtime":"host"}' >"$state/dispatches/check/meta.json"
  printf '%s\n' '{"seq":1,"from":"parent","type":"reply","text":"compiled reply"}' >"$state/dispatches/check/messages/0001-parent-reply.json"
  printf '%s\n' '{"id":"delivery-fixed","dispatchId":"check","recipient":"child","consumer":null,"consumerGeneration":null,"messageSeqs":[1],"status":"outstanding"}' >"$state/dispatches/check/deliveries/delivery-fixed.json"
  output="$(env -i HOME="$work/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=child-terminal \
    "$root/.build/megabrain" check --timeout 0 --poll-interval 0 --wait-mode poll --json)"
  assert_json "$output" '.dispatchId == "check" and .messages[0].text == "compiled reply" and .status == "actionable"'
  printf 'compiled check returns content in one nonblocking poll\n'
}

scenario_hook_uses_compiled_check() {
  local fixture="$work/hook-fixture" state="$work/hook-state" log="$work/hook-binary.log" output
  mkdir -p "$fixture/hooks" "$fixture/.build" "$state/dispatches/hook/messages" "$state/dispatches/hook/deliveries"
  cp "$root/hooks/megabrain-turn-end.sh" "$fixture/hooks/megabrain-turn-end.sh"
  cp "$root/megabrain" "$fixture/megabrain"
  cp -R "$root/lib" "$fixture/lib"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >"$MEGABRAIN_TEST_BINARY_LOG"\nprintf %%s\\n '\''{"messages":[{"text":"compiled hook reply"}]}\''\n' >"$fixture/.build/megabrain"
  chmod +x "$fixture/hooks/megabrain-turn-end.sh" "$fixture/megabrain" "$fixture/.build/megabrain"
  printf '%s\n' '{"dispatchId":"hook","terminalId":"child-terminal","childHost":"superset","runtime":"host","state":"waiting_for_reply"}' >"$state/dispatches/hook/meta.json"
  output="$(env -i HOME="$work/home" PATH="/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_TEST_BINARY_LOG="$log" SUPERSET_TERMINAL_ID=child-terminal MEGABRAIN_HOOK_AGENT=codex \
    "$fixture/hooks/megabrain-turn-end.sh" '{}')"
  assert_equal "$(jq -r '.decision' <<<"$output")" block
  assert_equal "$(jq -r '.reason' <<<"$output")" 'megabrain reply available; run megabrain check and act on it'
  assert_equal "$(cat "$log")" 'check --timeout 0 --poll-interval 0 --wait-mode poll --json'
  printf 'turn-end hook reads child mail through the compiled check command\n'
}

scenario_child_watch_route_preserves_content
scenario_child_ack_route_preserves_content
scenario_check_content_honors_nonblocking_poll
scenario_hook_uses_compiled_check
printf 'ok: child mailbox route and content contracts\n'
