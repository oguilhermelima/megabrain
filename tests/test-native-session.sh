#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'FAIL: compiled native session binary is missing at %s; run bun run build\n' "$root/.build/megabrain" >&2
  exit 1
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
# commit 21bd3b6 ("fix(native): report why accessibility tree could not be read") made
# createAppiumSession and the /source read pass -w "\n%{http_code}" and require that trailing
# status line to parse a response (appiumResponse() in src/cli/commands/native.ts) -- real curl
# appends it to stdout by default. This fake never emitted it, so createAppiumSession failed its
# own validation on every call regardless of the fake's JSON body, and nothing was ever persisted:
# both health calls silently fell back to creating a fresh session. Only the plain session-probe
# call (`curl -fsS http://.../session/<id>`, no -w) is exempt.
cat >"$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >>"${NATIVE_SESSION_CURL_LOG:?}"
has_w=false
for arg in "$@"; do [ "$arg" = "-w" ] && has_w=true; done
case "$*" in
  *"-X POST"*)
    count_file="${NATIVE_SESSION_POST_COUNT:?}"
    count=0
    [ -f "$count_file" ] && count="$(cat "$count_file")"
    count=$((count + 1))
    printf '%s\n' "$count" >"$count_file"
    printf '%s' "{\"value\":{\"sessionId\":\"created-$count\"}}"
    "$has_w" && printf '\n200'
    printf '\n'
    ;;
  *"/source"*)
    printf '%s' '<XCUIElementTypeWindow/><XCUIElementTypeButton/>'
    "$has_w" && printf '\n200'
    printf '\n'
    ;;
  *"/session/"*) printf '%s\n' '{"value":{"id":"live"}}' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$bin_dir/curl"

run_health() {
  local state="$1" log="$2" count="$3"
  env PATH="$bin_dir:$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" \
    NATIVE_SESSION_CURL_LOG="$log" \
    NATIVE_SESSION_POST_COUNT="$count" "$root/.build/megabrain" native health phone \
    --bundle-id com.example.app --device one
}

binary_state="$work_dir/binary-state"
mkdir -p "$binary_state"
binary_log="$work_dir/binary-curl.log"
binary_count="$work_dir/binary-posts"

binary_first="$(run_health "$binary_state" "$binary_log" "$binary_count")"
binary_second="$(run_health "$binary_state" "$binary_log" "$binary_count")"

[ -n "$binary_first" ] || fail 'compiled health returned no output'
[ "$binary_first" = "$binary_second" ] || fail "compiled health output changed when reusing the session"
[ "$(cat "$binary_count")" -eq 1 ] || fail "binary path should create one session for two calls"
[ "$(grep -c -- '-X POST' "$binary_log")" -eq 1 ] || fail "binary POST count was not 1"

printf 'ok: compiled native health reuses one verified session\n'
