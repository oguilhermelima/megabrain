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
installer="$work/install.sh"
fake_bin="$work/bin"
mkdir -p "$install_root" "$home"
mkdir -p "$fake_bin"

cp "$release_source_root/install.sh" "$installer"
cat >"$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$output" ] || { printf 'fake curl: missing output path\n' >&2; exit 1; }
cp "$MEGABRAIN_TEST_ARCHIVE" "$output"
EOF
chmod +x "$fake_bin/curl"

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
[ ! -e "$release_root/.build/megabrain" ] || fail 'release tarball unexpectedly contains the compiled binary'

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
if context_output="$(env -i HOME="$home" PATH="$clean_path" MEGABRAIN_STATE_DIR="$home/.megabrain" "$release_root/megabrain" context --json 2>&1)"; then
  fail "clean install context succeeded without the compiled binary: $context_output"
fi
case "$context_output" in
  *'compiled binary is missing: '*'.build/megabrain; run bun run build'*) ;;
  *) fail "clean install context did not report the missing compiled binary: $context_output" ;;
esac

installer_output="$(env -i HOME="$home" PATH="$fake_bin:$clean_path" \
  MEGABRAIN_STATE_DIR="$home/.megabrain" MEGABRAIN_TEST_ARCHIVE="$archive" \
  bash "$installer" --agents none --skill none --agents-md none --modules none --yes 2>&1)" ||
  fail "clean installer failed: $installer_output"
[ -x "$home/.megabrain-local/.build/megabrain" ] ||
  fail 'clean installer did not produce the compiled binary'
model_output="$(env -i HOME="$home" PATH="$clean_path" MEGABRAIN_STATE_DIR="$home/.megabrain" \
  "$home/.local/bin/megabrain" model list --json 2>&1)" ||
  fail "clean installer compiled binary could not answer model list: $model_output"
case "$model_output" in
  *'compiled binary is missing'*) fail "clean installer still refused model list: $model_output" ;;
esac

missing_home="$work/missing-bun-home"
mkdir -p "$missing_home"
if missing_bun_output="$(env -i HOME="$missing_home" PATH="$fake_bin:/usr/bin:/bin" \
  MEGABRAIN_STATE_DIR="$missing_home/.megabrain" MEGABRAIN_TEST_ARCHIVE="$archive" \
  bash "$installer" --agents none --skill none --agents-md none --modules none --yes 2>&1)"; then
  fail 'installer succeeded without Bun'
fi
case "$missing_bun_output" in
  *'bun is required'*'https://bun.sh'*) ;;
  *) fail "missing Bun error was not actionable: $missing_bun_output" ;;
esac
[ ! -e "$missing_home/.megabrain-local" ] || fail 'missing Bun created a partial install'

printf 'scenario 1: no-host clean install has a sane context result\n'
printf 'scenario 2: release tarball commands run from a non-git, read-only root\n'
printf 'scenario 3: clean installer compiles and runs a ported model command\n'
printf 'scenario 4: installer refuses before writing when Bun is missing\n'
printf 'ok: clean install scenarios\n'
