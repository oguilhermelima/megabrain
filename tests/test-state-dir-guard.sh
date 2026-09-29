#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-state-dir-guard.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$work/.megabrain-test-state"
require_megabrain_test_state

trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home/.megabrain"

if env -u MEGABRAIN_STATE_DIR HOME="$work/home" bash -c 'source "$1/tests/support/state-dir-guard.bash"; require_megabrain_test_state' _ "$root" >"$work/unset.out" 2>&1; then
  printf 'FAIL: guard accepted an unset MEGABRAIN_STATE_DIR\n' >&2
  exit 1
fi
grep -q 'MEGABRAIN_STATE_DIR must be set' "$work/unset.out"

if env MEGABRAIN_STATE_DIR="$work/home/.megabrain/cache" HOME="$work/home" \
  bash -c 'source "$1/tests/support/state-dir-guard.bash"; require_megabrain_test_state' _ "$root" >"$work/home-state.out" 2>&1; then
  printf 'FAIL: guard accepted HOME/.megabrain\n' >&2
  exit 1
fi
grep -q 'refusing to run tests against the real user state directory' "$work/home-state.out"

printf 'ok: state guard rejects unset and HOME/.megabrain state paths\n'
