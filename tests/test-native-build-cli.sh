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

run_build() {
  local implementation="$1" directory="$2" output_file="$3" status
  set +e
  if [ "$implementation" = shell ]; then
    (cd "$directory" && MEGABRAIN_NATIVE_IMPLEMENTATION=shell MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" "$root/megabrain" native build tv) >"$output_file" 2>&1
  else
    (cd "$directory" && MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" "$root/.build/megabrain" native build tv) >"$output_file" 2>&1
  fi
  status=$?
  set -e
  printf '%s\n' "$status"
}

check_found_app_from_both_directories() {
  local implementation="$1" output_root output_app root_status app_status expected="$fixture/apps/tv/app.json"
  output_root="$work/$implementation-root.out"
  output_app="$work/$implementation-app.out"
  root_status="$(run_build "$implementation" "$fixture" "$output_root")"
  app_status="$(run_build "$implementation" "$fixture/apps/tv" "$output_app")"
  assert_status_and_path "$(cat "$output_root")" "$root_status" "$expected"
  assert_status_and_path "$(cat "$output_app")" "$app_status" "$expected"
  assert_contains "$(cat "$output_root")" 'scheme is required in'
  assert_contains "$(cat "$output_app")" 'scheme is required in'
  [ "$(cat "$output_root")" = "$(cat "$output_app")" ] || fail "$implementation answer differs between repository root and app directory"
  printf '%s resolves a relative app path from both directories\n' "$implementation"
}

write_config 'apps/tv'
check_found_app_from_both_directories shell
check_found_app_from_both_directories binary

write_config "$fixture/apps/tv"
check_found_app_from_both_directories shell
check_found_app_from_both_directories binary

write_config 'apps/missing'
for implementation in shell binary; do
  for directory in "$fixture" "$fixture/apps/tv"; do
    output="$work/missing-$implementation-$(basename "$directory").out"
    status="$(run_build "$implementation" "$directory" "$output")"
    assert_status_and_path "$(cat "$output")" "$status" 'apps/missing'
  done
done

external="$work/external"
mkdir -p "$external/.megabrain"
printf '{"version":1,"surfaces":{"tv":{"appPath":"%s"}}}\n' "$fixture/apps/tv" >"$external/.megabrain/native.json"
for implementation in shell binary; do
  output="$work/external-$implementation.out"
  set +e
  if [ "$implementation" = shell ]; then
    (cd "$external" && MEGABRAIN_NATIVE_IMPLEMENTATION=shell MEGABRAIN_NATIVE_WORKTREE="$external" MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" "$root/megabrain" native build tv) >"$output" 2>&1
  else
    (cd "$external" && MEGABRAIN_NATIVE_WORKTREE="$external" MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" "$root/.build/megabrain" native build tv) >"$output" 2>&1
  fi
  status=$?
  set -e
  assert_status_and_path "$(cat "$output")" "$status" "$fixture/apps/tv/app.json"
done

routing_fixture="$work/routing-fixture"
make_entrypoint_routing_fixture "$root" "$routing_fixture" 99
if MEGABRAIN_STATE_DIR="$MEGABRAIN_STATE_DIR" MEGABRAIN_NATIVE_WORKTREE="$work" "$routing_fixture/megabrain" native build tv >"$work/routed-output" 2>&1; then
  binary_status=0
else
  binary_status=$?
fi
[ "$binary_status" -eq 99 ] || { printf 'native operator entrypoint returned status %s\n' "$binary_status" >&2; exit 1; }

printf 'native build resolves config and app paths in both implementations\n'
