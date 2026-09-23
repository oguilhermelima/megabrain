#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_state_dir="${MEGABRAIN_STATE_DIR:-${HOME:-/tmp}/.megabrain}"
real_transcript=''
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-dispatch-transcript.XXXXXX")"
live_sessions="$state_dir/live-sessions"
capture_log="$state_dir/capture.log"
release_log="$state_dir/release.log"
pipe_log="$state_dir/pipe.log"
active_pipe_path=''

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

# The default byte cap the render path enforces (matches
# MEGABRAIN_TRANSCRIPT_MAX_BYTES in lib/module-orchestrate.sh). Cap and
# truncation scenarios below build their own fixture instead of depending on
# operator state, so they run the same way on any machine.
transcript_cap_default=10485760

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

export MEGABRAIN_STATE_DIR="$state_dir/state"
export MEGABRAIN_ROOT="$root"
export SUPERSET_TERMINAL_ID=parent-terminal
unset TMUX TMUX_PANE
touch "$capture_log" "$pipe_log" "$release_log"

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
# Read scenarios exercise the compiled command; the shell implementation is gone.
run_compiled_read() {
  env PATH="$compiled_bin_dir:$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_SESSION_HOST=superset MEGABRAIN_SESSION_ID=parent-terminal \
    "$root/.build/megabrain" orchestrate read "$@"
}
sync_capture() { printf '%s\n' "$capture_output" >"$capture_state"; }
run_compiled_prune() {
  env PATH="$fake_bin:$PATH" MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate prune "$@"
}

source "$root/lib/common.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-install.sh"

capture_output='captured dispatch transcript'
capture_available=true
sync_capture
pipe_start_available=true

megabrain_tmux_capture_pane() {
  local pane="$1" start="$2"
  printf '%s\t%s\n' "$pane" "$start" >>"$capture_log"
  [ "$capture_available" = true ] || return 1
  printf '%s\n' "$capture_output"
}

megabrain_tmux_pipe_pane_start() {
  local pane="$1" path="$2"
  printf 'start\t%s\t%s\n' "$pane" "$path" >>"$pipe_log"
  [ "$pipe_start_available" = true ] || return 1
  active_pipe_path="$path"
  printf '%s\n' "$capture_output" >>"$path"
}

megabrain_tmux_pipe_pane_stop() {
  local pane="$1"
  printf 'stop\t%s\n' "$pane" >>"$pipe_log"
  printf '%s\n' "$capture_output" >>"$active_pipe_path"
}

megabrain_tmux_session_exists() {
  grep -Fx "$1" "$live_sessions" >/dev/null 2>&1
}

megabrain_dispatch_tmux_sessions() {
  cat "$live_sessions"
}

megabrain_dispatch_terminal_status() {
  MEGABRAIN_TERMINAL_STATUS=proven
}

megabrain_dispatch_release_tmux_process() {
  local meta="$1" session
  session="$(printf '%s' "$meta" | jq -r '.tmuxSession // empty')"
  printf '%s\n' "$session" >>"$release_log"
  grep -Fvx "$session" "$live_sessions" >"$live_sessions.tmp" || true
  mv -f "$live_sessions.tmp" "$live_sessions"
  MEGABRAIN_DISPATCH_RELEASED_TERMINAL=true
}

megabrain_dispatch_close_refuse_caller() {
  return 0
}

megabrain_dispatch_native_close() {
  local meta="$1" session
  session="$(printf '%s' "$meta" | jq -r '.tmuxSession // empty')"
  printf '%s\n' "$session" >>"$release_log"
  if [ -f "$live_sessions" ]; then
    grep -Fvx "$session" "$live_sessions" >"$live_sessions.tmp" || true
    mv -f "$live_sessions.tmp" "$live_sessions"
  fi
}

write_dispatch() {
  local dispatch_id="$1" state="$2" session="$3"
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal superset superset workspace-test child-terminal \
    "$root" main codex label "$state" gpt-5 true codex "$session" "%99" tmux tmux \
    '' '' workspace-test >/dev/null
}

set_old_timestamp() {
  local dispatch_id="$1" path tmp
  path="$MEGABRAIN_DISPATCH_DIR/$dispatch_id/meta.json"
  tmp="$(mktemp "$MEGABRAIN_DISPATCH_DIR/$dispatch_id/.old.XXXXXX")"
  jq --arg old '2020-01-01T00:00:00Z' '.createdAt = $old | .updatedAt = $old' "$path" >"$tmp"
  mv -f "$tmp" "$path"
}

