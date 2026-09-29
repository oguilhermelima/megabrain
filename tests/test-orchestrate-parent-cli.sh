#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-parent-cli.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$work_dir/.megabrain-test-state"
require_megabrain_test_state

export HOME="$work_dir/home"
export MEGABRAIN_STATE_DIR="$work_dir/safe-state"
guard_db_state() {
  [ -n "${MEGABRAIN_STATE_DIR:-}" ] || { printf 'FAIL: MEGABRAIN_STATE_DIR is unset\n' >&2; exit 1; }
  case "$MEGABRAIN_STATE_DIR" in "$HOME/.megabrain"|"$HOME/.megabrain/"*) printf 'FAIL: refusing real HOME database\n' >&2; exit 1 ;; esac
}
guard_db_state
trap 'rm -rf "$work_dir"' EXIT

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

assert_json() {
  printf '%s' "$1" | jq -e "$2" >/dev/null || fail "JSON assertion failed: $2\n$1"
}

if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled parent command binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

source "$root/tests/fixtures/entrypoint-routing.sh"

write_dispatch() {
  local state="$1" dispatch="$2" delivery="$3" generation="$4" consumer="${5:-null}" consumer_json consumer_generation
  if [ "$consumer" = null ]; then
    consumer_json=null
    consumer_generation=null
  else
    consumer_json="\"$consumer\""
    consumer_generation="$generation"
  fi
  mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
  printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"parentSessionId\":\"parent-terminal\",\"parentHost\":\"superset\",\"state\":\"running\",\"terminalState\":\"owned\"}" >"$state/dispatches/$dispatch/meta.json"
  printf '%s\n' '{"seq":1,"from":"child","type":"ask","text":"content answer","sessionId":"child-terminal","createdAt":"2026-09-01T00:00:00Z"}' >"$state/dispatches/$dispatch/messages/0001-child-ask.json"
  printf '%s\n' "{\"id\":\"$delivery\",\"dispatchId\":\"$dispatch\",\"recipient\":\"parent\",\"consumer\":$consumer_json,\"consumerGeneration\":$consumer_generation,\"messageSeqs\":[1],\"status\":\"outstanding\",\"createdAt\":\"2026-09-01T00:00:00Z\",\"updatedAt\":\"2026-09-01T00:00:00Z\",\"acknowledgedAt\":null}" >"$state/dispatches/$dispatch/deliveries/$delivery.json"
  MEGABRAIN_STATE_DIR="$state" HOME="$HOME" "$root/.build/megabrain" db import "$state" >/dev/null
}

write_empty_dispatch() {
  local state="$1" dispatch="$2"
  mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
  printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"parentSessionId\":\"parent-terminal\",\"parentHost\":\"superset\",\"childHost\":\"superset\",\"terminalId\":\"child-terminal\",\"state\":\"running\",\"terminalState\":\"owned\"}" >"$state/dispatches/$dispatch/meta.json"
  MEGABRAIN_STATE_DIR="$state" HOME="$HOME" "$root/.build/megabrain" db import "$state" >/dev/null
}

show_dispatch() {
  MEGABRAIN_STATE_DIR="$1" "$root/.build/megabrain" db show "$2" --json
}

run_binary() {
  local state="$1"
  shift
  env -i HOME="$work_dir/home" PATH="$PATH" MEGABRAIN_STATE_DIR="$state" \
    SUPERSET_TERMINAL_ID=parent-terminal "$root/.build/megabrain" "$@"
}

scenario_route_reaches_binary() {
  local verb="$1" fixture state status
  fixture="$work_dir/route-$verb"
  state="$work_dir/route-$verb-state"
  make_entrypoint_routing_fixture "$root" "$fixture" 73
  mkdir -p "$state"
  set +e
  env -i HOME="$work_dir/home" PATH="$PATH" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_SKIP_BINARY_FRESHNESS_CHECK=true SUPERSET_TERMINAL_ID=parent-terminal \
    "$fixture/.build/megabrain" orchestrate "$verb" route-dispatch route-delivery --timeout 0 --poll-interval 0 --json \
    >"$state.stdout" 2>"$state.stderr"
  status=$?
  set -e
  assert_equal "$status" 73
  printf '%s route reaches the compiled binary marker\n' "$verb"
}

