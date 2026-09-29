#!/usr/bin/env bash
set -euo pipefail

unset MEGABRAIN_SESSION_ID MEGABRAIN_SESSION_HOST CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID \
  ORCA_STRUCTURED_SESSION ORCA_AGENT_SESSION_SPAWN_TOKEN ORCA_TERMINAL_HANDLE SUPERSET_TERMINAL_ID

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_real_home="${HOME:-}"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-orchestrate-adopt.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$state_dir/.megabrain-test-state"
require_megabrain_test_state

export HOME="$state_dir/home"
mkdir -p "$HOME" "$state_dir/state"
assert_safe_state_dir() {
  [ -n "${MEGABRAIN_STATE_DIR:-}" ] || { printf 'FAIL: MEGABRAIN_STATE_DIR is unset\n' >&2; exit 1; }
  local state_path home_path home_candidate
  state_path="$(cd "$MEGABRAIN_STATE_DIR" && pwd -P)"
  for home_candidate in "$test_real_home" "$HOME"; do
    [ -n "$home_candidate" ] && [ -d "$home_candidate" ] || continue
    home_path="$(cd "$home_candidate" && pwd -P)"
    case "$state_path/" in "$home_path/.megabrain/"*) printf 'FAIL: refusing real-home megabrain state directory\n' >&2; exit 1 ;; esac
  done
}
trap 'if [ -n "${codex_pid:-}" ]; then kill "$codex_pid" 2>/dev/null || true; wait "$codex_pid" 2>/dev/null || true; fi; rm -rf "$state_dir"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
db_import() { export MEGABRAIN_STATE_DIR="$state_dir/state"; assert_safe_state_dir; "$root/.build/megabrain" db import "$state_dir/state" --replace --json >/dev/null; }
db_show() { MEGABRAIN_STATE_DIR="$state_dir/state" "$root/.build/megabrain" db show "$1" --json; }
write_meta() {
  local id="$1" owner="$2" host="$3" directory="$4"
  mkdir -p "$directory"
  printf '{"dispatchId":"%s","parentSessionId":"%s","parentHost":"%s","state":"running"}\n' \
    "$id" "$owner" "$host" >"$directory/meta.json"
}
run_adopt() {
  local id="$1"
  shift
  env -u MEGABRAIN_SESSION_ID -u MEGABRAIN_SESSION_HOST -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID \
    MEGABRAIN_STATE_DIR="$state_dir/state" HOME="$state_dir/home" MEGABRAIN_SESSION_HOST=claude \
    CLAUDE_CODE_SESSION_ID=adopter "$root/.build/megabrain" orchestrate adopt "$id" "$@"
}

mkdir -p "$state_dir/state/dispatches" "$state_dir/home"
export MEGABRAIN_STATE_DIR="$state_dir/state"
assert_safe_state_dir
write_meta unknown old-terminal orca "$state_dir/state/dispatches/unknown"
db_import
unknown_result="$(run_adopt unknown --json)" || fail "adopting an unknown legacy owner failed: $unknown_result"
printf '%s' "$unknown_result" | jq -e '.adopted == true and .owner == "claude:adopter"' >/dev/null ||
  fail "unknown owner adoption result is incorrect: $unknown_result"
jq -e '.meta.parentSessionId == "claude:adopter" and (.meta.adoptions | length) == 1 and .meta.adoptions[0].previousOwner == "old-terminal" and .meta.adoptions[0].adoptedBy == "claude:adopter" and (.meta.adoptions[0].adoptedAt | type == "string" and length > 0)' <<<"$(db_show unknown)" >/dev/null ||
  fail "adopting an unknown owner did not preserve ownership history: $(db_show unknown)"
adopter_list="$(env -u MEGABRAIN_SESSION_ID -u MEGABRAIN_SESSION_HOST -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID \
  MEGABRAIN_STATE_DIR="$state_dir/state" MEGABRAIN_SESSION_HOST=claude CLAUDE_CODE_SESSION_ID=adopter \
  "$root/.build/megabrain" orchestrate list --json)"
