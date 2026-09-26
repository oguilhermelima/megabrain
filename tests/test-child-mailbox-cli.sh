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

# megabrain_dispatch_child_check (the shell function scenario_child_watch_route_preserves_content
# used to drive) has no production caller left: `megabrain check` forwards straight to the
# compiled binary from command_check (lib/module-orchestrate.sh:1447-1456), never through the
# child-check wrapper. That leaves this file's own scenario_check_content_honors_nonblocking_poll
# below, which drives the binary directly, as the routing+content proof for `check`. Dropped
# per rule 3.

scenario_child_ack_route_preserves_content() {
  local fixture="$work/ack-route" state="$work/ack-state" output status
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  write_fixture_binary "$fixture" '{"verb":"ack"}'
  mkdir -p "$state"
  set +e
  output="$(env -i HOME="$work/home" PATH="$PATH" MEGABRAIN_ROOT="$fixture" MEGABRAIN_STATE_DIR="$state" \
    SUPERSET_TERMINAL_ID=child-terminal \
    "$fixture/.build/megabrain" ack delivery-fixed --json 2>"$work/ack.err")"
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
  assert_json "$output" '.dispatchId == "check" and .messages[0].from == "parent" and .messages[0].type == "reply" and .messages[0].text == "compiled reply" and .status == "reply"'
  printf 'compiled check returns content in one nonblocking poll\n'
}

# scenario_hook_uses_compiled_check (originally: proving the turn-end hook shells out to
# `megabrain check`) is dropped per rule 2: the turn-end hook stopped shelling out to any
# subcommand at all before it was even a wrapper script -- it was a one-line
# `exec "$MEGABRAIN_HOOK_BINARY" hook turn-end "$@"` (commit 06376e6 and its ancestors), and now
# there is no wrapper script left at all: agent hook configs invoke the compiled binary's
# `hook turn-end` command directly, and hook-turn-end.ts resolves the queued reply internally.
# The exact scenario this used to prove (a queued reply produces {"decision":"block","reason":
# "megabrain reply available; run megabrain check and act on it"}) is covered by
# tests/unit/hook-turn-end.test.ts:282, "blocks (reason: reply available) when the parent has
# queued a reply".

scenario_child_ack_route_preserves_content
scenario_check_content_honors_nonblocking_poll
printf 'ok: child mailbox route and content contracts\n'
