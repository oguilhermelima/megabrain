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

# megabrain_chain_limit_read (lib/module-chain.sh) is gone: it lost its last production caller
# when hooks/megabrain-turn-end.sh stopped sourcing lib/ and its own chain-continuation path
# moved to src/cli/commands/chain-run.ts's continueRefusedChain, which reads limits through
# core/chain-limits.ts — the same reader `chain limits` itself already used. So this no longer
# compares two implementations; it is a black-box golden test of the binary's own
# `chain limits --json` row for codex/5h and codex/weekly against a rollout fixture with
# incomplete usage data. The expected values below are megabrain_chain_limit_read's own last
# recorded output for this exact fixture, captured from HEAD before its deletion — except for the
# 5h row, where the shell reader's answer ("rollout has no rate limit snapshot") turned out to
# already disagree with the binary's ("usage data is incomplete"): a preexisting divergence
# between the two readers for this fixture, unrelated to this migration and not fixed by it. The
# binary's own actual answer is what is asserted here, since the binary is what survives.
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

expected_5h='{"status":"unknown","usedPercent":null,"resetsAt":null,"fetchedAtIsNull":true,"reason":"codex 5h window unknown (snapshot reports primary 300 minutes but its usage data is incomplete)"}'
expected_weekly='{"status":"current","usedPercent":18,"resetsAt":"4102444800","fetchedAtIsNull":false,"reason":"codex weekly window at 18.0 percent"}'

binary_reading_5h="$(binary_codex_reading 5h "$binary_incomplete_output")"
[ "$binary_reading_5h" = "$expected_5h" ] || {
  printf 'incomplete usage limits codex 5h differs: expected=%s binary=%s\n' "$expected_5h" "$binary_reading_5h" >&2
  exit 1
}
binary_reading_weekly="$(binary_codex_reading weekly "$binary_incomplete_output")"
[ "$binary_reading_weekly" = "$expected_weekly" ] || {
  printf 'incomplete usage limits codex weekly differs: expected=%s binary=%s\n' "$expected_weekly" "$binary_reading_weekly" >&2
  exit 1
}
printf 'incomplete usage limits: codex 5h/weekly match the recorded golden rows\n'
printf 'chain compiled contract: passed\n'
