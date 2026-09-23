#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
binary="$root/.build/megabrain"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-health-counts.XXXXXX")"
state_dir="$state_root/state"
wrapper_dir="$state_root/bin"
tmux_call_log="$state_root/tmux-calls.log"

cleanup() {
  rm -rf "$state_root"
}
trap cleanup EXIT

[ -x "$binary" ] || {
  printf 'skip: compiled binary is missing at %s; run bun run build\n' "$binary"
  exit 0
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_json() {
  printf '%s\n' "$1" | jq -e "$2" >/dev/null || fail "JSON assertion failed: $2
$1"
}

write_meta() {
  local dispatch_id="$1" process_state="$2" terminal_state="$3" state="$4" runtime="$5" tmux_session="$6" parent_tmux_session="$7" terminal_reason="$8" updated_at="$9"
  local dispatch_dir="$state_dir/dispatches/$dispatch_id" terminal_reason_field=''
  [ "$terminal_reason" = __missing__ ] || terminal_reason_field=",\"terminalReason\":\"$terminal_reason\""
  mkdir -p "$dispatch_dir"
  printf '%s\n' "{\"dispatchId\":\"$dispatch_id\",\"state\":\"$state\",\"processState\":\"$process_state\",\"terminalState\":\"$terminal_state\"$terminal_reason_field,\"runtime\":\"$runtime\",\"tmuxSession\":\"$tmux_session\",\"parentTmuxSession\":\"$parent_tmux_session\",\"createdAt\":\"2020-01-01T00:00:00Z\",\"updatedAt\":\"$updated_at\"}" >"$dispatch_dir/meta.json"
}

reset_dispatches() {
  rm -rf "$state_dir"
  mkdir -p "$state_dir/dispatches"
}

mkdir -p "$wrapper_dir"
cat >"$wrapper_dir/tmux" <<EOF
#!/usr/bin/env bash
printf 'tmux\n' >>"$tmux_call_log"
case "\${1:-}:\${2:-}" in
  list-sessions:-F)
    printf '%s\n' 'leaked-session'
    ;;
  has-session:-t)
    [ "\${3:-}" = leaked-session ]
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod +x "$wrapper_dir/tmux"

run_doctor() {
  PATH="$wrapper_dir:$PATH" MEGABRAIN_STATE_DIR="$state_dir" "$binary" doctor orchestration --json || true
}

# Scenario: `doctor orchestration` counts every uncertain/retained/leaked dispatch exactly
# once, dedupes a leaked tmux session shared by two dispatches, and excludes a session that
# equals its own parent or that this caller is itself running in.
# Falsification: a miscount, a duplicate leaked session, or counting a dispatch that does not
# match any condition.
reset_dispatches
write_meta uncertain-abandoned abandoned owned closed host '' '' '' 2020-01-01T00:00:00Z
write_meta uncertain-exited exited owned closed host '' '' '' 2020-01-01T00:00:00Z
write_meta uncertain-start start-unproven owned closed host '' '' '' 2020-01-01T00:00:00Z
write_meta uncertain-stop stop-unproven owned closed host '' '' '' 2020-01-01T00:00:00Z
write_meta retained-default running retained failed host '' '' __missing__ 2020-01-01T00:00:00Z
write_meta retained-custom running retained closed host '' '' 'identity check pending' 2020-01-01T00:00:00Z
write_meta leaked-one running owned closed tmux leaked-session other-session '' 2020-01-01T00:00:00Z
write_meta leaked-duplicate running owned done tmux leaked-session other-session '' 2020-01-01T00:00:00Z
write_meta not-leaked-shared running owned closed tmux leaked-session leaked-session '' 2020-01-01T00:00:00Z
write_meta not-prunable-running running owned running host '' '' '' 2020-01-01T00:00:00Z
write_meta recent-closed running owned closed host '' '' '' 2999-01-01T00:00:00Z
mkdir -p "$state_dir/dispatches/untracked/messages"
mkdir -p "$state_dir/dispatches/broken"
printf '%s\n' '{"dispatchId":"broken", THIS IS NOT JSON' >"$state_dir/dispatches/broken/meta.json"
mkdir -p "$state_dir/dispatches/archive/ignored"
printf '%s\n' 'ignored' >"$state_dir/dispatches/archive/ignored/meta.json"

