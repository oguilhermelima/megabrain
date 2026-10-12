#!/usr/bin/env bash

require_megabrain_test_state() {
  local state_dir="${1-${MEGABRAIN_STATE_DIR:-}}" home_root protected_root resolved_state
  if [ -z "$state_dir" ]; then
    printf 'FAIL: MEGABRAIN_STATE_DIR must be set to an isolated test directory before megabrain runs\n' >&2
    return 1
  fi
  home_root="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${HOME:-}")" || return 1
  protected_root="$(python3 -c 'import os,sys; print(os.path.realpath(os.path.join(sys.argv[1], ".megabrain")))' "$home_root")" || return 1
  resolved_state="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$state_dir")" || return 1
  case "$resolved_state/" in
    "$protected_root/"*)
      printf 'FAIL: refusing to run tests against the real user state directory: %s\n' "$resolved_state" >&2
      return 1
      ;;
  esac
}

# Stop the detached supervise worker a spawn started against the current MEGABRAIN_STATE_DIR and
# wait until its process is gone, so nothing keeps writing into the directory a test removes next.
# Call it from the test's cleanup, before rm -rf. Uses $1, MEGABRAIN_BIN, or the repo build.
stop_megabrain_supervisor() {
  local binary="${1:-${MEGABRAIN_BIN:-}}" pid status waited=0
  if [ -z "$binary" ]; then binary="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)/.build/megabrain"; fi
  [ -x "$binary" ] && [ -n "${MEGABRAIN_STATE_DIR:-}" ] && [ -d "$MEGABRAIN_STATE_DIR" ] || return 0
  status="$("$binary" supervise --status 2>/dev/null || true)"
  pid="$(printf '%s\n' "$status" | sed -n 's/^watcher: running (pid \([0-9][0-9]*\)).*/\1/p' | head -n 1)"
  [ -n "$pid" ] || return 0
  "$binary" supervise --stop >/dev/null 2>&1 || true
  while kill -0 "$pid" 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -gt 100 ]; then kill -KILL "$pid" 2>/dev/null || true; break; fi
    sleep 0.1
  done
  return 0
}