transcript_path() {
  printf '%s/transcript\n' "$(megabrain_dispatch_dir "$1")"
}

printf '%s\n' 'transition-session' >"$live_sessions"
write_dispatch transition-session running transition-session
megabrain_dispatch_start_transcript transition-session %99
assert_contains "$(cat "$pipe_log")" 'start	%99'
before_capture="$(wc -l <"$capture_log" | tr -d ' ')"
megabrain_dispatch_meta_update_state transition-session done
after_capture="$(wc -l <"$capture_log" | tr -d ' ')"
assert_equal "$after_capture" "$before_capture"
assert_file "$(transcript_path transition-session)"
assert_contains "$(cat "$(transcript_path transition-session)")" 'captured dispatch transcript'
printf 'dispatch start streams output without terminal-state snapshotting\n'

pipe_start_available=false
write_dispatch transition-missing running transition-missing
if megabrain_dispatch_start_transcript transition-missing %100 >/dev/null 2>&1; then
  fail 'transcript start succeeded when the pipe could not be started'
fi
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/transition-missing/meta.json")" running
printf 'dispatch start fails loudly when the pipe cannot be started\n'
capture_available=true
pipe_start_available=true

capture_output='first streamed output'
sync_capture
write_dispatch reconnect-session running reconnect-session
megabrain_dispatch_start_transcript reconnect-session %99
capture_output='second streamed output'
sync_capture
megabrain_dispatch_start_transcript reconnect-session %99
assert_contains "$(cat "$(transcript_path reconnect-session)")" 'first streamed output'
assert_contains "$(cat "$(transcript_path reconnect-session)")" 'second streamed output'
printf 'transcript stream appends output across reconnect\n'

printf '%s\n' 'close-session' >"$live_sessions"
capture_output='final output before close'
sync_capture
write_dispatch close-session done close-session
megabrain_dispatch_start_transcript close-session %99
PATH="$fake_bin:$PATH" "$root/.build/megabrain" orchestrate close close-session --json >/dev/null
assert_contains "$(cat "$(transcript_path close-session)")" 'final output before close'
assert_equal "$(jq -r '.state' "$MEGABRAIN_DISPATCH_DIR/close-session/meta.json")" closed
assert_equal "$(grep -c '^stop' "$pipe_log" || true)" 0
printf 'compiled close preserves the persisted transcript while releasing tmux\n'

capture_available=false
CAPTURE_AVAILABLE=false
write_dispatch read-fallback done read-fallback
printf '%s\n' 'persisted read output' >"$(transcript_path read-fallback)"
read_result="$(run_compiled_read read-fallback --lines 20 --json)"
assert_equal "$(printf '%s' "$read_result" | jq -r '.source')" file
assert_equal "$(printf '%s' "$read_result" | jq -r '.text')" 'persisted read output'
printf 'read falls back to the persisted transcript and reports file source\n'

write_dispatch rendered-fallback done rendered-fallback
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
  printf 'observed %s rendering scenario failure(s) before implementation\n' "$scenario_failures"
fi
printf 'read renders terminal controls and keeps the final overwritten lines\n'

limited_result="$(run_compiled_read rendered-fallback --lines 2 --json)"
scenario_equal "$(printf '%s' "$limited_result" | jq -r '.text')" $'final one\nfinal two\nplain three'
scenario_equal "$(printf '%s' "$limited_result" | jq -r '.text | split("\n") | length')" 3
if [ "$scenario_failures" -ne 0 ]; then
  printf 'observed %s transcript scenario failure(s) before implementation\n' "$scenario_failures"
  fail 'transcript rendering scenarios failed'
fi
printf 'read keeps complete rendered history\n'

if [ -n "$real_transcript" ]; then
  write_dispatch rendered-history done rendered-history
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

# Cap and truncation scenarios only need a file whose size crosses
# MEGABRAIN_TRANSCRIPT_MAX_BYTES, not any particular content, so they build
# their own fixture from the committed agent-liveness pane captures (real
# captured frames, not hand-invented bytes) instead of scanning the
# operator's megabrain state directory for an archived transcript. That
# fixture exists on any machine, so these scenarios are never skipped.
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

small_slice="$state_dir/small.transcript"
big_slice="$state_dir/big.transcript"
build_capped_transcript_fixture $((transcript_cap_default + 65536)) "$big_slice"
head -c 2048 "$big_slice" >"$small_slice"
mechanism_cap=4096

