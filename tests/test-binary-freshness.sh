#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-binary-freshness.XXXXXX")"
fixture_root="$work_dir/repo"
root_binary="$root/.build/megabrain"
binary="$fixture_root/.build/megabrain"
source_file="$fixture_root/src/cli/index.ts"
trap 'rm -rf "$work_dir"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

path_mtime() {
  local mtime
  mtime="$(stat -c '%Y' "$1" 2>/dev/null || true)"
  case "$mtime" in
    ''|*[!0-9]*) mtime="$(stat -f '%m' "$1" 2>/dev/null || true)" ;;
  esac
  printf '%s\n' "$mtime"
}

[ -x "$root_binary" ] || {
  printf 'skip: compiled freshness binary is missing at %s; run bun run build\n' "$root_binary"
  exit 0
}

root_source_mtime="$(path_mtime "$root/src/cli/index.ts")"
mkdir -p "$fixture_root"
cp -R "$root/src" "$fixture_root/src"
cp "$root/package.json" "$fixture_root/package.json"
(cd "$fixture_root" && bun run build >/dev/null)
[ -x "$binary" ] || fail 'fixture build did not produce the compiled binary'
fixture_binary_mtime="$(path_mtime "$binary")"

# Scenario: doctor reports a stale compiled binary as a finding and exits non-zero.
# Falsification: doctor omits the finding or reports a healthy status.
sleep 1
touch "$source_file"
doctor_stdout="$work_dir/doctor.stdout"
doctor_stderr="$work_dir/doctor.stderr"
set +e
MEGABRAIN_ROOT="$fixture_root" MEGABRAIN_STATE_DIR="$work_dir/doctor-state" \
  "$binary" doctor compiled-binary --json >"$doctor_stdout" 2>"$doctor_stderr"
doctor_status=$?
set -e
[ "$doctor_status" -eq 1 ] || fail "stale doctor status was $doctor_status"
jq -e '.module == "compiled-binary" and .status == "misconfigured" and (.reason | contains("newer source"))' \
  "$doctor_stdout" >/dev/null || fail 'doctor did not report stale compiled binary'
printf 'doctor reports stale binary as a finding\n'

# Scenario: doctor returns healthy after rebuilding.
# Falsification: the finding is sticky after the binary becomes current.
sleep 1
(cd "$fixture_root" && bun run build >/dev/null)
[ "$(path_mtime "$binary")" != "$fixture_binary_mtime" ] ||
  fail 'fixture rebuild did not change the compiled binary mtime'
MEGABRAIN_ROOT="$fixture_root" MEGABRAIN_STATE_DIR="$work_dir/doctor-fresh-state" \
  "$binary" doctor compiled-binary --json >"$work_dir/doctor-fresh.stdout"
jq -e '.module == "compiled-binary" and .status == "ok"' "$work_dir/doctor-fresh.stdout" >/dev/null ||
  fail 'doctor kept the stale finding after rebuild'
printf 'doctor reports a fresh binary as healthy\n'

# Scenario: a packaged tree with no src directory reports the binary as not stale.
# Falsification: doctor treats an absent source tree as a misconfigured finding.
no_src_root="$work_dir/no-src-root"
mkdir -p "$no_src_root/.build"
cp "$binary" "$no_src_root/.build/megabrain"
chmod +x "$no_src_root/.build/megabrain"
no_src_stdout="$work_dir/no-src.stdout"
MEGABRAIN_ROOT="$no_src_root" MEGABRAIN_STATE_DIR="$work_dir/no-src-state" \
  "$no_src_root/.build/megabrain" doctor compiled-binary --json >"$no_src_stdout"
jq -e '.module == "compiled-binary" and .status == "ok"' "$no_src_stdout" >/dev/null ||
  fail 'doctor treated an absent source tree as stale'
printf 'missing source tree reports as not stale\n'

[ "$(path_mtime "$root/src/cli/index.ts")" = "$root_source_mtime" ] ||
  fail 'freshness test changed the checkout source mtime'

printf 'ok: compiled binary freshness doctor scenarios\n'
