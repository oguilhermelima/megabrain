#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled queue-write binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-queue-write-cli.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

write_fixture() {
  local state="$1" dispatch="$2"
  mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
  printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"terminalId\":\"child-terminal\",\"childHost\":\"superset\",\"parentSessionId\":\"parent-terminal\",\"parentHost\":\"orca\",\"state\":\"running\",\"processState\":\"running\",\"terminalState\":\"owned\"}" >"$state/dispatches/$dispatch/meta.json"
}

write_tmux_fixture() {
  local state="$1" dispatch="$2" tmux_session="$3" tmux_pane="$4"
  mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
  printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"runtime\":\"tmux\",\"tmuxSession\":\"$tmux_session\",\"tmuxPane\":\"$tmux_pane\",\"state\":\"running\",\"processState\":\"running\"}" >"$state/dispatches/$dispatch/meta.json"
}

run_tmux_queue() {
  local state="$1" output status
  set +e
  output="$(env -i HOME="$work_dir/home" PATH="$work_dir/bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" TMUX=managed TMUX_PANE=%1 "$root/.build/megabrain" received 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$status" "$output"
}

mkdir -p "$work_dir/bin"
printf '%s\n' '#!/usr/bin/env bash' 'if [ "${1:-}" = list-panes ]; then printf "session-a\t%%1\n"; fi' >"$work_dir/bin/tmux"
chmod +x "$work_dir/bin/tmux"

tmux_unset_state="$work_dir/tmux-unset"
write_tmux_fixture "$tmux_unset_state" tmux-target session-a %1
unset_result="$(run_tmux_queue "$tmux_unset_state")"
[ "$(printf '%s\n' "$unset_result" | sed -n '1p')" -eq 0 ] || fail "unset dispatch id leaked an invalid identifier: $(printf '%s\n' "$unset_result" | sed -n '2p')"
[ "$(printf '%s\n' "$unset_result" | sed -n '2p')" = 'received sent: tmux-target' ] || fail "unset dispatch id chose the wrong dispatch: $(printf '%s\n' "$unset_result" | sed -n '2p')"
printf 'tmux child without dispatch id resolves its dispatch\n'

tmux_match_state="$work_dir/tmux-match"
write_tmux_fixture "$tmux_match_state" tmux-right session-a %1
write_tmux_fixture "$tmux_match_state" tmux-wrong session-b %2
match_result="$(run_tmux_queue "$tmux_match_state")"
[ "$(printf '%s\n' "$match_result" | sed -n '1p')" -eq 0 ] || fail "tmux matching selected the wrong dispatch: $(printf '%s\n' "$match_result" | sed -n '2p')"
[ "$(printf '%s\n' "$match_result" | sed -n '2p')" = 'received sent: tmux-right' ] || fail "tmux matching selected the wrong dispatch: $(printf '%s\n' "$match_result" | sed -n '2p')"
printf 'tmux child matches only its session and pane\n'

tmux_missing_state="$work_dir/tmux-missing"
write_tmux_fixture "$tmux_missing_state" tmux-other session-b %2
missing_result="$(run_tmux_queue "$tmux_missing_state")"
[ "$(printf '%s\n' "$missing_result" | sed -n '1p')" -ne 0 ] || fail 'unmatched tmux child was accepted'
case "$missing_result" in *undefined*) fail "unmatched tmux child leaked an undefined identifier: $missing_result" ;; esac
case "$missing_result" in *'no managed dispatch belongs to tmux session session-a pane %1'*) ;; *) fail "unmatched tmux child returned the wrong refusal: $missing_result" ;; esac
printf 'unmatched tmux child is refused\n'

run_pair() {
  local label dispatch verb text shell_state binary_state shell_output binary_output shell_status binary_status
  label="$1"; dispatch="$2"; verb="$3"; text="${4:-}"
  shell_state="$work_dir/shell-$dispatch"; binary_state="$work_dir/binary-$dispatch"
  write_fixture "$shell_state" "$dispatch"
  write_fixture "$binary_state" "$dispatch"
  set +e
  if [ "$verb" = received ]; then
    shell_output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$shell_state" MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION=shell SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" received 2>&1)"; shell_status=$?
    binary_output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$binary_state" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" received 2>&1)"; binary_status=$?
  else
    shell_output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$shell_state" MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION=shell SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" "$verb" "$text" 2>&1)"; shell_status=$?
    binary_output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$binary_state" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" "$verb" "$text" 2>&1)"; binary_status=$?
  fi
  set -e
  [ "$shell_status" -eq "$binary_status" ] || fail "$label status shell=$shell_status binary=$binary_status"
  [ "$shell_output" = "$binary_output" ] || fail "$label output differs: shell=$shell_output binary=$binary_output"
  [ "$shell_status" -eq 0 ] || fail "$label refused: $shell_output"
  [ "$(find "$binary_state/dispatches/$dispatch/messages" -name '*.json' | wc -l | tr -d ' ')" -eq 1 ] || fail "$label did not write one message"
  printf '%s agrees between shell and binary\n' "$label"
}