megabrain_transcript_capped_stream "$small_slice" 1000000 >"$state_dir/out-passthrough"
cmp -s "$state_dir/out-passthrough" "$small_slice" ||
  fail 'capped stream altered a file under the cap'
printf 'capped stream passes an under-cap file through unchanged\n'

megabrain_transcript_capped_stream "$big_slice" "$mechanism_cap" >"$state_dir/out-capped"
tail -c "$mechanism_cap" "$big_slice" | tail -n +2 >"$state_dir/expected-capped"
cmp -s "$state_dir/out-capped" "$state_dir/expected-capped" ||
  fail 'capped stream did not match the expected tail slice'
out_capped_size="$(wc -c <"$state_dir/out-capped" | tr -d ' ')"
[ "$out_capped_size" -le "$mechanism_cap" ] || fail 'capped stream exceeded the byte cap'
printf 'capped stream truncates an over-cap file to the tail, dropping the partial first line\n'

cp "$small_slice" "$state_dir/trunc-small"
megabrain_transcript_truncate_file "$state_dir/trunc-small" 1000000
cmp -s "$state_dir/trunc-small" "$small_slice" ||
  fail 'truncate_file modified a file under the cap'
printf 'truncate_file leaves an under-cap transcript untouched\n'

cp "$big_slice" "$state_dir/trunc-big"
megabrain_transcript_truncate_file "$state_dir/trunc-big" "$mechanism_cap"
trunc_big_size="$(wc -c <"$state_dir/trunc-big" | tr -d ' ')"
[ "$trunc_big_size" -le "$mechanism_cap" ] || fail 'truncate_file left the transcript over the cap'
cmp -s "$state_dir/trunc-big" "$state_dir/expected-capped" ||
  fail 'truncate_file result did not match the expected tail slice'
printf 'truncate_file shrinks an over-cap transcript in place to the capped tail\n'

printf '%s\n' 'stop-cap-session' >"$live_sessions"
write_dispatch stop-cap-session running stop-cap-session
megabrain_dispatch_start_transcript stop-cap-session %99
cp "$big_slice" "$(transcript_path stop-cap-session)"
pre_stop_size="$(wc -c <"$(transcript_path stop-cap-session)" | tr -d ' ')"
[ "$pre_stop_size" -gt "$MEGABRAIN_TRANSCRIPT_MAX_BYTES" ] ||
  fail 'fixture too small to exercise the default cap at stop'
stop_meta="$(jq -c . "$MEGABRAIN_DISPATCH_DIR/stop-cap-session/meta.json")"
megabrain_dispatch_stop_transcript "$stop_meta"
post_stop_size="$(wc -c <"$(transcript_path stop-cap-session)" | tr -d ' ')"
[ "$post_stop_size" -le "$MEGABRAIN_TRANSCRIPT_MAX_BYTES" ] ||
  fail 'stop did not bound the persisted transcript to the cap'
assert_contains "$(cat "$pipe_log")" 'stop'
printf 'stopping a dispatch bounds its persisted transcript to the byte cap\n'

write_dispatch capped-render done capped-render
cp "$big_slice" "$(transcript_path capped-render)"
capped_render_src_size="$(wc -c <"$(transcript_path capped-render)" | tr -d ' ')"
[ "$capped_render_src_size" -gt "$MEGABRAIN_TRANSCRIPT_MAX_BYTES" ] ||
  fail 'fixture transcript no longer exceeds the default cap'

# Calls the render function directly rather than through command_orchestrate
# read: the uncapped baseline call below is over ten megabytes, and routing
# that through the --json/jq --arg path exceeds the OS argv limit. That is a
# real ceiling this scenario's own baseline hits, not something under test here.
MEGABRAIN_TRANSCRIPT_MAX_BYTES=$((capped_render_src_size + 1))
baseline_render_text="$(megabrain_dispatch_render_transcript "$(transcript_path capped-render)" 100000)"
[ -n "$baseline_render_text" ] || fail 'baseline (uncapped) render produced no output'

MEGABRAIN_TRANSCRIPT_MAX_BYTES=10485760
capped_render_text="$(megabrain_dispatch_render_transcript "$(transcript_path capped-render)" 100000)"
[ -n "$capped_render_text" ] || fail 'capped render produced no output'

# The cap must actually engage: with far less scrollback fed into the replay,
# the capped render has to come out smaller than the uncapped baseline, not
# merely equal to it.
[ "${#capped_render_text}" -lt "${#baseline_render_text}" ] ||
  fail 'capped render was not smaller than the uncapped baseline; the cap did not engage'