scenario_route_reaches_binary watch
scenario_route_reaches_binary ack

scenario_watch_generation() {
  local state="$work_dir/watch-generation" output
  write_dispatch "$state" generation-watch generation-delivery 2
  output="$(env -i HOME="$work_dir/home" PATH="$PATH" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_CONSUMER_GENERATION=2 SUPERSET_TERMINAL_ID=parent-terminal \
    "$root/.build/megabrain" orchestrate watch generation-watch --timeout 0 --wait-mode poll --json)"
  assert_json "$output" '.deliveryId == "generation-delivery" and .messages[0].text == "content answer"'
  assert_equal "$(show_dispatch "$state" generation-watch | jq -r '.deliveries[0].consumerGeneration')" 2
  printf 'watch reads and claims the environment consumer generation\n'
}

scenario_ack_generation() {
  local state="$work_dir/ack-generation" output
  write_dispatch "$state" generation-ack generation-delivery 2 superset/parent-terminal
  output="$(env -i HOME="$work_dir/home" PATH="$PATH" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_CONSUMER_GENERATION=2 SUPERSET_TERMINAL_ID=parent-terminal \
    "$root/.build/megabrain" orchestrate ack generation-ack generation-delivery --json)"
  assert_json "$output" '.acknowledged == true and .duplicate == false and .deliveryId == "generation-delivery"'
  assert_equal "$(show_dispatch "$state" generation-ack | jq -r '.deliveries[0].status')" acknowledged
  printf 'ack reads the environment consumer generation\n'
}

scenario_nudge_wakes_without_polling() {
  local state="$work_dir/nudge" output elapsed
  write_empty_dispatch "$state" nudge-watch
  (env -i HOME="$work_dir/home" PATH="$PATH" MEGABRAIN_STATE_DIR="$state" \
    SUPERSET_TERMINAL_ID=parent-terminal "$root/.build/megabrain" orchestrate watch nudge-watch \
    --timeout 6 --poll-interval 5 --wait-mode nudge --json >"$state.output") &
  local watcher_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    sleep 0.05
  done
  SECONDS=0
  env -i HOME="$work_dir/home" PATH="$PATH" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_DISPATCH_ID=nudge-watch \
    SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" ask 'content answer' >/dev/null
  wait "$watcher_pid"
  elapsed=$SECONDS
  output="$(cat "$state.output")"
  assert_json "$output" '(.deliveryId | startswith("delivery-")) and .messages[0].text == "content answer"'
  [ "$elapsed" -lt 2 ] || fail "nudge watch polled instead of waking (elapsed ${elapsed}s)"
  printf 'nudge watch wakes from the durable event marker\n'
}

scenario_ack_refusals() {
  local state="$work_dir/ack-refusals" output status error
  write_dispatch "$state" refusal refusal-delivery 1
  set +e
  output="$(run_binary "$state" orchestrate ack refusal unknown-delivery --json 2>"$state.error")"
  status=$?
  set -e
  error="$(cat "$state.error")"
  assert_equal "$status" 1
  assert_equal "$output" ''
  assert_contains "$error" 'delivery unknown-delivery refused: delivery is unknown'
  assert_equal "$(show_dispatch "$state" refusal | jq -r '.deliveries[0].status')" outstanding
  printf 'ack refuses unknown deliveries without changing queue state\n'
}

scenario_watch_generation
scenario_ack_generation
scenario_nudge_wakes_without_polling
scenario_ack_refusals

printf 'ok: compiled parent watch and ack route and content contracts\n'
