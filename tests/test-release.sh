#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-version-bump.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

fixture="$work/megabrain"
mkdir -p "$fixture/scripts"
cp "$root/package.json" "$fixture/package.json"
cp "$root/scripts/release.sh" "$fixture/scripts/release.sh"
chmod +x "$fixture/scripts/release.sh"

before="$(jq -S 'del(.version)' "$fixture/package.json")"
"$fixture/scripts/release.sh" v9.8.7 >/dev/null || fail 'valid package version was refused'
jq -e '.version == "9.8.7" and .private == true' "$fixture/package.json" >/dev/null ||
  fail 'release script did not update only the private package version'
after="$(jq -S 'del(.version)' "$fixture/package.json")"
[ "$before" = "$after" ] || fail 'version bump changed package metadata other than version'
printf 'version bump: updates package.json and preserves package metadata\n'

if "$fixture/scripts/release.sh" 9.8.8 >"$work/invalid.out" 2>&1; then
  fail 'release script accepted a version without the v prefix'
fi
jq -e '.version == "9.8.7"' "$fixture/package.json" >/dev/null ||
  fail 'invalid version changed package.json'
printf 'version validation: invalid input leaves package.json unchanged\n'

[ ! -e "$fixture/Formula" ] || fail 'release script created a Homebrew formula'
[ ! -e "$fixture/dist" ] || fail 'release script created a publishing archive'
printf 'ok: release script only bumps the private package version\n'
