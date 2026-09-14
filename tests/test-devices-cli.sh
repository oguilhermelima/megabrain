#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled devices binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-devices-cli.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin"
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
run_pair() {
  local label="$1"; shift
  local shell_out binary_out shell_rc binary_rc
  set +e
  shell_out="$(env MEGABRAIN_ROOT="$root" PATH="$work_dir/bin:$PATH" MEGABRAIN_STATE_DIR="$work_dir/state" MEGABRAIN_NATIVE_IMPLEMENTATION=shell MEGABRAIN_TV_IMPLEMENTATION=shell "$root/megabrain" "$@" 2>&1)"; shell_rc=$?
  binary_out="$(env MEGABRAIN_ROOT="$root" PATH="$work_dir/bin:$PATH" MEGABRAIN_STATE_DIR="$work_dir/state" "$root/.build/megabrain" "$@" 2>&1)"; binary_rc=$?
  set -e
  [ "$shell_rc" -eq "$binary_rc" ] || { printf 'FAIL: %s status shell=%s binary=%s\n' "$label" "$shell_rc" "$binary_rc"; exit 1; }
  [ "$shell_out" = "$binary_out" ] || { printf 'FAIL: %s output differs\nshell=%s\nbinary=%s\n' "$label" "$shell_out" "$binary_out"; exit 1; }
  printf '%s agrees between shell and binary\n' "$label"
}
run_pair native-help native --help
run_pair native-list native sim list phone
run_pair native-invalid native sim list bad
run_pair tv-help tv --help
run_pair tv-connect tv connect x
run_pair tv-disconnect tv disconnect
printf 'ok: native and tv implementations agree\n'
