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

# MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION has no effect anywhere in lib/ or the entry script any
# more (grep: zero hits) — command_ask/command_done/command_received are unconditional binary
# passthroughs. This file used to run every scenario twice, once through the entry script with
# that variable set to "shell" and once against .build/megabrain directly, and assert the two
# agreed. Both invocations now exercise the identical compiled code path, so the comparison was
# testing the binary against itself (rule 3: a MEGABRAIN_*_IMPLEMENTATION=shell comparison that no
# longer does anything). Rewritten to drive the binary once per scenario and assert its own
# behaviour and effects directly.

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

run_verb() {
  local label="$1" dispatch="$2" verb="$3" text="${4:-}"
  local state="$work_dir/$dispatch" output status
  write_fixture "$state" "$dispatch"
  set +e
  if [ "$verb" = received ]; then
    output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" received 2>&1)"; status=$?
  else
    output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" "$verb" "$text" 2>&1)"; status=$?
  fi
  set -e
  [ "$status" -eq 0 ] || fail "$label refused: $output"
  [ "$(find "$state/dispatches/$dispatch/messages" -name '*.json' | wc -l | tr -d ' ')" -eq 1 ] || fail "$label did not write one message"
  printf '%s writes exactly one durable message\n' "$label"
}

run_notification_transport() {
  local host="$1" dispatch="$2" command_name metadata state effect extra_env=()
  state="$work_dir/transport-$dispatch"
  case "$host" in
    orca) command_name=orca; metadata='"parentSessionId":"parent-terminal","parentHost":"orca"' ;;
    superset) command_name=superset; metadata='"parentSessionId":"parent-terminal","parentHost":"superset","parentWorkspaceId":"parent-workspace"' ;;
    tmux) command_name=tmux; metadata='"parentSessionId":"parent-terminal","parentHost":"superset","parentTmuxSession":"parent-session","parentTmuxPane":"%parent","runtime":"tmux","tmuxSession":"parent-session","tmuxPane":"%parent","agent":"codex"' ;;
  esac
  mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
  printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"terminalId\":\"child-terminal\",\"childHost\":\"superset\",$metadata,\"state\":\"running\",\"processState\":\"running\",\"terminalState\":\"owned\"}" >"$state/dispatches/$dispatch/meta.json"
  mkdir -p "$work_dir/notify-bin"
  : >"$work_dir/binary-effect"
  if [ "$host" = tmux ]; then
    printf '%s\n' '#!/usr/bin/env bash' 'case "${1:-}" in has-session) exit 0 ;; list-panes) printf "%%parent\\n" ;; display-message) printf "parent-session\\n" ;; send-keys) printf "%s\\n" "$*" >>"$MEGABRAIN_EFFECT_FILE" ;; esac' >"$work_dir/notify-bin/$command_name"
    # A tmux-runtime dispatch's own child identity can only be matched by TMUX+TMUX_PANE, never by
    # SUPERSET_TERMINAL_ID (fixed recently: "never match a tmux child by terminal id") — the fixture's
    # own tmuxSession/tmuxPane happen to equal the parent's, which is what this fixture is built to
    # exercise, but the caller must authenticate as that pane to be accepted as the child at all.
    extra_env=(TMUX=parent-session TMUX_PANE=%parent)
  else
    printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$*" >>"$MEGABRAIN_EFFECT_FILE"' >"$work_dir/notify-bin/$command_name"
    extra_env=(SUPERSET_TERMINAL_ID=child-terminal)
  fi
  chmod +x "$work_dir/notify-bin/$command_name"
  env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_EFFECT_FILE="$work_dir/binary-effect" "${extra_env[@]}" "$root/.build/megabrain" ask 'notify body' >/dev/null 2>&1
  effect="$(cat "$work_dir/binary-effect")"
  [ -n "$effect" ] || fail "$host notification effect was not recorded"
  printf '%s notification command and arguments recorded\n' "$host"
}

run_notification_suppression() {
  local dispatch=suppressed-notification state effect
  state="$work_dir/$dispatch"
  write_fixture "$state" "$dispatch"
  mkdir -p "$state/dispatches/$dispatch"
  printf '%s\n' "{\"pid\":$$}" >"$state/dispatches/$dispatch/waiter.json"
  : >"$work_dir/suppressed-effect"
  env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_EFFECT_FILE="$work_dir/suppressed-effect" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" ask 'suppressed body' >/dev/null 2>&1
  effect="$(cat "$work_dir/suppressed-effect")"
  [ -z "$effect" ] || fail "notified despite an active waiter: $effect"
  grep -F 'outcome=suppressed reason=active-waiter' "$state/dispatches/$dispatch/nudge.log" >/dev/null || fail 'did not record active-waiter suppression'
  printf 'active waiter suppresses notification\n'
}

