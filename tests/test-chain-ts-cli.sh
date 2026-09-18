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
  if [ "$label" = "incomplete usage limits" ]; then
    jq -e 'map(select(.provider == "codex") | .fetchedAt) | all(. != null)' "$shell_stdout" >/dev/null
    jq -e 'map(select(.provider == "codex") | .fetchedAt) | all(. != null)' "$binary_stdout" >/dev/null
    jq 'map(if .provider == "codex" then .fetchedAt = 0 else . end)' "$shell_stdout" >"$shell_stdout.normalized"
    jq 'map(if .provider == "codex" then .fetchedAt = 0 else . end)' "$binary_stdout" >"$binary_stdout.normalized"
    mv "$shell_stdout.normalized" "$shell_stdout"
    mv "$binary_stdout.normalized" "$binary_stdout"
  fi
  cmp -s "$shell_stdout" "$binary_stdout" || { printf '%s stdout differs\n' "$label" >&2; return 1; }
  cmp -s "$shell_stderr" "$binary_stderr" || { printf '%s stderr differs\n' "$label" >&2; return 1; }
  [ "$shell_status" -eq "$binary_status" ] || { printf '%s status differs\n' "$label" >&2; return 1; }
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
compare "incomplete usage limits" chain limits --json
printf 'chain compiled contract: passed\n'
