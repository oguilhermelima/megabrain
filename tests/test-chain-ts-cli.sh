#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-chain-ts.XXXXXX")"
binary="$root/.build/megabrain"
trap 'rm -rf "$state"' EXIT
export MEGABRAIN_ROOT="$root"
export HOME="$state/home"
mkdir -p "$HOME/.codex/sessions"

compare() {
  local label="$1"; shift
  local shell_stdout shell_stderr binary_stdout binary_stderr shell_status binary_status
  shell_stdout="$state/shell.stdout"; shell_stderr="$state/shell.stderr"
  binary_stdout="$state/binary.stdout"; binary_stderr="$state/binary.stderr"
  if MEGABRAIN_CHAIN_IMPLEMENTATION=shell "$root/megabrain" "$@" >"$shell_stdout" 2>"$shell_stderr"; then shell_status=0; else shell_status=$?; fi
  if "$binary" "$@" >"$binary_stdout" 2>"$binary_stderr"; then binary_status=0; else binary_status=$?; fi
  cmp -s "$shell_stdout" "$binary_stdout" || { printf '%s stdout differs\n' "$label" >&2; return 1; }
  cmp -s "$shell_stderr" "$binary_stderr" || { printf '%s stderr differs\n' "$label" >&2; return 1; }
  [ "$shell_status" -eq "$binary_status" ] || { printf '%s status differs\n' "$label" >&2; return 1; }
}

# command_chain execs the compiled binary unconditionally for `limits`
# (MEGABRAIN_CHAIN_IMPLEMENTATION has no effect on it), so compare() above would
# compare the binary with itself for this verb. The codex reader it must actually
# stay faithful to is megabrain_chain_limit_read, which is still in
# lib/module-chain.sh — kept there for hooks/megabrain-turn-end.sh's
# megabrain_chain_continue_refused, not reachable through `megabrain` at all. This
# drives that shell function directly (in a subshell, so it cannot leak state into
# the rest of this script) and compares its per-window result with the binary's
# `chain limits --json` row for the same (provider, window).
shell_codex_reading() {
  local window="$1"
  (
    source "$root/lib/common.sh"
    source "$root/lib/module-chain.sh"
    megabrain_chain_limit_read codex "$window"
    fetched_json=null
    [ -z "$MEGABRAIN_CHAIN_LIMIT_FETCHED_AT" ] || fetched_json="$MEGABRAIN_CHAIN_LIMIT_FETCHED_AT"
    used_json=null
    [ -z "$MEGABRAIN_CHAIN_LIMIT_USED" ] || used_json="$MEGABRAIN_CHAIN_LIMIT_USED"
    resets_json=null
    [ -z "$MEGABRAIN_CHAIN_LIMIT_RESETS" ] || resets_json="\"$MEGABRAIN_CHAIN_LIMIT_RESETS\""
    jq -cn --arg status "$MEGABRAIN_CHAIN_LIMIT_STATUS" --arg reason "$MEGABRAIN_CHAIN_LIMIT_REASON" \
      --argjson usedPercent "$used_json" --argjson resetsAt "$resets_json" --argjson fetchedAtIsNull "$([ "$fetched_json" = null ] && printf true || printf false)" \
      '{status: $status, usedPercent: $usedPercent, resetsAt: $resetsAt, fetchedAtIsNull: $fetchedAtIsNull, reason: $reason}'
  )
}

binary_codex_reading() {
  local window="$1" output="$2"
  jq -c --arg window "$window" '
    map(select(.provider == "codex" and .window == $window)) | .[0] |
    {status, usedPercent, resetsAt, fetchedAtIsNull: (.fetchedAt == null), reason}
  ' <<<"$output"
}

export MEGABRAIN_STATE_DIR="$state/empty-state"
mkdir -p "$MEGABRAIN_STATE_DIR"
compare "empty list" chain list --json
compare "missing snapshot limits" chain limits --json
compare "shell-only selection" chain select --json

printf '%s\n' '{"payload":{"rate_limits":{"primary":{"used_percent":42,"window_minutes":300,"resets_at":1}}}}' >"$HOME/.codex/sessions/rollout-stale.jsonl"
compare "stale snapshot limits" chain limits --json
touch -t 202001010000 "$HOME/.codex/sessions/rollout-stale.jsonl"
cp "$root/tests/fixtures/codex-rollout-incomplete-usage.jsonl" "$HOME/.codex/sessions/rollout-incomplete-usage.jsonl"
binary_incomplete_output="$("$binary" chain limits --json)"
for window in 5h weekly; do
  shell_reading="$(shell_codex_reading "$window")"
  binary_reading="$(binary_codex_reading "$window" "$binary_incomplete_output")"
  [ "$shell_reading" = "$binary_reading" ] || {
    printf 'incomplete usage limits codex %s differs: shell=%s binary=%s\n' "$window" "$shell_reading" "$binary_reading" >&2
    exit 1
  }
done
printf 'incomplete usage limits: codex 5h/weekly match megabrain_chain_limit_read\n'
printf 'chain compiled contract: passed\n'
