#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-native-capabilities.XXXXXX")"
trap 'rm -rf "$work"' EXIT
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'FAIL: compiled native binary is missing at %s; run bun run build\n' "$root/.build/megabrain" >&2
  exit 1
fi

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_field() {
  local body="$1" field="$2" expected="$3" actual
  actual="$(printf '%s' "$body" | jq -c --arg field "$field" '.capabilities.alwaysMatch[$field]')"
  assert_equal "$actual" "$expected"
}

state="$work/state"
bin_dir="$work/bin"
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
cat >"$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -u
body=''
previous=''
for argument in "$@"; do
  if [ "$previous" = -d ]; then body="$argument"; fi
  previous="$argument"
done
if [ -n "$body" ]; then
  printf '%s\n' "$body" >>"${NATIVE_CAPABILITY_LOG:?}"
  printf '%s\n' '{"value":{"sessionId":"session-1"}}'
elif printf '%s' "$*" | grep -Fq '/source'; then
  printf '%s\n' '<XCUIElementTypeWindow/>'
elif printf '%s' "$*" | grep -Fq '/session/'; then
  printf '%s\n' '{}'
else
  exit 1
fi
EOF
chmod +x "$bin_dir/xcrun" "$bin_dir/curl"

run_binary() {
  local log="$1"
  env PATH="$bin_dir:$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" \
    NATIVE_CAPABILITY_LOG="$log" "$root/.build/megabrain" native health phone \
    --bundle-id com.example.app --device one >/dev/null
}

mkdir -p "$state"
binary_log="$work/binary-body.log"
run_binary "$binary_log"

binary_body="$(sed -n '1p' "$binary_log")"
[ -n "$binary_body" ] || fail 'binary implementation did not create an Appium request'
assert_equal "$(printf '%s' "$binary_body" | jq -r '.capabilities.alwaysMatch | keys | sort | join(",")')" 'appium:bundleId,appium:isHeadless,appium:newCommandTimeout,appium:udid,platformName'
assert_field "$binary_body" platformName '"iOS"'
assert_field "$binary_body" 'appium:isHeadless' true
assert_field "$binary_body" 'appium:newCommandTimeout' 60
assert_field "$binary_body" 'appium:udid' '"one"'
assert_field "$binary_body" 'appium:bundleId' '"com.example.app"'

printf 'ok: compiled native health sends the complete headless capability set\n'
