#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-install-doctor.XXXXXX")"
binary="$root/.build/megabrain"
hidden="$binary.shell-contract"
trap 'if [ -f "$root/megabrain.real" ]; then mv -f "$root/megabrain.real" "$root/megabrain"; fi; mv -f "$hidden" "$binary" 2>/dev/null || true; rm -rf "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[ -x "$binary" ] || { printf 'skip: compiled install/doctor binary is missing at %s; run bun run build\n' "$binary"; exit 0; }
mkdir -p "$work/home" "$work/state"
export HOME="$work/home" MEGABRAIN_STATE_DIR="$work/state" MEGABRAIN_ROOT="$root"

# Reach the shell implementation by removing the compiled binary from its expected path.
mv "$binary" "$hidden"
shell_unknown="$work/shell-unknown"
if "$root/megabrain" install unknown-module >"$shell_unknown" 2>&1; then
  shell_status=0
else
  shell_status=$?
fi
[ "$shell_status" -eq 2 ] || fail "shell install unknown module status was $shell_status"
grep -q 'unknown module: unknown-module' "$shell_unknown" || fail 'shell install unknown module omitted its error'
shell_doctor="$work/shell-doctor"
if "$root/megabrain" doctor simulator-native >"$shell_doctor" 2>&1; then
  shell_doctor_status=0
else
  shell_doctor_status=$?
fi
[ "$shell_doctor_status" -ne 0 ] || fail 'shell doctor simulator-native unexpectedly succeeded'
[ -s "$shell_doctor" ] || fail 'shell doctor produced no report'
mv "$hidden" "$binary"

# The binary remains functional even when the user-facing shell entrypoint is a failing stub.
shell_stub="$root/megabrain.real"
mv "$root/megabrain" "$shell_stub"
printf '#!/usr/bin/env bash\nexit 99\n' >"$root/megabrain"
chmod +x "$root/megabrain"
binary_unknown="$work/binary-unknown"
if "$binary" install unknown-module >"$binary_unknown" 2>&1; then
  binary_status=0
else
  binary_status=$?
fi
[ "$binary_status" -eq 2 ] || fail "binary install unknown module status was $binary_status"
grep -q 'unknown module: unknown-module' "$binary_unknown" || fail 'binary install unknown module omitted its error'

binary_json="$work/binary-json"
if "$binary" doctor simulator-native --json >"$binary_json" 2>"$work/binary-advice"; then
  binary_doctor_status=0
else
  binary_doctor_status=$?
fi
[ "$binary_doctor_status" -ne 0 ] || fail 'binary doctor simulator-native unexpectedly succeeded'
jq -e '.module == "simulator-native" and (.status | type == "string")' "$binary_json" >/dev/null || fail 'binary doctor JSON was not a module report'

all_json="$work/all-json"
"$binary" doctor --json >"$all_json" 2>"$work/all-advice" || all_status=$?
all_status=${all_status:-0}
[ "$all_status" -ne 0 ] || fail 'doctor all unexpectedly succeeded in the fixture environment'
jq -e 'type == "array" and length > 0 and all(.[]; has("module") and has("status"))' "$all_json" >/dev/null || fail 'doctor all JSON was invalid or incomplete'

# A stale install record must not turn an unhealthy current doctor result into healthy.
printf '%s\n' '{"simulator-native":{"installed":true}}' >"$work/state/state.json"
stale_json="$work/stale-json"
"$binary" doctor simulator-native --json >"$stale_json" 2>/dev/null || true
jq -e '.module == "simulator-native" and .status != "ok"' "$stale_json" >/dev/null || fail 'doctor trusted stale install state'

printf 'install and doctor shell and binary scenarios are asserted\n'
