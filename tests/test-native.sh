#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ "$(uname -s 2>/dev/null || printf unknown)" != Darwin ] || ! command -v xcrun >/dev/null 2>&1; then
  printf 'skip: native simulator tests require macOS and xcrun\n'
  exit 0
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-native.XXXXXX")"
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

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$1' to contain '$2'" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "expected '$1' not to contain '$2'" ;;
    *) ;;
  esac
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

bin_dir="$work_dir/bin"
mkdir -p "$bin_dir" "$work_dir/worktree/.megabrain"
cat >"$bin_dir/xcrun" <<'EOF'
#!/usr/bin/env bash
set -u

log="${SIMCTL_LOG:?}"
printf '%s\n' "$*" >>"$log"
if [ "${1:-}" != simctl ]; then
  printf 'unexpected xcrun command\n' >&2
  exit 1
fi
shift
case "${1:-}" in
  list)
    if [ -f "${SIMCTL_BOOT_MARKER:-}" ] && [ -n "${SIMCTL_BOOTED_JSON:-}" ]; then
      cat "$SIMCTL_BOOTED_JSON"
    else
      cat "$SIMCTL_DEVICES_JSON"
    fi
    ;;
  boot)
    if [ "${SIMCTL_BOOT_STATUS:-0}" -ne 0 ]; then
      printf 'boot failed\n' >&2
      exit "$SIMCTL_BOOT_STATUS"
    fi
    [ -n "${SIMCTL_BOOT_MARKER:-}" ] && : >"$SIMCTL_BOOT_MARKER"
    ;;
  terminate)
    if [ "${SIMCTL_TERMINATE_STATUS:-0}" -ne 0 ]; then
      printf '%s\n' "${SIMCTL_TERMINATE_ERROR:-Process is not running}" >&2
      exit "$SIMCTL_TERMINATE_STATUS"
    fi
    ;;
  openurl)
    if [ "${SIMCTL_OPENURL_STATUS:-0}" -ne 0 ]; then
      printf 'openurl failed\n' >&2
      exit "$SIMCTL_OPENURL_STATUS"
    fi
    ;;
  *)
    printf 'unexpected simctl operation: %s\n' "${1:-}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$bin_dir/xcrun"
cat >"$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >>"${SIMCTL_CURL_LOG:?}"
if [ "${SIMCTL_METRO_READY:-false}" = true ]; then
  exit 0
fi
exit 22
EOF
chmod +x "$bin_dir/curl"

cat >"$work_dir/shutdown.json" <<'EOF'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"phone-1","name":"iPhone","state":"Shutdown","isAvailable":true},{"udid":"phone-2","name":"iPhone Other","state":"Shutdown","isAvailable":true}],"com.apple.CoreSimulator.SimRuntime.tvOS-26-5":[{"udid":"tv-1","name":"Apple TV","state":"Shutdown","isAvailable":true}]}}
EOF
cat >"$work_dir/booted.json" <<'EOF'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"phone-1","name":"iPhone","state":"Booted","isAvailable":true},{"udid":"phone-2","name":"iPhone Other","state":"Booted","isAvailable":true}],"com.apple.CoreSimulator.SimRuntime.tvOS-26-5":[{"udid":"tv-1","name":"Apple TV","state":"Booted","isAvailable":true}]}}
EOF
cat >"$work_dir/tv-only.json" <<'EOF'
{"devices":{"com.apple.CoreSimulator.SimRuntime.tvOS-26-5":[{"udid":"tv-1","name":"Apple TV","state":"Shutdown","isAvailable":true}]}}
EOF
cat >"$work_dir/multiple.json" <<'EOF'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"phone-1","name":"iPhone","state":"Shutdown","isAvailable":true},{"udid":"phone-2","name":"iPhone 2","state":"Shutdown","isAvailable":true}]}}
EOF

export PATH="$bin_dir:$PATH"
export SIMCTL_LOG="$work_dir/simctl.log"
export SIMCTL_CURL_LOG="$work_dir/curl.log"
export SIMCTL_DEVICES_JSON="$work_dir/shutdown.json"
export SIMCTL_BOOTED_JSON="$work_dir/booted.json"
export SIMCTL_BOOT_MARKER="$work_dir/booted.marker"
export SIMCTL_BOOT_STATUS=0
export SIMCTL_TERMINATE_STATUS=0
export SIMCTL_OPENURL_STATUS=0
export SIMCTL_METRO_READY=true

source "$root/lib/common.sh"
source "$root/lib/module-native.sh"

