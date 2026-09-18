#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
binary="$root/.build/megabrain"
[ -x "$binary" ] || { printf 'skip: compiled doctor binary is missing at %s; run bun run build\n' "$binary"; exit 0; }
state_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-state-doctor.XXXXXX")"

cleanup() {
  local rc=$?
  rm -rf "$state_root"
  return "$rc"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

export HOME="$state_root/home"
export MEGABRAIN_ROOT="$root"
export MEGABRAIN_STATE_DIR="$state_root/state"
export MEGABRAIN_STATE_FILE="$MEGABRAIN_STATE_DIR/state.json"
mkdir -p "$HOME" "$MEGABRAIN_STATE_DIR" "$state_root/bin"

printf '%s\n' '#!/usr/bin/env bash' 'printf "Darwin\\n"' >"$state_root/bin/uname"
chmod +x "$state_root/bin/uname"

cat >"$state_root/bin/appium" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = driver ] && [ "${2:-}" = list ] && [ "${3:-}" = --installed ]; then
  if [ "${APPIUM_DRIVER_INSTALLED:-false}" = true ]; then
    printf 'xcuitest@12.10.0 [installed (npm)]\n'
  else
    printf 'uiautomator2@4.2.0 [installed (npm)]\n'
    exit 1
  fi
  exit 0
fi
exit 1
EOF
chmod +x "$state_root/bin/appium"
cat >"$state_root/bin/npx" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$state_root/bin/npm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$state_root/bin/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"status":"unknown","reason":"latest extension versions unavailable"}'
EOF
chmod +x "$state_root/bin/npx" "$state_root/bin/npm" "$state_root/bin/node"
export PATH="$state_root/bin:$PATH"
export APPIUM_DRIVER_INSTALLED=true

write_state() {
  local module="${2:-simulator-native}"
  jq -n --arg moduleName "$module" --argjson installed "$1" \
    '{($moduleName): {installed: $installed, details: "historical result"}}' \
    >"$MEGABRAIN_STATE_FILE"
}

write_state false
first_output="$("$binary" doctor simulator-native 2>&1)" ||
  fail 'compiled doctor did not accept an installed native simulator'
[ "$(jq -r '."simulator-native".installed' "$MEGABRAIN_STATE_FILE")" = false ] ||
  fail 'doctor changed a false state after observing the driver'
case "$first_output" in
  *'state reconciled'*) fail 'doctor reported a state reconciliation' ;;
  *) ;;
esac
printf 'stale false state is reported without mutation\n'

appium_driver_installed=false
export APPIUM_DRIVER_INSTALLED=false
write_state true
if "$binary" doctor simulator-native >/dev/null 2>&1; then
  fail 'doctor accepted a missing native simulator driver'
fi
[ "$(jq -r '."simulator-native".installed' "$MEGABRAIN_STATE_FILE")" = true ] ||
  fail 'doctor changed a true state after observing the missing driver'
printf 'stale true state is reported without mutation\n'

write_state true simulator-web
export MEGABRAIN_PLAYWRIGHT_ROOT="$state_root/playwright"
mkdir -p "$MEGABRAIN_PLAYWRIGHT_ROOT"
printf '%s\n' '{"profiles":{},"extensions":{}}' >"$MEGABRAIN_PLAYWRIGHT_ROOT/manifest.json"
if "$binary" doctor simulator-web >/dev/null 2>&1; then
  fail 'doctor accepted an unknown web simulator status'
fi
[ "$(jq -r '."simulator-web".installed' "$MEGABRAIN_STATE_FILE")" = true ] ||
  fail 'doctor changed an installed web simulator after an unknown check'
printf 'unknown web simulator status preserves the installed state without mutation\n'

printf 'ok: doctor does not stay silent when state.json disagrees with reality\n'