printf '%s' "$adopter_list" | jq -e 'length == 1 and .[0].dispatchId == "unknown" and .[0].owner == "mine"' >/dev/null ||
  fail "adopted dispatch did not move into the adopter's default list: $adopter_list"

mkdir -p "$state_dir/home/.claude/sessions"
printf '{"sessionId":"live-owner","pid":%s}\n' "$$" >"$state_dir/home/.claude/sessions/live.json"
write_meta live-foreign claude:live-owner claude "$state_dir/state/dispatches/live-foreign"
db_import
if run_adopt live-foreign --json >"$state_dir/refused.out" 2>&1; then
  fail 'adopting a live foreign owner without --force unexpectedly succeeded'
fi
jq -e '.meta.parentSessionId == "claude:live-owner" and (.meta.adoptions // [] | length == 0)' <<<"$(db_show live-foreign)" >/dev/null || fail 'a refused adoption changed metadata'
forced="$(run_adopt live-foreign --force --json)" || fail "--force did not adopt a live foreign owner: $forced"
printf '%s' "$forced" | jq -e '.adopted == true and .owner == "claude:adopter"' >/dev/null ||
  fail "forced adoption result is incorrect: $forced"
jq -e '.meta.parentSessionId == "claude:adopter" and .meta.adoptions[0].previousOwner == "claude:live-owner"' <<<"$(db_show live-foreign)" >/dev/null || fail 'forced adoption did not record prior ownership'

write_meta dead-foreign claude:dead-owner claude "$state_dir/state/dispatches/dead-foreign"
db_import
dead="$(run_adopt dead-foreign --json)" || fail "adopting a foreign owner with no live session failed: $dead"
printf '%s' "$dead" | jq -e '.adopted == true' >/dev/null || fail "dead-owner adoption result is incorrect: $dead"

write_meta own claude:adopter claude "$state_dir/state/dispatches/own"
db_import
own="$(run_adopt own --json)" || fail "adopting one's own dispatch was not successful: $own"
printf '%s' "$own" | jq -e '.adopted == false and .owner == "claude:adopter"' >/dev/null ||
  fail "own dispatch was not a no-op: $own"

mkdir -p "$state_dir/state/dispatches/archive/2026-09/archived"
write_meta archived legacy orca "$state_dir/state/dispatches/archive/2026-09/archived"
db_import
if run_adopt archived --force --json >"$state_dir/archived.out" 2>&1; then
  fail 'adopting an archived dispatch unexpectedly succeeded'
fi

CODEX_THREAD_ID=live-codex-owner sleep 30 &
codex_pid=$!
write_meta codex-foreign codex:live-codex-owner codex "$state_dir/state/dispatches/codex-foreign"
db_import
if run_adopt codex-foreign --json >"$state_dir/codex-refused.out" 2>&1; then
  fail 'adopting a live Codex owner without --force unexpectedly succeeded'
fi
forced_codex="$(run_adopt codex-foreign --force --json)" || fail "--force did not adopt a live Codex owner: $forced_codex"
printf '%s' "$forced_codex" | jq -e '.adopted == true' >/dev/null || fail "forced Codex adoption result is incorrect: $forced_codex"
kill "$codex_pid" 2>/dev/null || true
wait "$codex_pid" 2>/dev/null || true
codex_pid=""

no_identity="$(env -u MEGABRAIN_SESSION_ID -u MEGABRAIN_SESSION_HOST -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID \
  MEGABRAIN_STATE_DIR="$state_dir/state" HOME="$state_dir/home" "$root/.build/megabrain" orchestrate adopt unknown --json 2>&1 || true)"
case "$no_identity" in
  *'requires an agent session identity'*) ;;
  *) fail "a caller without agent identity was not refused: $no_identity" ;;
esac

printf 'orchestrate adopt transfers unknown and proven-dead owners, protects live owners, and records history\n'
