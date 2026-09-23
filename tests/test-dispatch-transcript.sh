#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_state_dir="${MEGABRAIN_STATE_DIR:-${HOME:-/tmp}/.megabrain}"
real_transcript=''
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-dispatch-transcript.XXXXXX")"
live_sessions="$state_dir/live-sessions"
release_log="$state_dir/release.log"

cleanup() {
  rm -rf "$state_dir"
}
trap cleanup EXIT

for candidate in "$source_state_dir"/dispatches/*/transcript; do
  [ -f "$candidate" ] || continue
  if LC_ALL=C grep -Fq 'Worktree:' "$candidate" &&
    LC_ALL=C grep -Fq 'DEFECT A' "$candidate" &&
    LC_ALL=C grep -Fq 'refusing to delete' "$candidate"; then
    real_transcript="$candidate"
    break
  fi
done

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected '$1' to contain '$2'" ;;
  esac
}

assert_file() {
  [ -f "$1" ] || fail "expected file to exist: $1"
}

assert_missing() {
  [ ! -e "$1" ] || fail "expected path to be absent: $1"
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

export MEGABRAIN_STATE_DIR="$state_dir/state"
export MEGABRAIN_ROOT="$root"
export SUPERSET_TERMINAL_ID=parent-terminal
unset TMUX TMUX_PANE
dispatch_dir="$MEGABRAIN_STATE_DIR/dispatches"

compiled_bin_dir="$state_dir/bin"
fake_bin="$compiled_bin_dir"
mkdir -p "$compiled_bin_dir"
capture_state="$state_dir/capture-output"
cat >"$compiled_bin_dir/tmux" <<'EOF'
#!/usr/bin/env bash
target=""
for arg in "$@"; do
  if [ "$target" = -t ]; then
    target="$arg"
    break
  fi
  [ "$arg" = -t ] && target=-t
done
case "${1:-}" in
  has-session)
    grep -Fx "$target" "${MEGABRAIN_FAKE_TMUX_SESSIONS:?}" >/dev/null 2>&1
    ;;
  list-panes)
    [ "${MEGABRAIN_FAKE_TMUX_UNPROVEN_SESSION:-}" = "$target" ] && exit 1
    if grep -Fx "$target" "${MEGABRAIN_FAKE_TMUX_SESSIONS:?}" >/dev/null 2>&1; then
      if [ "${MEGABRAIN_FAKE_TMUX_MULTI_PANE_SESSION:-}" = "$target" ]; then
        printf '%s\n' '%99' '%100'
      else
        printf '%s\n' '%99'
      fi
    fi
    ;;
  display-message)
    printf '%s\n' "${MEGABRAIN_FAKE_TMUX_CALLER_SESSION:?}"
    ;;
  kill-session)
    printf 'session:%s\n' "$target" >>"${MEGABRAIN_FAKE_TMUX_RELEASE_LOG:?}"
    grep -Fvx "$target" "${MEGABRAIN_FAKE_TMUX_SESSIONS:?}" >"${MEGABRAIN_FAKE_TMUX_SESSIONS}.tmp" || true
    mv -f "${MEGABRAIN_FAKE_TMUX_SESSIONS}.tmp" "${MEGABRAIN_FAKE_TMUX_SESSIONS}"
    ;;
  kill-pane)
    printf 'pane:%s\n' "$target" >>"${MEGABRAIN_FAKE_TMUX_RELEASE_LOG:?}"
    ;;
  capture-pane)
    [ "${CAPTURE_AVAILABLE:-false}" = true ] || exit 1
    cat "${CAPTURE_PATH:?}"
    ;;
  *) exit 1 ;;
esac
EOF
cat >"$fake_bin/megabrain_superset" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = terminals ] && [ "${2:-}" = close ]; then
  printf '%s\n' '{"ok":true}'
  exit 0
fi
exit 1
EOF
chmod +x "$fake_bin/tmux" "$fake_bin/megabrain_superset"
export MEGABRAIN_FAKE_TMUX_SESSIONS="$live_sessions"
export MEGABRAIN_FAKE_TMUX_RELEASE_LOG="$release_log"
export CAPTURE_PATH="$capture_state" CAPTURE_AVAILABLE=true
run_compiled_read() {
  env PATH="$compiled_bin_dir:$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_SESSION_HOST=superset MEGABRAIN_SESSION_ID=parent-terminal \
    "$root/.build/megabrain" orchestrate read "$@"
}
sync_capture() { printf '%s\n' "$capture_output" >"$capture_state"; }
run_compiled_prune() {
  env PATH="$fake_bin:$PATH" MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate prune "$@"
}
run_compiled_close() {
  env -u TMUX -u TMUX_PANE PATH="$fake_bin:$PATH" MEGABRAIN_ROOT="$root" \
    "$root/.build/megabrain" orchestrate close "$@"
}

capture_output='captured dispatch transcript'
sync_capture

transcript_path() {
  printf '%s/%s/transcript\n' "$dispatch_dir" "$1"
}

# Fixture built directly with jq: no lib/ sourcing, no shell helper functions. Mirrors the same
# meta.json shape spawn() writes; only the fields close/prune/read actually read need to be real.
write_meta() {
  local dispatch_id="$1" state="$2" tmux_session="${3:-$1}" tmux_pane="${4:-%99}"
  local parent_tmux_session="${5:-}" parent_tmux_pane="${6:-}" dir="$dispatch_dir/$dispatch_id"
  mkdir -p "$dir/messages" "$dir/deliveries"
  jq -n --arg dispatchId "$dispatch_id" --arg worktreePath "$root" --arg state "$state" \
    --arg tmuxSession "$tmux_session" --arg tmuxPane "$tmux_pane" \
    --arg parentTmuxSession "$parent_tmux_session" --arg parentTmuxPane "$parent_tmux_pane" \
    --arg now "$(now)" '{
      dispatchId: $dispatchId, parentSessionId: "parent-terminal", parentHost: "superset",
      parentWorkspaceId: "workspace-test",
      parentTmuxSession: (if $parentTmuxSession == "" then null else $parentTmuxSession end),
      parentTmuxPane: (if $parentTmuxPane == "" then null else $parentTmuxPane end),
      childHost: "superset", workspaceId: "workspace-test", terminalId: "child-terminal",
      worktreePath: $worktreePath, branch: "main", agent: "codex", agentId: "codex",
      model: "gpt-5", modelHonored: true, label: "label", state: $state,
      runtime: "tmux", spawnRuntime: "tmux", tmuxSession: $tmuxSession, tmuxPane: $tmuxPane,
      createdAt: $now, updatedAt: $now
    }' >"$dir/meta.json"
}

set_old_timestamp() {
  local dispatch_id="$1" path="$dispatch_dir/$1/meta.json" tmp
  tmp="$(mktemp "$dispatch_dir/$dispatch_id/.old.XXXXXX")"
  jq --arg old '2020-01-01T00:00:00Z' '.createdAt = $old | .updatedAt = $old' "$path" >"$tmp"
  mv -f "$tmp" "$path"
}

printf '%s\n' 'close-session' >"$live_sessions"
capture_output='final output before close'
sync_capture
write_meta close-session done close-session
mkdir -p "$(dirname "$(transcript_path close-session)")"
printf '%s\n' 'final output before close' >"$(transcript_path close-session)"
run_compiled_close close-session --json >/dev/null
assert_contains "$(cat "$(transcript_path close-session)")" 'final output before close'
assert_equal "$(jq -r '.state' "$dispatch_dir/close-session/meta.json")" closed
printf 'compiled close preserves the persisted transcript while releasing tmux\n'

CAPTURE_AVAILABLE=false
write_meta read-fallback done read-fallback
mkdir -p "$(dirname "$(transcript_path read-fallback)")"
printf '%s\n' 'persisted read output' >"$(transcript_path read-fallback)"
read_result="$(run_compiled_read read-fallback --lines 20 --json)"
assert_equal "$(printf '%s' "$read_result" | jq -r '.source')" file
assert_equal "$(printf '%s' "$read_result" | jq -r '.text')" 'persisted read output'
printf 'read falls back to the persisted transcript and reports file source\n'

write_meta rendered-fallback done rendered-fallback
mkdir -p "$(dirname "$(transcript_path rendered-fallback)")"
printf 'old one\nold two\n\033[2A\033[2K\033]0;ignored title\007\033[?2026h\033[1mfinal one\033[0m\033[1B\033[1G\033[2Kfinal two\033[?2026l\nplain three\n' >"$(transcript_path rendered-fallback)"
cp "$(transcript_path rendered-fallback)" "$state_dir/rendered-fallback.raw"
scenario_failures=0
scenario_equal() {
  if [ "$1" != "$2" ]; then
    printf 'SCENARIO FAIL: expected %s, got %s\n' "$2" "$1" >&2
    scenario_failures=$((scenario_failures + 1))
  fi
}

scenario_not_contains() {
  case "$1" in
    *"$2"*)
      printf 'SCENARIO FAIL: did not expect %s in %s\n' "$2" "$1" >&2
      scenario_failures=$((scenario_failures + 1))
      ;;
  esac
}

rendered_result="$(run_compiled_read rendered-fallback --lines 3 --json)"
assert_equal "$(printf '%s' "$rendered_result" | jq -r '.source')" file
if ! cmp -s "$(transcript_path rendered-fallback)" "$state_dir/rendered-fallback.raw"; then
  fail 'rendering changed the persisted transcript'
fi
scenario_equal "$(printf '%s' "$rendered_result" | jq -r '.text')" $'final one\nfinal two\nplain three'
scenario_not_contains "$(printf '%s' "$rendered_result" | jq -r '.text')" 'old one'
scenario_not_contains "$(printf '%s' "$rendered_result" | jq -r '.text')" 'ignored title'
if [ "$scenario_failures" -ne 0 ]; then
  fail 'rendering scenario failed'
fi
printf 'read renders terminal controls and keeps the final overwritten lines\n'

limited_result="$(run_compiled_read rendered-fallback --lines 2 --json)"
scenario_equal "$(printf '%s' "$limited_result" | jq -r '.text')" $'final one\nfinal two\nplain three'
scenario_equal "$(printf '%s' "$limited_result" | jq -r '.text | split("\n") | length')" 3
if [ "$scenario_failures" -ne 0 ]; then
  fail 'transcript rendering scenarios failed'
fi
printf 'read keeps complete rendered history\n'

if [ -n "$real_transcript" ]; then
  write_meta rendered-history done rendered-history
  mkdir -p "$(dirname "$(transcript_path rendered-history)")"
  dd if="$real_transcript" of="$(transcript_path rendered-history)" bs=1 count=8500000 2>/dev/null ||
    fail 'could not copy the real transcript slice'
  history_result="$(run_compiled_read rendered-history --lines 1000 --json)"
  history_text="$(printf '%s' "$history_result" | jq -r '.text')"
  assert_contains "$history_text" 'Worktree:'
  assert_contains "$history_text" 'DEFECT A'
  assert_contains "$history_text" 'refusing to delete'
  history_worktree_line="$(printf '%s\n' "$history_text" | awk '/Worktree:/ && !found { print NR; found=1 }')"
  history_defect_line="$(printf '%s\n' "$history_text" | awk '/DEFECT A/ && !found { print NR; found=1 }')"
  history_refusal_line="$(printf '%s\n' "$history_text" | awk '/refusing to delete/ && !found { print NR; found=1 }')"
  [ "$history_worktree_line" -lt "$history_defect_line" ] || fail 'rendered history reordered Worktree and DEFECT A'
  [ "$history_defect_line" -lt "$history_refusal_line" ] || fail 'rendered history reordered DEFECT A and refusal'
  printf 'read preserves scrolled history from a real transcript slice in order\n'
else
  printf 'skip: read history scenario skipped because no suitable real transcript is available\n'
fi

# Cap and truncation scenarios only need a file whose size crosses the transcript byte cap, not
# any particular content, so they build their own fixture from the committed agent-liveness pane
# captures (real captured frames, not hand-invented bytes) instead of scanning the operator's
# megabrain state directory for an archived transcript. That fixture exists on any machine, so
# these scenarios are never skipped.
truncation_report_cap=65536
export MEGABRAIN_TRANSCRIPT_MAX_BYTES="$truncation_report_cap"
build_capped_transcript_fixture() {
  local target_bytes="$1" out="$2" seed
  seed="$(mktemp "$state_dir/fixture-seed.XXXXXX")"
  cat "$root"/tests/fixtures/agent-liveness/*.transcript >"$seed"
  while [ "$(wc -c <"$seed" | tr -d ' ')" -lt "$target_bytes" ]; do
    cat "$seed" "$seed" >"$seed.next"
    mv -f "$seed.next" "$seed"
  done
  mv -f "$seed" "$out"
}
truncation_big="$state_dir/truncation-big.transcript"
build_capped_transcript_fixture $((truncation_report_cap + 65536)) "$truncation_big"
small_slice="$state_dir/small.transcript"
head -c 2048 "$truncation_big" >"$small_slice"

CAPTURE_AVAILABLE=false
write_meta truncated-report done truncated-report
mkdir -p "$(dirname "$(transcript_path truncated-report)")"
cp "$truncation_big" "$(transcript_path truncated-report)"
truncated_json="$(run_compiled_read truncated-report --lines 50 --json)"
scenario_equal "$(printf '%s' "$truncated_json" | jq -r '.truncated')" true
truncated_plain="$(run_compiled_read truncated-report --lines 50)"
case "$truncated_plain" in
  *truncated:*) ;;
  *)
    printf 'SCENARIO FAIL: expected plain output to report truncation\n' >&2
    scenario_failures=$((scenario_failures + 1))
    ;;
esac
if [ "$scenario_failures" -ne 0 ]; then
  fail 'over-cap truncation reporting scenario failed'
fi
printf 'read reports truncation when the persisted transcript exceeds the cap\n'

write_meta untruncated-report done untruncated-report
mkdir -p "$(dirname "$(transcript_path untruncated-report)")"
cp "$small_slice" "$(transcript_path untruncated-report)"
untruncated_json="$(run_compiled_read untruncated-report --lines 50 --json)"
scenario_equal "$(printf '%s' "$untruncated_json" | jq -r '.truncated')" false
untruncated_plain="$(run_compiled_read untruncated-report --lines 50)"
scenario_not_contains "$untruncated_plain" 'truncated:'
if [ "$scenario_failures" -ne 0 ]; then
  fail 'under-cap truncation reporting scenario failed'
fi
printf 'read does not report truncation for a transcript under the cap\n'
unset MEGABRAIN_TRANSCRIPT_MAX_BYTES
CAPTURE_AVAILABLE=true

capture_output='live pane already rendered'
sync_capture
write_meta read-live done read-live
live_result="$(run_compiled_read read-live --lines 20 --json)"
assert_equal "$(printf '%s' "$live_result" | jq -r '.source')" tmux
assert_equal "$(printf '%s' "$live_result" | jq -r '.text')" 'live pane already rendered'
printf 'read keeps the live pane rendering path\n'

write_meta plain-fallback done plain-fallback
mkdir -p "$(dirname "$(transcript_path plain-fallback)")"
printf '%s\n' 'plain transcript one' 'plain transcript two' >"$(transcript_path plain-fallback)"
CAPTURE_AVAILABLE=false
plain_result="$(run_compiled_read plain-fallback --lines 20 --json)"
assert_equal "$(printf '%s' "$plain_result" | jq -r '.text')" $'plain transcript one\nplain transcript two'
printf 'read passes through an already plain transcript\n'
CAPTURE_AVAILABLE=true

printf '%s\n' 'shared-session' >"$live_sessions"
unset MEGABRAIN_FAKE_TMUX_CALLER_SESSION MEGABRAIN_FAKE_TMUX_MULTI_PANE_SESSION
regression_failures=0
assert_regression_equal() {
  if [ "$1" != "$2" ]; then
    printf 'REGRESSION FAIL: expected %s, got %s\n' "$2" "$1" >&2
    regression_failures=$((regression_failures + 1))
  fi
}

write_meta shared-session done shared-session %99 shared-session %0
set_old_timestamp shared-session
: >"$release_log"
shared_result="$(run_compiled_prune --json)"
assert_regression_equal "$(printf '%s' "$shared_result" | jq -r '.archived')" 1
assert_file "$dispatch_dir/archive/$(date -u '+%Y-%m')/shared-session/meta.json"
if ! grep -Fx 'shared-session' "$live_sessions" >/dev/null 2>&1; then
  printf 'REGRESSION FAIL: prune released the parent-owned tmux session\n' >&2
  regression_failures=$((regression_failures + 1))
fi
if grep -Fx 'session:shared-session' "$release_log" >/dev/null 2>&1; then
  printf 'REGRESSION FAIL: prune invoked release for the parent-owned tmux session\n' >&2
  regression_failures=$((regression_failures + 1))
fi
printf 'parent tmux sessions are never killed\n'

printf '%s\n' 'caller-session' >"$live_sessions"
: >"$release_log"
export MEGABRAIN_FAKE_TMUX_CALLER_SESSION=caller-session
export TMUX=caller-server TMUX_PANE=%0
write_meta caller-session-record done caller-session %99 other-session %1
set_old_timestamp caller-session-record
caller_result="$(run_compiled_prune --json)"
assert_regression_equal "$(printf '%s' "$caller_result" | jq -r '.archived')" 1
assert_file "$dispatch_dir/archive/$(date -u '+%Y-%m')/caller-session-record/meta.json"
if ! grep -Fx 'caller-session' "$live_sessions" >/dev/null 2>&1; then
  printf 'REGRESSION FAIL: prune released the caller tmux session\n' >&2
  regression_failures=$((regression_failures + 1))
fi
if grep -Fx 'session:caller-session' "$release_log" >/dev/null 2>&1; then
  printf 'REGRESSION FAIL: prune invoked release for the caller tmux session\n' >&2
  regression_failures=$((regression_failures + 1))
fi
printf 'caller tmux sessions are never killed\n'

unset TMUX TMUX_PANE MEGABRAIN_FAKE_TMUX_CALLER_SESSION
printf '%s\n' 'multi-pane-session' >"$live_sessions"
: >"$release_log"
export MEGABRAIN_FAKE_TMUX_MULTI_PANE_SESSION=multi-pane-session
write_meta multi-pane-record done multi-pane-session %99 other-session %1
set_old_timestamp multi-pane-record
multi_pane_result="$(run_compiled_prune --json)"
assert_regression_equal "$(printf '%s' "$multi_pane_result" | jq -r '.archived')" 1
assert_file "$dispatch_dir/archive/$(date -u '+%Y-%m')/multi-pane-record/meta.json"
if ! grep -Fx 'multi-pane-session' "$live_sessions" >/dev/null 2>&1; then
  printf 'REGRESSION FAIL: prune killed a multi-pane tmux session\n' >&2
  regression_failures=$((regression_failures + 1))
fi
if ! grep -Fx 'pane:%99' "$release_log" >/dev/null 2>&1; then
  printf 'REGRESSION FAIL: prune did not kill the dispatch pane in a multi-pane session\n' >&2
  regression_failures=$((regression_failures + 1))
fi
if grep -Fx 'session:multi-pane-session' "$release_log" >/dev/null 2>&1; then
  printf 'REGRESSION FAIL: prune killed the multi-pane tmux session instead of its pane\n' >&2
  regression_failures=$((regression_failures + 1))
fi
printf 'multi-pane tmux sessions lose only the dispatch pane\n'
[ "$regression_failures" -eq 0 ] || fail 'session ownership regressions detected'
unset MEGABRAIN_FAKE_TMUX_MULTI_PANE_SESSION

capture_output='prune transcript'
sync_capture
printf '%s\n' 'prune-session' >"$live_sessions"
write_meta prune-session done prune-session
mkdir -p "$(dirname "$(transcript_path prune-session)")"
printf '%s\n' 'prune transcript' >"$(transcript_path prune-session)"
set_old_timestamp prune-session
prune_result="$(run_compiled_prune --json)"
assert_equal "$(printf '%s' "$prune_result" | jq -r '.archived')" 1
assert_missing "$dispatch_dir/prune-session"
assert_missing_session="$(grep -Fx 'prune-session' "$live_sessions" >/dev/null 2>&1; printf '%s' "$?")"
assert_equal "$assert_missing_session" 1
assert_contains "$(cat "$dispatch_dir/archive/$(date -u '+%Y-%m')/prune-session/transcript")" 'prune transcript'
printf 'compiled prune archives the persisted transcript and releases tmux\n'

printf '%s\n' 'open-session' >"$live_sessions"
write_meta open-session running open-session
set_old_timestamp open-session
prune_result="$(run_compiled_prune --json)"
assert_equal "$(printf '%s' "$prune_result" | jq -r '.skippedDispatches[] | select(.dispatchId == "open-session") | .state')" running
assert_file "$dispatch_dir/open-session/meta.json"
assert_equal "$(grep -c '^open-session$' "$live_sessions")" 1
printf 'prune refuses an open dispatch and leaves its session alive\n'

printf '%s\n' 'unproven-session' >"$live_sessions"
write_meta unproven-session done unproven-session
mkdir -p "$(dirname "$(transcript_path unproven-session)")"
touch "$(transcript_path unproven-session)"
set_old_timestamp unproven-session
unproven_prune_result="$(env MEGABRAIN_FAKE_TMUX_UNPROVEN_SESSION=unproven-session PATH="$fake_bin:$PATH" MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate prune --json)"
assert_equal "$(printf '%s' "$unproven_prune_result" | jq -r '.archived')" 0
assert_equal "$(printf '%s' "$unproven_prune_result" | jq -r '.skippedDispatches[] | select(.dispatchId == "unproven-session") | .reason')" 'terminal identity is unproven'
assert_file "$dispatch_dir/unproven-session/meta.json"
if grep -Fx 'unproven-session' "$live_sessions" >/dev/null 2>&1; then
  :
else
  fail 'prune released an unproven terminal identity'
fi
if grep -Fx 'unproven-session' "$release_log" >/dev/null 2>&1; then
  fail 'prune released an unproven terminal identity'
fi
printf 'prune leaves a terminal with unproven identity alive\n'

printf 'ok: dispatch transcript persistence and session release\n'
