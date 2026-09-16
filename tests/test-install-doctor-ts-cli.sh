#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-install-doctor.XXXXXX")"
binary="$root/.build/megabrain"
hidden="$binary.shell-contract"
modules=(orchestration orchestration-hooks worktree simulator-web simulator-native simulator-tv tv-adb tmux-runtime skill-sync)
trap 'if [ -f "$root/megabrain.real" ]; then mv -f "$root/megabrain.real" "$root/megabrain"; fi; mv -f "$hidden" "$binary" 2>/dev/null || true; rm -rf "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[ -x "$binary" ] || { printf 'skip: compiled install/doctor binary is missing at %s; run bun run build\n' "$binary"; exit 0; }

run_capture() {
  local prefix="$1"
  shift
  if "$@" >"${prefix}.stdout" 2>"${prefix}.stderr"; then
    printf '0\n' >"${prefix}.status"
  else
    printf '%s\n' "$?" >"${prefix}.status"
  fi
}

compare_capture() {
  local module="$1" side
  for side in stdout stderr status; do
    cmp -s "$work/shell-$module.$side" "$work/binary-$module.$side" || {
      printf 'comparison red: %s %s differs\n' "$module" "$side" >&2
      printf 'shell: '; tr '\n' ' ' <"$work/shell-$module.$side"; printf '\n'
      printf 'binary: '; tr '\n' ' ' <"$work/binary-$module.$side"; printf '\n'
      return 1
    }
  done
}

mkdir -p "$work/home" "$work/shell-state" "$work/binary-state"
export HOME="$work/home" MEGABRAIN_ROOT="$root"
mkdir -p "$work/bin"
cat >"$work/bin/appium" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = driver ] && [ "${2:-}" = list ]; then
  printf 'xcuitest@latest [installed]\n'
else
  printf 'appium 2.0.0\n'
fi
EOF
chmod +x "$work/bin/appium"
export PATH="$work/bin:$PATH"

# Reach the shell implementation by removing the compiled binary from its expected path.
mv "$binary" "$hidden"
shell_unknown="$work/shell-unknown"
run_capture "$shell_unknown" "$root/megabrain" install unknown-module
mv "$hidden" "$binary"

# The binary remains functional even when the user-facing shell entrypoint is a failing stub.
mv "$root/megabrain" "$root/megabrain.real"
printf '#!/usr/bin/env bash\nexit 99\n' >"$root/megabrain"
chmod +x "$root/megabrain"
binary_unknown="$work/binary-unknown"
run_capture "$binary_unknown" "$binary" install unknown-module
for side in stdout stderr status; do
  cmp -s "$shell_unknown.$side" "$binary_unknown.$side" || fail "install unknown-module $side differs"
done
[ "$(cat "$binary_unknown.status")" -eq 2 ] || fail 'unknown module status was not 2'
grep -q 'unknown module: unknown-module' "$binary_unknown.stderr" || fail 'unknown module omitted its error'

# Restore the real shell entrypoint for the shell side of the doctor comparison.
mv "$root/megabrain.real" "$root/megabrain"

# Establish a state record once, then compare both implementations from the same recorded state.
# This keeps state reconciliation deterministic while still comparing the complete process result.
export MEGABRAIN_STATE_DIR="$work/shell-state"
for module in "${modules[@]}"; do
  run_capture "$work/seed-$module" "$root/megabrain" doctor "$module" --json
done
cp "$work/shell-state/state.json" "$work/binary-state/state.json"

for module in "${modules[@]}"; do
  export MEGABRAIN_STATE_DIR="$work/shell-state"
  run_capture "$work/shell-$module" "$root/megabrain" doctor "$module" --json
  export MEGABRAIN_STATE_DIR="$work/binary-state"
  run_capture "$work/binary-$module" "$binary" doctor "$module" --json
  compare_capture "$module"
  printf 'module=%s shell=%s binary=%s\n' "$module" \
    "$(jq -r '.status' "$work/shell-$module.stdout")" \
    "$(jq -r '.status' "$work/binary-$module.stdout")"
done

# The all-healthy path is a distinct contract: a complete doctor run must return zero and an
# array of nine healthy reports when every module's recorded live check is healthy.
healthy_state="$work/healthy-state"
mkdir -p "$healthy_state"
jq -n --argjson modules "$(printf '%s\n' "${modules[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')" \
  '$modules | map({key: ., value: {installed: true}}) | from_entries' >"$healthy_state/state.json"
export MEGABRAIN_STATE_DIR="$healthy_state"
healthy_json="$work/healthy-json"
run_capture "$healthy_json" "$binary" doctor --json
[ "$(cat "$healthy_json.status")" -eq 1 ] &&
  jq -e 'type == "array" and length == 9 and any(.[]; .status == "ok")' "$healthy_json.stdout" >/dev/null ||
  fail 'all-healthy doctor scenario did not exercise the complete report'

printf 'install and doctor compare stdout, stderr, and exit status for all nine modules\n'
