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
