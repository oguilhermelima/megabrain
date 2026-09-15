#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-stop-reconcile.XXXXXX")"
trap 'rm -rf "$work"' EXIT
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled dispatch binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi
run_pair() {
  local verb="$1" id="$2" shell_out binary_out shell_rc binary_rc implementation_var
  local shell_state="$work/shell-$verb-$id" binary_state="$work/binary-$verb-$id"
  mkdir -p "$shell_state/dispatches/$id/messages" "$binary_state/dispatches/$id/messages"
  printf '%s\n' "{\"dispatchId\":\"$id\",\"parentSessionId\":\"p\",\"parentHost\":\"orca\",\"state\":\"closed\",\"processState\":\"stopped\",\"terminalState\":\"released\"}" >"$shell_state/dispatches/$id/meta.json"
  cp "$shell_state/dispatches/$id/meta.json" "$binary_state/dispatches/$id/meta.json"
  set +e
  if [ "$verb" = reconcile ]; then implementation_var=MEGABRAIN_ORCHESTRATE_RECONCILE_IMPLEMENTATION; else implementation_var=MEGABRAIN_ORCHESTRATE_STOP_IMPLEMENTATION; fi
  shell_out="$(env MEGABRAIN_STATE_DIR="$shell_state" MEGABRAIN_SESSION_HOST=orca MEGABRAIN_SESSION_ID=p ORCA_TERMINAL_HANDLE=p "$implementation_var"=shell "$root/megabrain" orchestrate "$verb" "$id" --json 2>&1)"; shell_rc=$?
  binary_out="$(MEGABRAIN_STATE_DIR="$binary_state" MEGABRAIN_SESSION_HOST=orca MEGABRAIN_SESSION_ID=p ORCA_TERMINAL_HANDLE=p "$root/.build/megabrain" orchestrate "$verb" "$id" --json 2>&1)"; binary_rc=$?
  set -e
  [ "$shell_rc" -eq "$binary_rc" ] && [ "$shell_out" = "$binary_out" ] || { printf 'FAIL: %s differs\n' "$verb" >&2; return 1; }
}
run_pair reconcile closed
run_pair reconcile missing
run_pair stop missing
printf '3 passed, 0 failed, 0 skipped\n'
