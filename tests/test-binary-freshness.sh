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

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$1' to contain '$2'" ;;
  esac
}

assert_empty() {
  [ -z "$1" ] || fail "expected empty output, got '$1'"
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "expected '$1' not to contain '$2'" ;;
    *) ;;
  esac
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
cp -R "$root/lib" "$fixture_root/lib"
cp -R "$root/.megabrain" "$fixture_root/.megabrain"
cp -R "$root/scripts" "$fixture_root/scripts"
cp -R "$root/skills" "$fixture_root/skills"
cp "$root/megabrain" "$fixture_root/megabrain"
cp "$root/package.json" "$fixture_root/package.json"
chmod +x "$fixture_root/megabrain"
(cd "$fixture_root" && bun run build >/dev/null)
[ -x "$binary" ] || fail 'fixture build did not produce the compiled binary'
fixture_source_mtime="$(path_mtime "$source_file")"
fixture_binary_mtime="$(path_mtime "$binary")"
export MEGABRAIN_ROOT="$fixture_root"

fixture_bin="$work_dir/bin"
mkdir -p "$fixture_bin"
cat >"$fixture_bin/xcrun" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"devices":{}}'
EOF
chmod +x "$fixture_bin/xcrun"

# Scenario: a source newer than the compiled binary warns, but the binary still serves JSON.
# Falsification: a silent guard or a shell fallback produces no stale notice.
sleep 1
touch "$source_file"
[ "$(path_mtime "$source_file")" != "$fixture_source_mtime" ] ||
  fail 'freshness scenario did not touch the fixture source'
[ "$(path_mtime "$binary")" = "$fixture_binary_mtime" ] ||
  fail 'freshness scenario changed the fixture binary before rebuilding'
stale_stdout="$work_dir/stale.stdout"
stale_stderr="$work_dir/stale.stderr"
if ! MEGABRAIN_STATE_DIR="$work_dir/stale-state" SUPERSET_TERMINAL_ID=terminal \
  "$fixture_root/megabrain" context --json >"$stale_stdout" 2>"$stale_stderr"; then
  fail 'stale context invocation failed'
fi
jq -e '.host == "superset" and .terminalId == "terminal"' "$stale_stdout" >/dev/null ||
  fail 'stale context did not return parseable binary JSON'
stale_notice="$(cat "$stale_stderr")"
assert_contains "$stale_notice" 'newer source'
assert_contains "$stale_notice" 'src/cli/index.ts'
assert_contains "$stale_notice" 'bun run build'
printf 'stale binary warns and preserves JSON output\n'

# Scenario: every binary-only wrapper warns when its artifact is stale.
# Falsification: a wrapper that calls the binary directly without the freshness check stays silent.
binary_wrapper_subjects() {
  awk '
    /compiled binary is missing/ { guard = 1; next }
    guard && /\$typescript_binary"/ {
      line = $0
      sub(/^.*"\$typescript_binary"[[:space:]]*/, "", line)
      sub(/[[:space:]]+"\$@".*/, "", line)
      if (line != "") {
        print line
        guard = 0
      }
    }
  ' "$fixture_root"/lib/module-*.sh
}

assert_migrated_verb_warns() {
  local name="$1" stderr_file status
  shift
  stderr_file="$work_dir/$name.stderr"
  set +e
  MEGABRAIN_STATE_DIR="$work_dir/$name-state" PATH="$fixture_bin:$PATH" \
    "$fixture_root/megabrain" "$@" >"$work_dir/$name.stdout" 2>"$stderr_file"
  status=$?
  set -e
  assert_contains "$(cat "$stderr_file")" 'compiled binary is stale'
  printf '%s stale notice count: %s\n' "$name" "$(grep -c 'compiled binary is stale' "$stderr_file")"
  return 0
}

wrapper_subjects="$work_dir/wrapper-subjects"
binary_wrapper_subjects >"$wrapper_subjects"
[ -s "$wrapper_subjects" ] || fail 'freshness contract found no binary-only wrappers'
while IFS= read -r subject; do
  assert_migrated_verb_warns "${subject// /-}" $subject --help
done <"$wrapper_subjects"

# Scenario: rebuilding removes the warning and leaves the fresh binary usable.
# Falsification: a warning that always fires remains visible after the build.
sleep 1
(cd "$fixture_root" && bun run build >/dev/null)
[ "$(path_mtime "$binary")" != "$fixture_binary_mtime" ] ||
  fail 'fixture rebuild did not change the compiled binary mtime'
fresh_stdout="$work_dir/fresh.stdout"
fresh_stderr="$work_dir/fresh.stderr"
MEGABRAIN_STATE_DIR="$work_dir/fresh-state" SUPERSET_TERMINAL_ID=terminal \
  "$fixture_root/megabrain" context --json >"$fresh_stdout" 2>"$fresh_stderr"
jq -e '.host == "superset" and .terminalId == "terminal"' "$fresh_stdout" >/dev/null ||
  fail 'fresh context did not return parseable binary JSON'
assert_not_contains "$(cat "$fresh_stderr")" 'compiled binary is stale'
printf 'fresh binary stays silent\n'

# Scenario: the explicit bypass suppresses the freshness signal.
# Falsification: a check that ignores the bypass still prints the stale notice.
sleep 1
touch "$source_file"
silenced_stderr="$work_dir/silenced.stderr"
MEGABRAIN_SKIP_BINARY_FRESHNESS_CHECK=true MEGABRAIN_STATE_DIR="$work_dir/silenced-state" \
  SUPERSET_TERMINAL_ID=terminal "$fixture_root/megabrain" context --json >/dev/null 2>"$silenced_stderr"
assert_not_contains "$(cat "$silenced_stderr")" 'compiled binary is stale'
printf 'freshness bypass stays silent\n'

# Scenario: a packaged tree with no src directory stays silent.
# Falsification: a check that treats unknown freshness as stale emits advice anyway.
no_src_root="$work_dir/no-src-root"
mkdir -p "$no_src_root/.build"
cp "$fixture_root/megabrain" "$no_src_root/megabrain"
cp -R "$fixture_root/lib" "$no_src_root/lib"
cp "$binary" "$no_src_root/.build/megabrain"
chmod +x "$no_src_root/megabrain" "$no_src_root/.build/megabrain"
no_src_stderr="$work_dir/no-src.stderr"
MEGABRAIN_STATE_DIR="$work_dir/no-src-state" SUPERSET_TERMINAL_ID=terminal \
  "$no_src_root/megabrain" context --json >/dev/null 2>"$no_src_stderr"
assert_not_contains "$(cat "$no_src_stderr")" 'compiled binary is stale'
printf 'missing source tree stays silent\n'

# Scenario: doctor reports a stale compiled binary as a finding and exits non-zero.
# Falsification: doctor omits the finding or reports a healthy status.
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
MEGABRAIN_ROOT="$fixture_root" MEGABRAIN_STATE_DIR="$work_dir/doctor-fresh-state" \
  "$binary" doctor compiled-binary --json >"$work_dir/doctor-fresh.stdout"
jq -e '.module == "compiled-binary" and .status == "ok"' "$work_dir/doctor-fresh.stdout" >/dev/null ||
  fail 'doctor kept the stale finding after rebuild'
printf 'doctor reports a fresh binary as healthy\n'

[ "$(path_mtime "$root/src/cli/index.ts")" = "$root_source_mtime" ] ||
  fail 'freshness test changed the checkout source mtime'

printf 'ok: compiled binary freshness and doctor scenarios\n'
