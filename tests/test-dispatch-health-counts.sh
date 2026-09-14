#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-health-counts.XXXXXX")"
state_dir="$state_root/state"
live_sessions="$state_root/live-sessions"
wrapper_dir="$state_root/bin"
fork_log="$state_root/forks.log"
real_jq="$(command -v jq)"
real_date="$(command -v date)"

cleanup() {
  rm -rf "$state_root"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_json() {
  printf '%s\n' "$1" | "$real_jq" -e "$2" >/dev/null || fail "JSON assertion failed: $2\n$1"
}

write_meta() {
  local dispatch_id="$1" process_state="$2" terminal_state="$3" state="$4" runtime="$5" tmux_session="$6" parent_tmux_session="$7" terminal_reason="$8" updated_at="$9"
  local dispatch_dir="$MEGABRAIN_DISPATCH_DIR/$dispatch_id" terminal_reason_field=''
  [ "$terminal_reason" = __missing__ ] || terminal_reason_field=",\"terminalReason\":\"$terminal_reason\""
  mkdir -p "$dispatch_dir"
  printf '%s\n' "{\"dispatchId\":\"$dispatch_id\",\"state\":\"$state\",\"processState\":\"$process_state\",\"terminalState\":\"$terminal_state\"$terminal_reason_field,\"runtime\":\"$runtime\",\"tmuxSession\":\"$tmux_session\",\"parentTmuxSession\":\"$parent_tmux_session\",\"createdAt\":\"2020-01-01T00:00:00Z\",\"updatedAt\":\"$updated_at\"}" >"$dispatch_dir/meta.json"
}

reset_dispatches() {
  rm -rf "$MEGABRAIN_DISPATCH_DIR"
  mkdir -p "$MEGABRAIN_DISPATCH_DIR"
  : >"$live_sessions"
}

mkdir -p "$wrapper_dir" "$state_dir" "$state_dir/dispatches"
printf '%s\n' 'leaked-session' >"$live_sessions"

cat >"$wrapper_dir/jq" <<'EOF'
#!/usr/bin/env bash
printf 'jq\n' >>"$MEGABRAIN_TEST_FORK_LOG"
exec "$MEGABRAIN_TEST_REAL_JQ" "$@"
EOF
cat >"$wrapper_dir/date" <<'EOF'
#!/usr/bin/env bash
printf 'date\n' >>"$MEGABRAIN_TEST_FORK_LOG"
exec "$MEGABRAIN_TEST_REAL_DATE" "$@"
EOF
cat >"$wrapper_dir/tmux" <<'EOF'
#!/usr/bin/env bash
printf 'tmux\n' >>"$MEGABRAIN_TEST_FORK_LOG"
case "${1:-}:${2:-}" in
  list-sessions:-F)
    cat "$MEGABRAIN_TEST_LIVE_SESSIONS"
    ;;
  has-session:-t)
    [ "${3:-}" = leaked-session ]
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod +x "$wrapper_dir/jq" "$wrapper_dir/date" "$wrapper_dir/tmux"

export MEGABRAIN_STATE_DIR="$state_dir"
export MEGABRAIN_DISPATCH_DIR="$state_dir/dispatches"
export MEGABRAIN_TEST_FORK_LOG="$fork_log"
export MEGABRAIN_TEST_REAL_JQ="$real_jq"
export MEGABRAIN_TEST_REAL_DATE="$real_date"
export MEGABRAIN_TEST_LIVE_SESSIONS="$live_sessions"

source "$root/lib/common.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-tmux-runtime.sh"

scenario_counts_every_condition() {
  local expected_uncertain='' expected_retained=''
  reset_dispatches
  printf '%s\n' 'leaked-session' >"$live_sessions"
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
  mkdir -p "$MEGABRAIN_DISPATCH_DIR/untracked/messages"
  mkdir -p "$MEGABRAIN_DISPATCH_DIR/broken"
  printf '%s\n' '{"dispatchId":"broken", THIS IS NOT JSON' >"$MEGABRAIN_DISPATCH_DIR/broken/meta.json"
  mkdir -p "$MEGABRAIN_DISPATCH_DIR/archive/ignored"
  printf '%s\n' 'ignored' >"$MEGABRAIN_DISPATCH_DIR/archive/ignored/meta.json"

  PATH="$wrapper_dir:$PATH" megabrain_dispatch_health_counts 2>"$state_root/notice.log"

  assert_equal "$MODULE_UNCERTAIN_DISPATCHES" 4
  assert_equal "$MODULE_RETAINED_TERMINALS" 2
  assert_equal "$MODULE_LEAKED_DISPATCH_SESSIONS" 1
  assert_equal "$MODULE_PRUNABLE_DISPATCHES" 9
  assert_equal "$MODULE_UNTRACKED_DISPATCHES" untracked
  expected_uncertain='[{"dispatchId":"uncertain-abandoned","reason":"process was abandoned without proof","processState":"abandoned","terminalState":"owned"},{"dispatchId":"uncertain-exited","reason":"agent exited without reporting","processState":"exited","terminalState":"owned"},{"dispatchId":"uncertain-start","reason":"process start was not proven","processState":"start-unproven","terminalState":"owned"},{"dispatchId":"uncertain-stop","reason":"process stop was not proven","processState":"stop-unproven","terminalState":"owned"}]'
  expected_retained='[{"dispatchId":"retained-custom","reason":"identity check pending","processState":"running","terminalState":"retained"},{"dispatchId":"retained-default","reason":"terminal identity remains unproven","processState":"running","terminalState":"retained"}]'
  assert_json "$MODULE_UNCERTAIN_REASONS" ". == $expected_uncertain"
  assert_json "$MODULE_RETAINED_REASONS" ". == $expected_retained"
  grep -F 'dispatch directories without metadata: untracked' "$state_root/notice.log" >/dev/null || fail 'missing-meta notice was not emitted'
  printf 'health counts preserve every counter and reason document\n'
}

make_count_fixture() {
  local count="$1" i=0
  reset_dispatches
  for i in $(seq 1 "$count"); do
    write_meta "dispatch-$i" running owned closed host '' '' '' 2020-01-01T00:00:00Z
  done
}

health_fork_count() {
  local count="$1"
  make_count_fixture "$count"
  : >"$fork_log"
  PATH="$wrapper_dir:$PATH" megabrain_dispatch_health_counts >/dev/null 2>&1
  wc -l <"$fork_log" | tr -d ' '
}

scenario_fork_count_is_bounded() {
  local small_count large_count
  small_count="$(health_fork_count 10)"
  large_count="$(health_fork_count 100)"
  [ $((large_count - small_count)) -le 2 ] ||
    fail "fork count grew from $small_count to $large_count"
  printf 'health fork count stays bounded at 10 and 100 records (%s, %s)\n' "$small_count" "$large_count"
}

scenario_counts_every_condition
scenario_fork_count_is_bounded
