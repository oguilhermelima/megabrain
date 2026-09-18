#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/fixtures/entrypoint-routing.sh"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled devices binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-devices-cli.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin"
mkdir -p "$work_dir/state"
cat >"$work_dir/bin/xcrun" <<'EOF'
#!/usr/bin/env bash
if [ "$*" = "simctl list devices --json" ]; then printf '%s\n' '{"devices":{"iOS-1":[{"udid":"p","state":"Booted","name":"Phone","isAvailable":true}]}}'; exit 0; fi
exit 1
EOF
cat >"$work_dir/bin/adb" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in version) exit 0;; connect) exit 0;; devices) printf 'List of devices attached\nx:5555 device\n'; exit 0;; disconnect) printf 'disconnected\n'; exit 0;; esac
exit 1
EOF
chmod +x "$work_dir/bin/xcrun" "$work_dir/bin/adb"
run_binary() {
  local label="$1"; shift
  local output status
  set +e
  output="$(env MEGABRAIN_ROOT="$root" PATH="$work_dir/bin:$PATH" MEGABRAIN_STATE_DIR="$work_dir/state" "$root/.build/megabrain" "$@" 2>&1)"; status=$?
  set -e
  [ "$status" -eq 0 ] || { printf 'FAIL: %s status=%s output=%s\n' "$label" "$status" "$output"; exit 1; }
  printf '%s runs through the compiled CLI\n' "$label"
}
run_binary native-help native --help
run_binary native-list native sim list phone
if output="$(env MEGABRAIN_ROOT="$root" PATH="$work_dir/bin:$PATH" MEGABRAIN_STATE_DIR="$work_dir/state" "$root/.build/megabrain" native sim list bad 2>&1)"; then
  printf 'FAIL: native-invalid unexpectedly succeeded\n' >&2
  exit 1
fi
case "$output" in
  *'expected simulator kind phone or tv, got: bad'*) printf 'native-invalid refuses an invalid simulator kind\n' ;;
  *) printf 'FAIL: native-invalid output was unexpected: %s\n' "$output" >&2; exit 1 ;;
esac
run_binary tv-help tv --help
run_binary tv-connect tv connect x
run_binary tv-disconnect tv disconnect

routing_fixture="$work_dir/routing-fixture"
make_entrypoint_routing_fixture "$root" "$routing_fixture" 42
set +e
env PATH="$work_dir/bin:$PATH" MEGABRAIN_STATE_DIR="$work_dir/routing-state" \
  "$routing_fixture/megabrain" tv connect x >"$work_dir/routed-tv.out" 2>&1
routing_status=$?
set -e
[ "$routing_status" -eq 42 ] || {
  printf 'FAIL: tv entrypoint did not route to the compiled binary (status=%s, output=%s)\n' \
    "$routing_status" "$(cat "$work_dir/routed-tv.out")" >&2
  exit 1
}
printf 'tv entrypoint routing marker: %s\n' "$routing_status"
printf 'ok: compiled native and tv commands run directly\n'
