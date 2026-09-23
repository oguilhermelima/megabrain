#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/fixtures/a-dispatch-meta.sh"
state_binary="$(mktemp -d /tmp/mbclose-binary.XXXXXX)"
fake_dir="$(mktemp -d /tmp/mbclose-bin.XXXXXX)"
trap 'rm -rf "$state_binary" "$fake_dir"' EXIT
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

export PATH="$fake_dir:$PATH" MEGABRAIN_ROOT="$root" SUPERSET_TERMINAL_ID=parent-terminal

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

make_meta() {
  local state="$1" id="$2"
  export MEGABRAIN_STATE_DIR="$state" MEGABRAIN_DISPATCH_DIR="$state/dispatches"
  write_dispatch_meta "$state" "$id" \
    childHost=orca workspaceId=workspace-test terminalId="$id-terminal" state=running >/dev/null
}
run_one() {
  local state="$1" mode="$2" id="$3" out err rc
  make_meta "$state" "$id"
  export MB_CLOSE_MODE="$mode"
  set +e
  out="$("$root/.build/megabrain" orchestrate close "$id" --json 2>"$state/err")"
  rc=$?
  set -e
  err="$(cat "$state/err")"
  if [ -n "$out" ]; then
    out="$(printf '%s' "$out" | jq -c .)"
  fi
  printf '%s\t%s\t%s\t%s\n' "$rc" "$out" "$err" "$(jq -c '{state,processState,terminalState,terminalReason}' "$state/dispatches/$id/meta.json")"
}

success_binary="$(run_one "$state_binary" success close-success)"
[ "$(printf '%s' "$success_binary" | cut -f1)" = "0" ] || fail "close-success-binary-status: expected=0 actual=$(printf '%s' "$success_binary" | cut -f1)"
[ "$(printf '%s' "$success_binary" | cut -f2)" = '{"dispatchId":"close-success","status":"closed"}' ] || fail "close-success-output: $(printf '%s' "$success_binary" | cut -f2)"
[ "$(printf '%s' "$success_binary" | cut -f4 | jq -r .processState)" = stopped ] || fail 'close-success did not stop the process state'

failure_binary="$(run_one "$state_binary" failure close-failure)"
[ "$(printf '%s' "$failure_binary" | cut -f1)" = "1" ] || fail "close-failure-binary-status: expected=1 actual=$(printf '%s' "$failure_binary" | cut -f1)"
[ "$(printf '%s' "$failure_binary" | cut -f3)" = 'megabrain: could not close dispatch close-failure: terminal close denied by host' ] || fail "close-failure-reason: $(printf '%s' "$failure_binary" | cut -f3)"

empty_binary="$(run_one "$state_binary" empty close-empty)"
[ "$(printf '%s' "$empty_binary" | cut -f1)" = "1" ] || fail "close-empty-status: expected=1 actual=$(printf '%s' "$empty_binary" | cut -f1)"
[ "$(printf '%s' "$empty_binary" | cut -f3)" = 'megabrain: could not close dispatch close-empty: the host gave no reason' ] || fail "close-empty-reason: $(printf '%s' "$empty_binary" | cut -f3)"

make_meta "$state_binary" close-precedence
precedence_output="$(MEGABRAIN_STATE_DIR="$state_binary" MEGABRAIN_SESSION_ID=wrong-session SUPERSET_TERMINAL_ID=parent-terminal ORCA_TERMINAL_HANDLE=other-terminal "$root/.build/megabrain" orchestrate close close-precedence --json)"
[ "$(printf '%s' "$precedence_output" | jq -r '.status')" = closed ] || fail "Superset identity did not win caller precedence: $precedence_output"
printf '4 passed, 0 failed, 0 skipped\n'
