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

bin_dir="$work/bin"
mkdir -p "$bin_dir"
cat >"$bin_dir/uname" <<'EOF'
#!/usr/bin/env bash
printf 'Darwin\n'
EOF
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
chmod +x "$bin_dir/uname" "$bin_dir/xcrun" "$bin_dir/curl"

run_health() {
  local implementation="$1" state="$2" log="$3"
  if [ "$implementation" = shell ]; then
    env PATH="$bin_dir:$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" \
      MEGABRAIN_NATIVE_IMPLEMENTATION=shell NATIVE_CAPABILITY_LOG="$log" \
      "$root/megabrain" native health phone --bundle-id com.example.app --device one >/dev/null
  else
    env PATH="$bin_dir:$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" \
      NATIVE_CAPABILITY_LOG="$log" "$root/.build/megabrain" native health phone \
      --bundle-id com.example.app --device one >/dev/null
  fi
}

shell_state="$work/shell-state"
binary_state="$work/binary-state"
mkdir -p "$shell_state" "$binary_state"
shell_log="$work/shell-body.log"
binary_log="$work/binary-body.log"
run_health shell "$shell_state" "$shell_log"
run_health binary "$binary_state" "$binary_log"

shell_body="$(sed -n '1p' "$shell_log")"
binary_body="$(sed -n '1p' "$binary_log")"
[ -n "$shell_body" ] || fail 'shell implementation did not create an Appium request'
[ -n "$binary_body" ] || fail 'binary implementation did not create an Appium request'
assert_equal "$(printf '%s' "$shell_body" | jq -S -c .)" "$(printf '%s' "$binary_body" | jq -S -c .)"
for field in platformName 'appium:isHeadless' 'appium:newCommandTimeout' 'appium:udid' 'appium:bundleId'; do
  shell_field="$(printf '%s' "$shell_body" | jq -c --arg field "$field" '.capabilities.alwaysMatch[$field]')"
  binary_field="$(printf '%s' "$binary_body" | jq -c --arg field "$field" '.capabilities.alwaysMatch[$field]')"
  assert_equal "$shell_field" "$binary_field"
done
assert_field "$shell_body" platformName '"iOS"'
assert_field "$shell_body" 'appium:isHeadless' true
assert_field "$shell_body" 'appium:newCommandTimeout' 60
assert_field "$shell_body" 'appium:udid' '"one"'
assert_field "$shell_body" 'appium:bundleId' '"com.example.app"'

printf 'ok: shell and binary send the same complete headless capability set\n'