doctor_output="$(run_doctor)"

assert_equal "$(printf '%s' "$doctor_output" | jq -r '.uncertainDispatches')" 4
assert_equal "$(printf '%s' "$doctor_output" | jq -r '.retainedTerminals')" 2
assert_equal "$(printf '%s' "$doctor_output" | jq -r '.leakedDispatchSessions')" 1
# Reason order is directory-read order, not guaranteed; compare as a sorted set.
expected_uncertain='[{"dispatchId":"uncertain-abandoned","reason":"process was abandoned without proof","processState":"abandoned","terminalState":"owned"},{"dispatchId":"uncertain-exited","reason":"agent exited without reporting","processState":"exited","terminalState":"owned"},{"dispatchId":"uncertain-start","reason":"process start was not proven","processState":"start-unproven","terminalState":"owned"},{"dispatchId":"uncertain-stop","reason":"process stop was not proven","processState":"stop-unproven","terminalState":"owned"}]'
expected_retained='[{"dispatchId":"retained-custom","reason":"identity check pending","processState":"running","terminalState":"retained"},{"dispatchId":"retained-default","reason":"terminal identity remains unproven","processState":"running","terminalState":"retained"}]'
assert_json "$doctor_output" "(.uncertainReasons | sort_by(.dispatchId)) == ($expected_uncertain | sort_by(.dispatchId))"
assert_json "$doctor_output" "(.retainedReasons | sort_by(.dispatchId)) == ($expected_retained | sort_by(.dispatchId))"
printf 'health counts: uncertain, retained, and leaked-session counts and reasons match\n'

# FINDING (rule 4, not a test defect): `prunableDispatches` is declared in
# src/cli/commands/install-doctor.ts's Report/emptyCounts (lines 16 and 176) and quoted in the
# doctor reason string (line 313), but nothing in the file ever increments it — it is always 0.
# The scenario above has 9 dispatches in a prunable state (closed/done/failed) excluding the one
# still "running" and the one updated far in the future ("recent-closed", which the shell's
# megabrain_dispatch_health_counts treats as too recent to prune) — the shell reported 9. This
# assertion is left failing on purpose per the triage brief's rule 4: do not weaken it, do not
# touch src/, report it to the lead.
assert_equal "$(printf '%s' "$doctor_output" | jq -r '.prunableDispatches')" 9
printf 'health counts: prunable dispatches counted\n'

# FINDING (rule 4): a dispatch directory with no meta.json ("untracked", created above) is
# silently swallowed by dispatchHealth's try/catch (install-doctor.ts:200-208) with no count and
# no notice anywhere in stdout or stderr, unlike the shell's explicit
# "dispatch directories without metadata: untracked" line. Left failing on purpose; see the
# report.
doctor_stderr="$(PATH="$wrapper_dir:$PATH" MEGABRAIN_STATE_DIR="$state_dir" "$binary" doctor orchestration --json 2>&1 >/dev/null || true)"
case "$doctor_output$doctor_stderr" in
  *'untracked'*) ;;
  *) fail 'doctor orchestration gave no notice about the untracked dispatch directory' ;;
esac
printf 'health counts: untracked dispatch directory surfaced\n'

# Scenario: the tmux session listing is read once per doctor run, not once per dispatch record,
# so a large dispatch directory does not multiply tmux invocations.
# Falsification: tmux call count grows with dispatch count instead of staying flat.
tmux_call_count() {
  local count="$1" i
  reset_dispatches
  for i in $(seq 1 "$count"); do
    write_meta "dispatch-$i" running owned closed host '' '' '' 2020-01-01T00:00:00Z
  done
  : >"$tmux_call_log"
  run_doctor >/dev/null 2>&1 || true
  wc -l <"$tmux_call_log" | tr -d ' '
}
small_count="$(tmux_call_count 10)"
large_count="$(tmux_call_count 100)"
[ $((large_count - small_count)) -le 1 ] ||
  fail "tmux call count grew from $small_count to $large_count across 10 vs 100 dispatch records"
printf 'health counts: tmux session listing stays flat at 10 and 100 records (%s, %s)\n' "$small_count" "$large_count"

printf 'ok: doctor orchestration health counts (with two open findings, see report)\n'