printf 'scenario: ensure waits for a usable phone simulator\n'
rm -f "$SIMCTL_BOOT_MARKER" "$SIMCTL_LOG"
output="$(command_native sim ensure phone --device phone-1 --timeout 1)" || fail "ensure failed: $output"
assert_contains "$output" 'simulator phone-1 is booted'
assert_contains "$(cat "$SIMCTL_LOG")" 'simctl boot phone-1'

printf 'scenario: templates render exact phone and tv URLs without config\n'
SIMCTL_DEVICES_JSON="$SIMCTL_BOOTED_JSON" SIMCTL_METRO_READY=true
rm -f "$SIMCTL_LOG"
phone_output="$(command_native app reload phone --route deep/link --bundle-id com.example.phone --url-template 'exp://127.0.0.1:{metro_port}/--/{route}' --device iPhone --metro-port 8082 --timeout 1)" || fail "phone reload failed: $phone_output"
assert_contains "$phone_output" 'exp://127.0.0.1:8082/--/deep/link'
assert_equal "$(tail -1 "$SIMCTL_LOG")" 'simctl openurl phone-1 exp://127.0.0.1:8082/--/deep/link'
rm -f "$SIMCTL_LOG"
tv_output="$(command_native app reload tv --route deep/link --bundle-id com.example.tv --url-template 'canto:///{route}' --device tv-1 --metro-port none --timeout 1)" || fail "tv reload failed: $tv_output"
assert_contains "$tv_output" 'canto:///deep/link'
assert_equal "$(tail -1 "$SIMCTL_LOG")" 'simctl openurl tv-1 canto:///deep/link'

printf 'scenario: terminate precedes openurl and a stopped app is tolerated\n'
printf 'Process is not running\n' >/dev/null
SIMCTL_TERMINATE_STATUS=3 SIMCTL_TERMINATE_ERROR='Process is not running' rm -f "$SIMCTL_LOG"
output="$(SIMCTL_TERMINATE_STATUS=3 SIMCTL_TERMINATE_ERROR='Process is not running' command_native app reload phone --route route --bundle-id com.example.phone --url-template 'exp://127.0.0.1:{metro_port}/--/{route}' --device phone-1 --metro-port 8082 --timeout 1)" || fail "reload treated a stopped app as an error: $output"
calls="$(cat "$SIMCTL_LOG")"
assert_contains "$calls" 'simctl terminate phone-1 com.example.phone'
assert_contains "$calls" 'simctl openurl phone-1 exp://127.0.0.1:8082/--/route'
terminate_line="$(grep -n 'simctl terminate' "$SIMCTL_LOG" | cut -d: -f1)"
openurl_line="$(grep -n 'simctl openurl' "$SIMCTL_LOG" | cut -d: -f1)"
[ "$terminate_line" -lt "$openurl_line" ] || fail 'openurl ran before terminate'
assert_not_contains "$output" 'rendered'

printf 'scenario: config supplies surface defaults\n'
cat >"$work_dir/worktree/.megabrain/native.json" <<'EOF'
{"version":1,"surfaces":{"phone":{"urlTemplate":"exp://127.0.0.1:{metro_port}/--/{route}","bundleId":"com.config.phone","metroPort":"8082","device":"iPhone"},"tv":{"urlTemplate":"canto:///{route}","bundleId":"com.config.tv","metroPort":"none","device":"Apple TV"}}}
EOF
rm -f "$SIMCTL_LOG"
config_output="$(cd "$work_dir/worktree" && command_native app reload phone --route configured --timeout 1)" || fail "config reload failed: $config_output"
assert_contains "$config_output" 'exp://127.0.0.1:8082/--/configured'
assert_contains "$(cat "$SIMCTL_LOG")" 'simctl terminate phone-1 com.config.phone'

printf 'scenario: simulator listing reuses candidates in plain output and JSON\n'
SIMCTL_DEVICES_JSON="$root/tests/fixtures/native-simctl-list.json"
rm -f "$SIMCTL_LOG"
list_output="$(command_native sim list phone)" || fail "phone list failed: $list_output"
assert_contains "$list_output" 'iPhone 17 Pro'
assert_contains "$list_output" 'Shutdown'
assert_contains "$list_output" '82626DF1-0880-48A7-A63F-ABAE8BBB9D03'
assert_not_contains "$list_output" 'Apple TV'
list_json="$(command_native sim list tv --json)" || fail "tv list failed: $list_json"
assert_equal "$(printf '%s' "$list_json" | jq -r '.kind')" tv
assert_equal "$(printf '%s' "$list_json" | jq -r '.devices | length')" 3
assert_equal "$(printf '%s' "$list_json" | jq -r '.devices[0].name')" 'Apple TV 4K (3rd generation)'
[ "$(grep -c 'simctl list devices --json' "$SIMCTL_LOG")" -eq 1 ] || fail 'list did not reuse a single candidate query'

