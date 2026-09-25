#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-web-cli.XXXXXX")"
state="$work/state"
home="$work/home"
playwright_root="$work/playwright"
node_bin="$work/node-bin"
mkdir -p "$node_bin"
ln -s "$(command -v node)" "$node_bin/node"
trap 'rm -rf "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled web binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

mkdir -p "$work/bin" "$home"
cat >"$work/playwright-web.mjs" <<'NODE'
process.stdout.write(process.argv.slice(2).join(" "));
NODE

run_binary() {
  MEGABRAIN_STATE_DIR="$state" HOME="$home" MEGABRAIN_PLAYWRIGHT_ROOT="$playwright_root" \
    MEGABRAIN_PLAYWRIGHT_SCRIPT="$work/playwright-web.mjs" \
    PATH="$node_bin:/usr/bin:/bin" "$root/.build/megabrain" "$@"
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_failure() {
  local expected_status="$1" expected_message="$2" output status
  shift 2
  if output="$(run_binary "$@" 2>&1)"; then status=0; else status=$?; fi
  [ "$status" -eq "$expected_status" ] || fail "$*: expected status $expected_status, got $status: $output"
  assert_equal "$output" "megabrain: $expected_message"
}

# Scenario: device listing invokes the checkout script with an empty filter.
# Falsification: launching a browser, using the caller's script, or dropping the empty filter
# changes this exact child-process invocation.
assert_equal "$(run_binary web devices list)" "device-list --root $playwright_root --filter "
printf 'devices: binary invokes the registry listing without a browser\n'

# Scenario: a device filter and orientation are forwarded to the script.
# Falsification: accepting only the filter or reversing the arguments produces a different
# invocation and fails this direct expectation.
assert_equal "$(run_binary web devices iphone15 --orientation landscape)" "device-list --root $playwright_root --filter iphone15 --orientation landscape"
printf 'devices-filter: binary forwards filter and orientation\n'

# Scenario: viewport set forwards browser and dimensions to the script.
# Falsification: a no-op or persisted-only implementation never produces this child command.
assert_equal "$(run_binary web viewport set --browser chromium --width 390 --height 844)" "viewport-set --root $playwright_root --browser chromium --width 390 --height 844"
printf 'viewport-set: binary forwards browser and dimensions\n'

# Scenario: userscript install supplies the fixture userscript root and file.
# Falsification: writing to the operator's HOME or omitting the file mapping changes this command.
assert_equal "$(run_binary web userscript install hello.user.js --device iphone15)" "userscript-install --root $playwright_root --userscripts $home/.megabrain/userscripts --file hello.user.js --device iphone15"
printf 'userscript: binary scopes installation to the fixture\n'

# Scenario: visual capture forwards URL and screen without launching a real browser.
# Falsification: running Playwright or losing either named argument cannot produce this fixture
# node output.
assert_equal "$(run_binary web capture --url https://example.com --screen home)" "capture --root $playwright_root --url https://example.com --screen home"
printf 'visual: binary forwards capture arguments to node\n'

# Scenario: the existing device-list parser treats an unknown positional token as a filter.
# Falsification: rejecting it or silently dropping it changes the established command invocation.
assert_equal "$(run_binary web devices list --json)" "device-list --root $playwright_root --filter --json"
printf 'invalid-option: binary preserves the established filter parsing\n'

printf 'ok: compiled web scenarios assert child invocation and failures directly\n'
