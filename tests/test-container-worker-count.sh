#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-worker-count.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$state_dir/.megabrain-test-state"
require_megabrain_test_state

fake_bin="$state_dir/bin"
mkdir -p "$fake_bin"

cleanup() {
  local rc=$?
  rm -rf "$state_dir"
  return "$rc"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "$3 (expected $2, got $1)"
}

write_nproc() {
  printf '#!/bin/bash\nprintf \"%%s\\n\" \"%s\"\n' "$1" >"$fake_bin/nproc"
  chmod +x "$fake_bin/nproc"
}

source "$root/tests/container/worker-count.sh"

# Scenario 1: the container's available CPU count is the default worker count.
write_nproc 5
assert_equal "$(PATH="$fake_bin" MEGABRAIN_TEST_JOBS= megabrain_test_jobs_resolve)" 5 \
  'default workers did not follow nproc'
printf 'scenario 1: nproc count is the default\n'

# Scenario 2: an unavailable or unusable CPU probe must not oversubscribe the suite.
rm -f "$fake_bin/nproc"
assert_equal "$(PATH="$fake_bin" MEGABRAIN_TEST_JOBS= megabrain_test_jobs_resolve)" 1 \
  'missing nproc did not use the conservative fallback'
write_nproc 0
assert_equal "$(PATH="$fake_bin" MEGABRAIN_TEST_JOBS= megabrain_test_jobs_resolve)" 1 \
  'zero nproc result did not use the conservative fallback'
write_nproc not-a-number
assert_equal "$(PATH="$fake_bin" MEGABRAIN_TEST_JOBS= megabrain_test_jobs_resolve)" 1 \
  'invalid nproc result did not use the conservative fallback'
printf 'scenario 2: unusable nproc results use one worker\n'

# Scenario 3: an explicit override remains authoritative.
write_nproc not-a-number
assert_equal "$(PATH="$fake_bin" MEGABRAIN_TEST_JOBS=6 megabrain_test_jobs_resolve)" 6 \
  'explicit worker override was not honoured'
printf 'scenario 3: explicit worker override is honoured\n'

printf 'ok: container worker count scenarios\n'