printf 'scenario: names select uniquely and missing or ambiguous names fail loudly\n'
SIMCTL_DEVICES_JSON="$SIMCTL_BOOTED_JSON"
name_output="$(command_native app reload phone --route named --bundle-id com.named.phone --url-template 'exp://127.0.0.1:{metro_port}/--/{route}' --device iPhone --metro-port 8082 --timeout 1)" || fail "name selection failed: $name_output"
assert_contains "$(cat "$SIMCTL_LOG")" 'simctl openurl phone-1 exp://127.0.0.1:8082/--/named'
if output="$(command_native sim ensure phone --device 'Missing iPhone' --timeout 1 2>&1)"; then fail 'missing device name unexpectedly succeeded'; fi
assert_contains "$output" 'no iOS simulator matches device name Missing iPhone'
cat >"$work_dir/duplicate-name.json" <<'EOF'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"phone-1","name":"iPhone","state":"Shutdown","isAvailable":true},{"udid":"phone-2","name":"iPhone","state":"Shutdown","isAvailable":true}]}}
EOF
SIMCTL_DEVICES_JSON="$work_dir/duplicate-name.json"
if output="$(command_native sim ensure phone --device iPhone --timeout 1 2>&1)"; then fail 'ambiguous device name unexpectedly succeeded'; fi
assert_contains "$output" 'more than one iOS simulator matches name iPhone'

printf 'scenario: configured device defaults apply to ensure\n'
SIMCTL_DEVICES_JSON="$work_dir/shutdown.json"
rm -f "$SIMCTL_BOOT_MARKER" "$SIMCTL_LOG"
configured_output="$(cd "$work_dir/worktree" && command_native sim ensure phone --timeout 1)" || fail "configured ensure failed: $configured_output"
assert_contains "$configured_output" 'simulator phone-1 is booted'
assert_contains "$(cat "$SIMCTL_LOG")" 'simctl boot phone-1'

printf 'scenario: simulator selection and wait errors stay distinct\n'
rm -f "$SIMCTL_BOOT_MARKER"
SIMCTL_DEVICES_JSON="$work_dir/tv-only.json"
if output="$(command_native sim ensure phone --timeout 1 2>&1)"; then fail 'zero matching devices unexpectedly succeeded'; fi
assert_contains "$output" 'no iOS simulator matches'
SIMCTL_DEVICES_JSON="$work_dir/multiple.json"
if output="$(command_native sim ensure phone --timeout 1 2>&1)"; then fail 'multiple devices unexpectedly succeeded'; fi
assert_contains "$output" 'more than one iOS simulator matches'
SIMCTL_DEVICES_JSON="$work_dir/shutdown.json"
SIMCTL_BOOT_STATUS=1
if output="$(command_native sim ensure phone --device phone-1 --timeout 1 2>&1)"; then fail 'boot failure unexpectedly succeeded'; fi
assert_contains "$output" 'failed to boot simulator phone-1'
SIMCTL_BOOT_STATUS=0
SIMCTL_BOOTED_JSON="$work_dir/shutdown.json"
rm -f "$SIMCTL_BOOT_MARKER"
if output="$(command_native sim ensure phone --device phone-1 --timeout 1 2>&1)"; then fail 'boot timeout unexpectedly succeeded'; fi
assert_contains "$output" 'timed out waiting for simulator phone-1'
rm -f "$SIMCTL_BOOT_MARKER"
SIMCTL_DEVICES_JSON="$work_dir/shutdown.json"
if output="$(command_native app reload phone --bundle-id com.example.phone --url-template 'exp://127.0.0.1:{metro_port}/--/{route}' --metro-port 8082 --timeout 1 2>&1)"; then fail 'reload without a booted simulator unexpectedly succeeded'; fi
assert_contains "$output" 'no booted iOS simulator'
SIMCTL_DEVICES_JSON="$work_dir/booted.json"
SIMCTL_METRO_READY=false
if output="$(command_native app reload phone --bundle-id com.example.phone --url-template 'exp://127.0.0.1:{metro_port}/--/{route}' --device phone-1 --metro-port 8082 --timeout 1 2>&1)"; then fail 'Metro failure unexpectedly succeeded'; fi
assert_contains "$output" 'Metro did not answer on port 8082'

printf 'ok: native ensure and app reload scenarios\n'
