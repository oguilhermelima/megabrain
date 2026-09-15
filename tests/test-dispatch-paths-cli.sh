#!/usr/bin/env bash

set -euo pipefail

# Scenarios written before implementation: an archived dispatch and an invalid identifier.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-dispatch-paths.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled dispatch binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

make_archived() {
  local state="$1"
  mkdir -p "$state/dispatches/archive/2026-09/arq/messages" "$state/dispatches/archive/2026-09/arq/deliveries"
  printf '%s\n' '{"dispatchId":"arq","parentSessionId":"p","parentHost":"orca","runtime":"host","childHost":"orca","terminalId":"child"}' >"$state/dispatches/archive/2026-09/arq/meta.json"
}

mkdir -p "$work/home"
make_archived "$work/archive-shell"
make_archived "$work/archive-binary"
set +e
shell_archived="$(MEGABRAIN_ORCHESTRATE_CLOSE_IMPLEMENTATION=shell MEGABRAIN_STATE_DIR="$work/archive-shell" MEGABRAIN_SESSION_HOST=superset MEGABRAIN_SESSION_ID=p SUPERSET_TERMINAL_ID=p "$root/megabrain" orchestrate close arq 2>&1)"; shell_status=$?
binary_archived="$(MEGABRAIN_STATE_DIR="$work/archive-binary" MEGABRAIN_SESSION_HOST=superset MEGABRAIN_SESSION_ID=p SUPERSET_TERMINAL_ID=p "$root/.build/megabrain" orchestrate close arq 2>&1)"; binary_status=$?
set -e
[ "$shell_status" -eq "$binary_status" ] || fail "archived status differs: shell=$shell_status binary=$binary_status"
[ "$shell_archived" = "$binary_archived" ] || fail "archived dispatch differs: shell=$shell_archived binary=$binary_archived"
printf 'archived dispatch agrees between shell and binary\n'

set +e
shell_invalid="$(MEGABRAIN_ORCHESTRATE_CLOSE_IMPLEMENTATION=shell MEGABRAIN_STATE_DIR="$work/invalid-shell" MEGABRAIN_SESSION_HOST=superset MEGABRAIN_SESSION_ID=p SUPERSET_TERMINAL_ID=p "$root/megabrain" orchestrate close ../fora 2>&1)"; shell_status=$?
binary_invalid="$(MEGABRAIN_STATE_DIR="$work/invalid-binary" MEGABRAIN_SESSION_HOST=superset MEGABRAIN_SESSION_ID=p SUPERSET_TERMINAL_ID=p "$root/.build/megabrain" orchestrate close ../fora 2>&1)"; binary_status=$?
set -e
[ "$shell_status" -eq "$binary_status" ] || fail "invalid-id status differs: shell=$shell_status binary=$binary_status"
[ "$shell_invalid" = "$binary_invalid" ] || fail "invalid-id output differs: shell=$shell_invalid binary=$binary_invalid"
printf 'invalid dispatch identifier agrees between shell and binary\n'

if rg -n 'dispatches/' "$root/src" --glob '!src/adapters/dispatch-store.ts' >/dev/null; then
  fail 'dispatch path construction exists outside src/adapters/dispatch-store.ts'
fi
printf 'dispatch path construction is confined to the dispatch store\n'
