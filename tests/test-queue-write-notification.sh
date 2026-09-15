#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled queue-write binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-queue-write-notification.XXXXXX")"
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
  local implementation="$1" state="$2" dispatch="$3" verb="$4" text="${5:-}"
  local implementation_override="" binary="$root/.build/megabrain"
  [ "$implementation" = shell ] && implementation_override=MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION=shell
  if [ "$verb" = received ]; then
    env -i HOME="$work_dir/home" PATH="$work_dir/bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_EFFECT_FILE="$work_dir/effect-$implementation" $implementation_override SUPERSET_TERMINAL_ID=child-terminal "$([ "$implementation" = shell ] && printf '%s/megabrain' "$root" || printf '%s' "$binary")" received >/dev/null 2>&1
  else
    env -i HOME="$work_dir/home" PATH="$work_dir/bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_EFFECT_FILE="$work_dir/effect-$implementation" $implementation_override SUPERSET_TERMINAL_ID=child-terminal "$([ "$implementation" = shell ] && printf '%s/megabrain' "$root" || printf '%s' "$binary")" "$verb" "$text" >/dev/null 2>&1
  fi
}

run_case() {
  local label="$1" verb="$2" expected="$3" text="${4:-}" implementation state dispatch effect deliveries
  for implementation in shell binary; do
    dispatch="$label"
    state="$work_dir/$implementation-$dispatch"
    write_fixture "$state" "$dispatch"
    : >"$work_dir/effect-$implementation"
    run_message "$implementation" "$state" "$dispatch" "$verb" "$text"
    if [ "$label" = done-repeat ]; then
      : >"$work_dir/effect-$implementation"
      run_message "$implementation" "$state" "$dispatch" done "finished again"
    fi
    effect="$(cat "$work_dir/effect-$implementation")"
    deliveries="$(find "$state/dispatches/$dispatch/deliveries" -name '*.json' | wc -l | tr -d ' ')"
    if [ "$label" = done-repeat ]; then
      [ "$deliveries" -eq 2 ] || fail "$label $implementation created $deliveries deliveries"
    else
      [ "$deliveries" -eq 1 ] || fail "$label $implementation created $deliveries deliveries"
    fi
    if [ "$expected" = silent ]; then
      [ -z "$effect" ] || fail "$label $implementation invoked notification: $effect"
    else
      [ -n "$effect" ] || fail "$label $implementation did not invoke notification"
    fi
    if [ "$implementation" = binary ]; then
      binary_effect="$effect"
    else
      shell_effect="$effect"
    fi
  done
  [ "$shell_effect" = "$binary_effect" ] || fail "$label notification differs: shell=$shell_effect binary=$binary_effect"
  printf '%s: notification and durable delivery agree\n' "$label"
}

run_case received received silent
run_case ask ask actionable 'a question'
run_case done done actionable finished
run_case done-repeat done silent finished
printf 'ok: queue-write notification classifications agree\n'