baseline_render_tail="$(printf '%s\n' "$baseline_render_text" | tail -n 5)"
capped_render_tail="$(printf '%s\n' "$capped_render_text" | tail -n 5)"
assert_equal "$capped_render_tail" "$baseline_render_tail"

if ! cmp -s "$(transcript_path capped-render)" "$big_slice"; then
  fail 'rendering mutated the persisted transcript'
fi
printf 'render caps a fixture over-limit transcript to the tail and keeps the final frame stable\n'

# The truncation-reporting scenarios route the full rendered text through
# command_orchestrate read --json, which hands it to jq as a single --arg.
# The built fixture carries no escape sequences (unlike a real transcript,
# where they are about 80 percent of the bytes and collapse during replay),
# so its rendered output is roughly the same size as its input. Measured:
# with MEGABRAIN_TRANSCRIPT_MAX_BYTES at the 10485760 default, the built
# fixture's render output overruns the OS argv limit for a single jq
# argument ("jq: Argument list too long"). A much smaller cap here exercises
# the same truncated-flag logic without hitting that ceiling.
truncation_report_cap=65536
export MEGABRAIN_TRANSCRIPT_MAX_BYTES="$truncation_report_cap"
truncation_big="$state_dir/truncation-big.transcript"
build_capped_transcript_fixture $((truncation_report_cap + 65536)) "$truncation_big"

capture_available=false
CAPTURE_AVAILABLE=false
write_dispatch truncated-report done truncated-report
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

write_dispatch untruncated-report done untruncated-report
cp "$small_slice" "$(transcript_path untruncated-report)"
untruncated_json="$(run_compiled_read untruncated-report --lines 50 --json)"
scenario_equal "$(printf '%s' "$untruncated_json" | jq -r '.truncated')" false
untruncated_plain="$(run_compiled_read untruncated-report --lines 50)"
scenario_not_contains "$untruncated_plain" 'truncated:'
if [ "$scenario_failures" -ne 0 ]; then
  fail 'under-cap truncation reporting scenario failed'
fi
printf 'read does not report truncation for a transcript under the cap\n'
export MEGABRAIN_TRANSCRIPT_MAX_BYTES=10485760
capture_available=true
CAPTURE_AVAILABLE=true

capture_available=true
CAPTURE_AVAILABLE=true
capture_output='live pane already rendered'
sync_capture
write_dispatch read-live done read-live
live_result="$(run_compiled_read read-live --lines 20 --json)"
assert_equal "$(printf '%s' "$live_result" | jq -r '.source')" tmux
assert_equal "$(printf '%s' "$live_result" | jq -r '.text')" 'live pane already rendered'
printf 'read keeps the live pane rendering path\n'

write_dispatch plain-fallback done plain-fallback
printf '%s\n' 'plain transcript one' 'plain transcript two' >"$(transcript_path plain-fallback)"
capture_available=false
CAPTURE_AVAILABLE=false
plain_result="$(run_compiled_read plain-fallback --lines 20 --json)"
assert_equal "$(printf '%s' "$plain_result" | jq -r '.text')" $'plain transcript one\nplain transcript two'
printf 'read passes through an already plain transcript\n'
capture_available=true
CAPTURE_AVAILABLE=true

printf '%s\n' 'doctor-leak' >"$live_sessions"
write_dispatch doctor-leak done doctor-leak
write_dispatch doctor-clean done doctor-clean
# WHY: this drives megabrain_dispatch_health_counts directly (the dispatch-health scan itself,
# defined in module-orchestrate.sh) rather than through the deleted module_orchestration_doctor —
# that wrapper only added the orca/superset/tmux runtime summary around this same counting call,
# which is not what this scenario is proving.
megabrain_dispatch_health_counts
assert_equal "$MODULE_LEAKED_DISPATCH_SESSIONS" 1
printf 'doctor counts one terminal dispatch session leak\n'
printf '%s\n' >"$live_sessions"
megabrain_dispatch_health_counts
assert_equal "$MODULE_LEAKED_DISPATCH_SESSIONS" 0
printf 'doctor reports zero terminal dispatch session leaks when released\n'

printf '%s\n' 'shared-session' >"$live_sessions"
unset MEGABRAIN_FAKE_TMUX_CALLER_SESSION MEGABRAIN_FAKE_TMUX_MULTI_PANE_SESSION
regression_failures=0
assert_regression_equal() {
  if [ "$1" != "$2" ]; then
    printf 'REGRESSION FAIL: expected %s, got %s\n' "$2" "$1" >&2
    regression_failures=$((regression_failures + 1))
  fi
}

