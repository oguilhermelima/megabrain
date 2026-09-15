#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_shell="$(mktemp -d /tmp/mbclose-shell.XXXXXX)"
state_binary="$(mktemp -d /tmp/mbclose-binary.XXXXXX)"
fake_dir="$(mktemp -d /tmp/mbclose-bin.XXXXXX)"
trap 'rm -rf "$state_shell" "$state_binary" "$fake_dir"' EXIT
cat >"$fake_dir/orca" <<'EOF'
#!/usr/bin/env bash
if [ "${MB_CLOSE_MODE:-success}" = failure ]; then
  printf '%s\n' '{"error":{"message":"terminal close denied by host"}}' >&2
  exit 1
fi
if [ "${MB_CLOSE_MODE:-success}" = empty ]; then
  exit 1
fi
printf '%s\n' '{"ok":true}'
EOF
chmod +x "$fake_dir/orca"

source "$root/lib/common.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
export PATH="$fake_dir:$PATH" MEGABRAIN_ROOT="$root" SUPERSET_TERMINAL_ID=parent-terminal

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

orca() {
  if [ "${MB_CLOSE_MODE:-success}" = failure ]; then
    printf '%s\n' '{"error":{"message":"terminal close denied by host"}}' >&2
    return 1
  fi
  if [ "${MB_CLOSE_MODE:-success}" = empty ]; then
    return 1
  fi
  printf '%s\n' '{"ok":true}'
}

make_meta() {
  local state="$1" id="$2"
  export MEGABRAIN_STATE_DIR="$state" MEGABRAIN_DISPATCH_DIR="$state/dispatches"
  megabrain_dispatch_meta_write "$id" parent-terminal superset orca workspace-test "$id-terminal" "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
}
run_one() {
  local implementation="$1" state="$2" mode="$3" id="$4" out err rc
  make_meta "$state" "$id"
  export MEGABRAIN_ORCHESTRATE_CLOSE_IMPLEMENTATION="$implementation" MB_CLOSE_MODE="$mode"
  set +e
  out="$(command_orchestrate close "$id" --json 2>"$state/err")"
  rc=$?
  set -e
  err="$(cat "$state/err")"
  if [ -n "$out" ]; then
    out="$(printf '%s' "$out" | jq -c .)"
  fi
  printf '%s\t%s\t%s\t%s\n' "$rc" "$out" "$err" "$(jq -c '{state,terminalState,terminalReason}' "$state/dispatches/$id/meta.json")"
}

success_shell="$(run_one shell "$state_shell" success close-success)"
success_binary="$(run_one binary "$state_binary" success close-success)"
[ "$success_shell" = "$success_binary" ] || fail "close-success: shell=$success_shell binary=$success_binary"
[ "$(printf '%s' "$success_shell" | cut -f1)" = "0" ] || fail "close-success-shell-status: expected=0 actual=$(printf '%s' "$success_shell" | cut -f1)"
[ "$(printf '%s' "$success_binary" | cut -f1)" = "0" ] || fail "close-success-binary-status: expected=0 actual=$(printf '%s' "$success_binary" | cut -f1)"
[ "$(printf '%s' "$success_shell" | cut -f2)" = "$(printf '%s' "$success_binary" | cut -f2)" ] || fail "close-success-output: shell=$(printf '%s' "$success_shell" | cut -f2) binary=$(printf '%s' "$success_binary" | cut -f2)"

failure_shell="$(run_one shell "$state_shell" failure close-failure)"
failure_binary="$(run_one binary "$state_binary" failure close-failure)"
[ "$(printf '%s' "$failure_shell" | cut -f1)" = "1" ] || fail "close-failure-shell-status: expected=1 actual=$(printf '%s' "$failure_shell" | cut -f1)"
[ "$(printf '%s' "$failure_binary" | cut -f1)" = "1" ] || fail "close-failure-binary-status: expected=1 actual=$(printf '%s' "$failure_binary" | cut -f1)"
[ "$failure_shell" = "$failure_binary" ] || fail "close-failure: shell=$failure_shell binary=$failure_binary"

empty_shell="$(run_one shell "$state_shell" empty close-empty)"
empty_binary="$(run_one binary "$state_binary" empty close-empty)"
[ "$empty_shell" = "$empty_binary" ] || fail "close-empty: shell=$empty_shell binary=$empty_binary"
printf '3 passed, 0 failed, 0 skipped\n'
