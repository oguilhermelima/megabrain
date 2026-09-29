#!/usr/bin/env bash

# Test fixture helpers for the SQLite cutover. Fixtures may still be authored in the legacy
# layout, but assertions read the imported database through the public CLI.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/state-dir-guard.bash"

state_db_import() {
  local binary="$1" state_dir="$2" replace="${3:-false}" source_dir="${4:-$2}"
  require_megabrain_test_state "$state_dir"
  if [ "$replace" = true ]; then
    MEGABRAIN_STATE_DIR="$state_dir" "$binary" db import "$source_dir" --replace >/dev/null
  else
    MEGABRAIN_STATE_DIR="$state_dir" "$binary" db import "$source_dir" >/dev/null
  fi
}

state_db_import_dispatch() {
  local binary="$1" state_dir="$2" dispatch_id="$3" replace="${4:-false}" rc=0
  local fixture_dir
  fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-state-fixture.XXXXXX")"
  mkdir -p "$fixture_dir/dispatches"
  if [ -d "$state_dir/dispatches/archive" ] && [ -d "$state_dir/dispatches/archive/$dispatch_id" ]; then
    mkdir -p "$fixture_dir/dispatches/archive"
    cp -R "$state_dir/dispatches/archive/$dispatch_id" "$fixture_dir/dispatches/archive/"
  else
    cp -R "$state_dir/dispatches/$dispatch_id" "$fixture_dir/dispatches/"
  fi
  state_db_import "$binary" "$state_dir" "$replace" "$fixture_dir" || rc=$?
  rm -rf "$fixture_dir"
  return "$rc"
}

state_db_dispatch() {
  local binary="$1" state_dir="$2" dispatch_id="$3"
  require_megabrain_test_state "$state_dir"
  MEGABRAIN_STATE_DIR="$state_dir" "$binary" db show "$dispatch_id" --json
}

state_db_terminal() {
  local binary="$1" state_dir="$2" terminal_id="$3"
  require_megabrain_test_state "$state_dir"
  MEGABRAIN_STATE_DIR="$state_dir" "$binary" db show --terminal "$terminal_id" --json
}

state_db_install() {
  local binary="$1" state_dir="$2"
  require_megabrain_test_state "$state_dir"
  MEGABRAIN_STATE_DIR="$state_dir" "$binary" db show --install-state --json
}

state_db_put_waiter() {
  local state_dir="$1" dispatch_id="$2" pid="$3"
  require_megabrain_test_state "$state_dir"
  node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/write-waiter.mjs" "$state_dir" "$dispatch_id" "$pid"
}