megabrain_dispatch_meta_write shared-session parent-terminal superset superset workspace-test child-terminal \
  "$root" main codex label done gpt-5 true codex shared-session %99 tmux tmux shared-session %0 workspace-test >/dev/null
set_old_timestamp shared-session
: >"$release_log"
megabrain_dispatch_health_counts
assert_regression_equal "$MODULE_LEAKED_DISPATCH_SESSIONS" 0
shared_result="$(run_compiled_prune --json)"
assert_regression_equal "$(printf '%s' "$shared_result" | jq -r '.archived')" 1
assert_file "$MEGABRAIN_DISPATCH_DIR/archive/$(date -u '+%Y-%m')/shared-session/meta.json"
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
megabrain_dispatch_meta_write caller-session-record parent-terminal superset superset workspace-test child-terminal \
  "$root" main codex label done gpt-5 true codex caller-session %99 tmux tmux other-session %1 workspace-test >/dev/null
set_old_timestamp caller-session-record
caller_result="$(run_compiled_prune --json)"
assert_regression_equal "$(printf '%s' "$caller_result" | jq -r '.archived')" 1
assert_file "$MEGABRAIN_DISPATCH_DIR/archive/$(date -u '+%Y-%m')/caller-session-record/meta.json"
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
megabrain_dispatch_meta_write multi-pane-record parent-terminal superset superset workspace-test child-terminal \
  "$root" main codex label done gpt-5 true codex multi-pane-session %99 tmux tmux other-session %1 workspace-test >/dev/null
set_old_timestamp multi-pane-record
multi_pane_result="$(run_compiled_prune --json)"
assert_regression_equal "$(printf '%s' "$multi_pane_result" | jq -r '.archived')" 1
assert_file "$MEGABRAIN_DISPATCH_DIR/archive/$(date -u '+%Y-%m')/multi-pane-record/meta.json"
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

capture_output='prune transcript'
sync_capture
printf '%s\n' 'prune-session' >"$live_sessions"
write_dispatch prune-session done prune-session
megabrain_dispatch_start_transcript prune-session %99
set_old_timestamp prune-session
prune_result="$(run_compiled_prune --json)"
assert_equal "$(printf '%s' "$prune_result" | jq -r '.archived')" 1
assert_missing "$MEGABRAIN_DISPATCH_DIR/prune-session"
assert_missing_session="$(grep -Fx 'prune-session' "$live_sessions" >/dev/null 2>&1; printf '%s' "$?")"
assert_equal "$assert_missing_session" 1
assert_contains "$(cat "$MEGABRAIN_DISPATCH_DIR/archive/$(date -u '+%Y-%m')/prune-session/transcript")" 'prune transcript'
printf 'compiled prune archives the persisted transcript and releases tmux\n'

printf '%s\n' 'open-session' >"$live_sessions"
write_dispatch open-session running open-session
set_old_timestamp open-session
prune_result="$(run_compiled_prune --json)"
assert_equal "$(printf '%s' "$prune_result" | jq -r '.skippedDispatches[] | select(.dispatchId == "open-session") | .state')" running
assert_file "$MEGABRAIN_DISPATCH_DIR/open-session/meta.json"
assert_equal "$(grep -c '^open-session$' "$live_sessions")" 1
printf 'prune refuses an open dispatch and leaves its session alive\n'

printf '%s\n' 'unproven-session' >"$live_sessions"
write_dispatch unproven-session done unproven-session
touch "$(transcript_path unproven-session)"
set_old_timestamp unproven-session
megabrain_dispatch_terminal_status() {
  MEGABRAIN_TERMINAL_STATUS=unknown
}
unproven_prune_result="$(env MEGABRAIN_FAKE_TMUX_UNPROVEN_SESSION=unproven-session PATH="$fake_bin:$PATH" MEGABRAIN_ROOT="$root" "$root/.build/megabrain" orchestrate prune --json)"
assert_equal "$(printf '%s' "$unproven_prune_result" | jq -r '.archived')" 0
assert_equal "$(printf '%s' "$unproven_prune_result" | jq -r '.skippedDispatches[] | select(.dispatchId == "unproven-session") | .reason')" 'terminal identity is unproven'
assert_file "$MEGABRAIN_DISPATCH_DIR/unproven-session/meta.json"
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