run_notification_context_suppression() {
  local dispatch=context-suppressed state effect
  state="$work_dir/$dispatch"
  printf '%s\n' '#!/usr/bin/env bash' 'case "${1:-}" in has-session) exit 0 ;; list-panes) printf "%%parent\\n" ;; show-environment) printf "MEGABRAIN_STATE_DIR=/other-state\\n" ;; display-message) printf "parent-session\\n" ;; send-keys) printf "%s\\n" "$*" >>"$MEGABRAIN_EFFECT_FILE" ;; esac' >"$work_dir/notify-bin/tmux"
  chmod +x "$work_dir/notify-bin/tmux"
  mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
  printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"terminalId\":\"child-terminal\",\"childHost\":\"superset\",\"parentSessionId\":\"parent-terminal\",\"parentHost\":\"superset\",\"parentTmuxSession\":\"parent-session\",\"parentTmuxPane\":\"%parent\",\"runtime\":\"tmux\",\"tmuxSession\":\"parent-session\",\"tmuxPane\":\"%parent\",\"agent\":\"codex\",\"state\":\"running\",\"processState\":\"running\"}" >"$state/dispatches/$dispatch/meta.json"
  : >"$work_dir/context-effect"
  env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_EFFECT_FILE="$work_dir/context-effect" TMUX=parent-session TMUX_PANE=%parent "$root/.build/megabrain" ask 'context body' >/dev/null
  effect="$(cat "$work_dir/context-effect")"
  [ -z "$effect" ] || fail "notified across state directories: $effect"
  grep -F 'outcome=suppressed reason=state-directory-mismatch' "$state/dispatches/$dispatch/nudge.log" >/dev/null || fail 'did not record state-directory suppression'
  printf 'cross-context parent notification is suppressed\n'
}

run_notification_failure() {
  local dispatch=failed-notification state effect
  state="$work_dir/$dispatch"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 1' >"$work_dir/notify-bin/orca"
  chmod +x "$work_dir/notify-bin/orca"
  write_fixture "$state" "$dispatch"
  : >"$work_dir/failure-effect"
  env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_EFFECT_FILE="$work_dir/failure-effect" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" ask 'failed body' >/dev/null
  [ "$(find "$state/dispatches/$dispatch/messages" -name '*.json' | wc -l | tr -d ' ')" -eq 1 ] || fail 'lost the durable write after notification failure'
  grep -F 'outcome=failed' "$state/dispatches/$dispatch/nudge.log" >/dev/null || fail 'did not record notification failure'
  printf 'notification failure preserves the durable write\n'
}

# Was "run_cross_implementation": one shell-era side wrote through megabrain_dispatch_message_append
# (lib/module-orchestrate.sh), a function that no longer exists anywhere in lib/ (grep: zero hits,
# rule 3). The real, still-valuable property — a message written by one CLI verb (ask/reply) is
# read back correctly by a different verb (orchestrate watch/check) — is kept, driven entirely
# through the binary.
run_verb_round_trip() {
  local label="$1" dispatch="$2" text="$3"
  local state="$work_dir/roundtrip-$dispatch" reader_output
  write_fixture "$state" "$dispatch"
  env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" SUPERSET_TERMINAL_ID=child-terminal MEGABRAIN_DISPATCH_ID="$dispatch" "$root/.build/megabrain" ask "$text" >/dev/null
  reader_output="$(env -i HOME="$work_dir/home" PATH="/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" ORCA_TERMINAL_HANDLE=parent-terminal "$root/.build/megabrain" orchestrate watch "$dispatch" --timeout 0 --poll-interval 0 --wait-mode poll --json)"
  [ "$(printf '%s' "$reader_output" | jq -r '.messages[0].text // empty')" = "$text" ] || fail "$label text differs: expected=$text got=$reader_output"
  printf '%s: ask write is read back by orchestrate watch\n' "$label"
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
run_verb received received received
run_verb ask ask ask 'a question'
run_verb done done done 'finished'
run_notification_transport orca notify-orca-transport
run_notification_transport superset notify-superset-transport
run_notification_transport tmux notify-tmux-transport
run_notification_suppression
run_notification_context_suppression
run_notification_failure
run_verb_round_trip 'ask then watch' roundtrip-ask-watch 'round trip body'
run_binary_concurrency
printf 'ok: queue-write behaviour, notification transports, and concurrency\n'
