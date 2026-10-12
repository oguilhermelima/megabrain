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

# Print the pids of detached megabrain workers (supervisor and delivery) whose environment names a
# path under any argument. Workers carry no state dir in argv, so their environment is the only link: read
# /proc where it exists, otherwise ps -E.
megabrain_background_pids() {
  local root pid environment found
  for pid in $(ps -axo pid=,command= | awk '/__(supervise|delivery)-worker/ && !/awk/ {print $1}'); do
    if [ -r "/proc/$pid/environ" ]; then environment="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null || true)"
    else environment="$(ps eww -p "$pid" 2>/dev/null || true)"; fi
    found=""
    for root in "$@"; do case "$environment" in *"=$root"*) found=1 ;; esac; done
    [ -z "$found" ] || printf '%s\n' "$pid"
  done
}

# The only way a test removes its temp directory: stop every detached megabrain worker bound to it,
# wait for them to exit (bounded, then KILL), then remove it. Anything left running would keep
# writing into the directory while rm walks it ("Directory not empty").
remove_test_dir() {
  local dir="$1" resolved pids pid waited=0
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  resolved="$(cd "$dir" && pwd -P)"
  pids="$(megabrain_background_pids "$dir" "$resolved")"
  # shellcheck disable=SC2086
  [ -z "$pids" ] || kill -TERM $pids 2>/dev/null || true
  while [ -n "$pids" ]; do
    pids="$(for pid in $pids; do if kill -0 "$pid" 2>/dev/null; then printf '%s\n' "$pid"; fi; done)"
    [ -n "$pids" ] || break
    waited=$((waited + 1))
    if [ "$waited" -gt 100 ]; then
      # shellcheck disable=SC2086
      kill -KILL $pids 2>/dev/null || true
      sleep 0.2
      break
    fi
    sleep 0.1
  done
  rm -rf "$resolved"
}
