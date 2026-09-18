#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
release_source_root="$root"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-clean-install.XXXXXX")"
cleanup() {
  local rc=$?
  chmod -R u+rwX "$work" 2>/dev/null || true
  rm -rf "$work"
  return "$rc"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

version="$(jq -r '.version' "$release_source_root/.claude-plugin/plugin.json")"
archive="$work/release.tar.gz"
install_root="$work/install"
home="$work/home"
formula="$work/megabrain.rb"
mkdir -p "$install_root" "$home"

before_git_status="$(git -C "$release_source_root" status --porcelain=v1 --untracked-files=all)"
before_formula_identity="$(ls -di "$release_source_root/Formula/megabrain.rb" | awk '{print $1}')"

"$release_source_root/scripts/release.sh" "v$version" --output "$archive" --formula-output "$formula" >/dev/null ||
  fail 'could not create release tarball for clean-install proof'
after_git_status="$(git -C "$release_source_root" status --porcelain=v1 --untracked-files=all)"
[ "$after_git_status" = "$before_git_status" ] ||
  fail 'clean-install test changed the source git working tree'
after_formula_identity="$(ls -di "$release_source_root/Formula/megabrain.rb" | awk '{print $1}')"
[ "$after_formula_identity" = "$before_formula_identity" ] ||
  fail 'clean-install test rewrote the source formula'
tar -xzf "$archive" -C "$install_root"
release_root="$install_root/megabrain-$version"
[ -x "$release_root/megabrain" ] || fail 'release tarball did not produce an executable install'
[ ! -d "$release_root/.git" ] || fail 'clean release install unexpectedly contains a git directory'

chmod -R a-w "$release_root"
[ ! -w "$release_root" ] || fail 'clean release install root is writable'
export HOME="$home"
export MEGABRAIN_STATE_DIR="$home/.megabrain"
clean_path="$PATH"

version_output="$(env -i HOME="$home" PATH="$clean_path" MEGABRAIN_STATE_DIR="$home/.megabrain" "$release_root/megabrain" version)"
case "$version_output" in
  "megabrain $version") ;;
  *) fail "clean install returned an unexpected version: $version_output" ;;
esac
context_json="$(env -i HOME="$home" PATH="$clean_path" MEGABRAIN_STATE_DIR="$home/.megabrain" "$release_root/megabrain" context --json)"
printf '%s' "$context_json" | jq -e '.host == "unknown"' >/dev/null || fail 'clean install context failed'
if missing_binary_output="$(env -i HOME="$home" PATH="$clean_path" MEGABRAIN_STATE_DIR="$home/.megabrain" \
  "$release_root/megabrain" model list 2>&1)"; then
  fail 'clean install unexpectedly ran model list without the compiled binary'
fi
case "$missing_binary_output" in
  *'compiled binary is missing'*'run bun run build'*) ;;
  *) fail "clean install did not explain the missing binary: $missing_binary_output" ;;
esac

printf 'scenario 1: no-host clean install has a sane context result\n'
printf 'scenario 2: release tarball commands run from a non-git, read-only root\n'
printf 'scenario 3: ported model command refuses a missing compiled binary\n'
printf 'ok: clean install scenarios\n'
