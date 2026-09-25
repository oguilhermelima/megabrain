#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled queue-write binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-queue-write-notification.XXXXXX")"
node_bin="$work_dir/node-bin"
mkdir -p "$node_bin"
ln -s "$(command -v node)" "$node_bin/node"
trap 'rm -rf "$work_dir"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

write_fixture() {
  local state="$1" dispatch="$2"
  mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
  printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"terminalId\":\"child-terminal\",\"childHost\":\"superset\",\"parentSessionId\":\"parent-terminal\",\"parentHost\":\"orca\",\"state\":\"running\",\"processState\":\"running\",\"terminalState\":\"owned\"}" >"$state/dispatches/$dispatch/meta.json"
}

mkdir -p "$work_dir/bin" "$work_dir/home"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$*" >>"$MEGABRAIN_EFFECT_FILE"' >"$work_dir/bin/orca"
chmod +x "$work_dir/bin/orca"

run_message() {
  local state="$1" dispatch="$2" verb="$3" text="${4:-}"
  if [ "$verb" = received ]; then
    env -i HOME="$work_dir/home" PATH="$work_dir/bin:$node_bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_EFFECT_FILE="$work_dir/effect" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" received >/dev/null 2>&1
  else
    env -i HOME="$work_dir/home" PATH="$work_dir/bin:$node_bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_EFFECT_FILE="$work_dir/effect" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" "$verb" "$text" >/dev/null 2>&1
  fi
}

run_case() {
  local label="$1" verb="$2" expected="$3" text="${4:-}" state dispatch effect deliveries
  dispatch="$label"
  state="$work_dir/$dispatch"
  write_fixture "$state" "$dispatch"
  : >"$work_dir/effect"
  run_message "$state" "$dispatch" "$verb" "$text"
  if [ "$label" = done-repeat ]; then
    : >"$work_dir/effect"
    run_message "$state" "$dispatch" done "finished again"
  fi
  effect="$(cat "$work_dir/effect")"
  deliveries="$(find "$state/dispatches/$dispatch/deliveries" -name '*.json' | wc -l | tr -d ' ')"
  if [ "$label" = done-repeat ]; then
    [ "$deliveries" -eq 2 ] || fail "$label created $deliveries deliveries"
  else
    [ "$deliveries" -eq 1 ] || fail "$label created $deliveries deliveries"
  fi
  if [ "$expected" = silent ]; then
    [ -z "$effect" ] || fail "$label invoked notification: $effect"
  else
    [ -n "$effect" ] || fail "$label did not invoke notification"
  fi
  printf '%s: notification and durable delivery agree\n' "$label"
}

run_case received received silent
run_case ask ask actionable 'a question'
run_case done done actionable finished
run_case done-repeat done silent finished
printf 'ok: Node entrypoint notification and delivery classifications\n'
