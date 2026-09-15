#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-chain-ts.XXXXXX")"
trap 'rm -rf "$state"' EXIT
export MEGABRAIN_STATE_DIR="$state/state"
export MEGABRAIN_ROOT="$root"
shell_output="$(MEGABRAIN_CHAIN_IMPLEMENTATION=shell "$root/megabrain" chain list --json)"
ts_output="$("$root/.build/megabrain" chain list --json)"
[ "$shell_output" = "$ts_output" ]
printf 'chain compiled contract: passed\n'