run_cross_implementation() {
  local label="$1" writer="$2" reader="$3" dispatch="$4" text="$5" writer_output reader_output
  local state="$work_dir/cross-$dispatch"
  write_fixture "$state" "$dispatch"
  if [ "$writer" = shell ]; then
    env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION=shell ORCA_TERMINAL_HANDLE=parent-terminal bash -c 'source "$MEGABRAIN_ROOT/lib/common.sh"; source "$MEGABRAIN_ROOT/lib/module-orchestrate.sh"; megabrain_dispatch_message_append "$1" parent reply "$2" parent-terminal' -- "$dispatch" "$text" >/dev/null
  else
    env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=child-terminal MEGABRAIN_DISPATCH_ID="$dispatch" "$root/.build/megabrain" ask "$text" >/dev/null
  fi
  if [ "$reader" = shell ]; then
    reader_output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION=shell ORCA_TERMINAL_HANDLE=parent-terminal "$root/megabrain" orchestrate watch "$dispatch" --timeout 0 --poll-interval 0 --wait-mode poll --json)"
  else
    reader_output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=child-terminal MEGABRAIN_DISPATCH_ID="$dispatch" "$root/.build/megabrain" check --timeout 0 --poll-interval 0 --json)"
  fi
  [ "$(printf '%s' "$reader_output" | jq -r '.messages[0].text // empty')" = "$text" ] || fail "$label text differs: expected=$text got=$reader_output"
  printf '%s crosses writer and reader implementations\n' "$label"
}

run_binary_concurrency() {
  local dispatch=binary-concurrency writers=20
  local state="$work_dir/$dispatch"
  local writer_dir="$state/writers" messages_dir="$state/dispatches/$dispatch/messages"
  write_fixture "$state" "$dispatch"
  mkdir -p "$writer_dir"
  for i in $(seq 1 "$writers"); do
    (
      if env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=child-terminal MEGABRAIN_DISPATCH_ID="$dispatch" "$root/.build/megabrain" ask "binary body $i" >/dev/null 2>"$writer_dir/$i.stderr"; then
        : >"$writer_dir/$i.written"
      else
        : >"$writer_dir/$i.refused"
      fi
      : >"$writer_dir/$i.exit"
    ) &
  done
  wait
  local durable refused written unique_seqs unique_bodies
  durable="$(find "$writer_dir" -name '*.written' | wc -l | tr -d ' ')"
  refused="$(find "$writer_dir" -name '*.refused' | wc -l | tr -d ' ')"
  written="$(find "$messages_dir" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ')"
  unique_seqs="$(find "$messages_dir" -maxdepth 1 -name '*.json' -exec jq -r '.seq' {} \; | sort -u | wc -l | tr -d ' ')"
  unique_bodies="$(find "$messages_dir" -maxdepth 1 -name '*.json' -exec jq -r '.text' {} \; | sort -u | wc -l | tr -d ' ')"
  [ $((durable + refused)) -eq "$writers" ] || fail "binary concurrency unaccounted: durable=$durable refused=$refused"
  [ "$written" -eq "$durable" ] || fail "binary concurrency durable mismatch: durable=$durable files=$written"
  [ "$unique_seqs" -eq "$durable" ] || fail "binary concurrency duplicate sequences: unique=$unique_seqs durable=$durable"
  [ "$unique_bodies" -eq "$durable" ] || fail "binary concurrency duplicate bodies: unique=$unique_bodies durable=$durable"
  printf 'binary concurrency: %s durable, %s refused\n' "$durable" "$refused"
}

mkdir -p "$work_dir/home"
run_pair received received received
run_pair ask ask ask 'a question'
run_pair done done done 'finished'
run_cross_implementation 'binary write shell read' binary shell cross-binary-shell 'cross binary body'
run_cross_implementation 'shell write binary read' shell binary cross-shell-binary 'cross shell body'
run_binary_concurrency
printf 'ok: queue-write implementations agree across child verbs\n'
