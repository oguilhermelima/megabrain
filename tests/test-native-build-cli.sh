#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-native-build-cli.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export MEGABRAIN_STATE_DIR="$work/state"
mkdir -p "$MEGABRAIN_STATE_DIR"
source "$root/tests/fixtures/entrypoint-routing.sh"

if [ ! -x "$root/.build/megabrain" ]; then
  printf 'FAIL: compiled native binary is missing at %s; run bun run build\n' "$root/.build/megabrain" >&2
  exit 1
fi

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected '$1' to contain '$2'" ;; esac; }
assert_status_and_path() {
  local output="$1" status="$2" expected_path="$3"
  [ "$status" -ne 0 ] || fail "native build unexpectedly succeeded"
  assert_contains "$output" "$expected_path"
}

fixture="$work/repository"
mkdir -p "$fixture/.megabrain" "$fixture/apps/tv"
fixture="$(cd "$fixture" && pwd -P)"
git -C "$fixture" init -q
printf '{"expo":{"ios":{"bundleIdentifier":"com.example.tv"}}}\n' >"$fixture/apps/tv/app.json"

write_config() {
  printf '{"version":1,"surfaces":{"tv":{"appPath":"%s"}}}\n' "$1" >"$fixture/.megabrain/native.json"
}

run_binary() {
  local directory="$1" output_file="$2" status
  set +e
  (cd "$directory" && MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" "$root/.build/megabrain" native build tv) >"$output_file" 2>&1
  status=$?
  set -e
  printf '%s\n' "$status"
}

check_found_app_from_both_directories() {
  local output_root="$work/binary-root.out" output_app="$work/binary-app.out" root_status app_status expected="$fixture/apps/tv/app.json"
  root_status="$(run_binary "$fixture" "$output_root")"
  app_status="$(run_binary "$fixture/apps/tv" "$output_app")"
  assert_status_and_path "$(cat "$output_root")" "$root_status" "$expected"
  assert_status_and_path "$(cat "$output_app")" "$app_status" "$expected"
  assert_contains "$(cat "$output_root")" 'scheme is required in'
  assert_contains "$(cat "$output_app")" 'scheme is required in'
  [ "$(cat "$output_root")" = "$(cat "$output_app")" ] || fail 'binary answer differs between repository root and app directory'
  printf 'binary resolves a relative app path from both directories\n'
}

write_config 'apps/tv'
check_found_app_from_both_directories

write_config "$fixture/apps/tv"
check_found_app_from_both_directories

write_config 'apps/missing'
for directory in "$fixture" "$fixture/apps/tv"; do
  output="$work/missing-$(basename "$directory").out"
  status="$(run_binary "$directory" "$output")"
  assert_status_and_path "$(cat "$output")" "$status" 'apps/missing'
done

external="$work/external"
mkdir -p "$external/.megabrain"
printf '{"version":1,"surfaces":{"tv":{"appPath":"%s"}}}\n' "$fixture/apps/tv" >"$external/.megabrain/native.json"
output="$work/external-binary.out"
set +e
(cd "$external" && MEGABRAIN_NATIVE_WORKTREE="$external" MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" "$root/.build/megabrain" native build tv) >"$output" 2>&1
status=$?
set -e
assert_status_and_path "$(cat "$output")" "$status" "$fixture/apps/tv/app.json"

routing_fixture="$work/routing-fixture"
make_entrypoint_routing_fixture "$root" "$routing_fixture" 99
routing_root="$(cd "$routing_fixture" && pwd -P)"
if MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" MEGABRAIN_NATIVE_WORKTREE="$work" "$routing_fixture/megabrain" native build tv >"$work/routed-output" 2>&1; then
  binary_status=0
else
  binary_status=$?
fi
[ "$binary_status" -eq 99 ] || { printf 'native operator entrypoint returned status %s\n' "$binary_status" >&2; exit 1; }

rm -f "$routing_fixture/.build/megabrain"
if missing_binary_output="$(MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" MEGABRAIN_NATIVE_WORKTREE="$work" "$routing_fixture/megabrain" native build tv 2>&1)"; then
  fail 'native command unexpectedly ran without the compiled binary'
fi
assert_contains "$missing_binary_output" "compiled binary is missing: $routing_root/.build/megabrain; run bun run build"

printf 'ok: compiled native build scenarios resolve paths and refuse a missing binary\n'
