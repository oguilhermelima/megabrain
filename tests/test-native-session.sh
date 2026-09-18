#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ "$(uname -s 2>/dev/null || printf unknown)" != Darwin ] || ! command -v xcrun >/dev/null 2>&1; then
  printf 'skip: native session implementation parity requires macOS and xcrun\n'
  exit 0
fi
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled native session binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-native-session.XXXXXX")"
cleanup() {
  local rc=$?
  rm -rf "$work_dir"
  return "$rc"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

bin_dir="$work_dir/bin"
mkdir -p "$bin_dir"
cat >"$bin_dir/xcrun" <<'EOF'
#!/usr/bin/env bash
set -u
if [ "${1:-}" != simctl ]; then exit 1; fi
shift
case "${1:-}" in
  list) printf '%s\n' '{"devices":{"iOS-1":[{"udid":"one","state":"Booted","name":"Phone","isAvailable":true}]}}' ;;
  spawn) printf 'com.example.app\n' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$bin_dir/xcrun"
cat >"$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >>"${NATIVE_SESSION_CURL_LOG:?}"
case "$*" in
  *"-X POST"*)
    count_file="${NATIVE_SESSION_POST_COUNT:?}"
    count=0
    [ -f "$count_file" ] && count="$(cat "$count_file")"
    count=$((count + 1))
    printf '%s\n' "$count" >"$count_file"
    printf '%s\n' "{\"value\":{\"sessionId\":\"created-$count\"}}"
    ;;
  *"/source"*) printf '%s\n' '<XCUIElementTypeWindow/><XCUIElementTypeButton/>' ;;
  *"/session/"*) printf '%s\n' '{"value":{"id":"live"}}' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$bin_dir/curl"

run_health() {
  local implementation="$1" state="$2" log="$3" count="$4"
  env PATH="$bin_dir:$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_NATIVE_IMPLEMENTATION="$implementation" NATIVE_SESSION_CURL_LOG="$log" \
    NATIVE_SESSION_POST_COUNT="$count" "$root/megabrain" native health phone \
    --bundle-id com.example.app --device one
}

shell_state="$work_dir/shell-state"
binary_state="$work_dir/binary-state"
mkdir -p "$shell_state" "$binary_state"
shell_log="$work_dir/shell-curl.log"
shell_count="$work_dir/shell-posts"
binary_log="$work_dir/binary-curl.log"
binary_count="$work_dir/binary-posts"

shell_first="$(run_health shell "$shell_state" "$shell_log" "$shell_count")"
shell_second="$(run_health shell "$shell_state" "$shell_log" "$shell_count")"
binary_first="$(run_health binary "$binary_state" "$binary_log" "$binary_count")"
binary_second="$(run_health binary "$binary_state" "$binary_log" "$binary_count")"

[ "$shell_first" = "$binary_first" ] || fail "shell and binary first health output differ"
[ "$shell_second" = "$binary_second" ] || fail "shell and binary reused health output differ"
[ "$(cat "$shell_count")" -eq 2 ] || fail "shell path should create one session per call"
[ "$(cat "$binary_count")" -eq 1 ] || fail "binary path should create one session for two calls"
[ "$(grep -c -- '-X POST' "$shell_log")" -eq 2 ] || fail "shell POST count was not 2"
[ "$(grep -c -- '-X POST' "$binary_log")" -eq 1 ] || fail "binary POST count was not 1"

printf 'ok: shell creates twice, binary reuses once; outputs remain identical\n'
