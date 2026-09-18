#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-native-build-cli.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export MEGABRAIN_STATE_DIR="$work/state"
mkdir -p "$MEGABRAIN_STATE_DIR"
source "$root/tests/fixtures/entrypoint-routing.sh"

shell_output="$(MEGABRAIN_NATIVE_IMPLEMENTATION=shell MEGABRAIN_NATIVE_WORKTREE="$work" "$root/megabrain" native build tv 2>&1)" || shell_status=$?
shell_status="${shell_status:-0}"
[ "$shell_status" -eq 1 ] || { printf 'shell native build status was %s\n' "$shell_status" >&2; exit 1; }
case "$shell_output" in
  *"app path is required for tv; pass surfaces.tv.appPath in .megabrain/native.json"*) ;;
  *) printf 'shell native build refusal was not explicit: %s\n' "$shell_output" >&2; exit 1 ;;
esac

routing_fixture="$work/routing-fixture"
make_entrypoint_routing_fixture "$root" "$routing_fixture" 99
if MEGABRAIN_NATIVE_WORKTREE="$work" "$routing_fixture/megabrain" native build tv >"$work/routed-output" 2>&1; then
  binary_status=0
else
  binary_status=$?
fi
[ "$binary_status" -eq 99 ] || { printf 'native operator entrypoint returned status %s\n' "$binary_status" >&2; exit 1; }

printf 'native build reaches shell and compiled implementation independently\n'
