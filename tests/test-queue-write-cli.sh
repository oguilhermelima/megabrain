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

run_notification_contract() {
  local host="$1" dispatch="$2" shell_state binary_state shell_effect binary_effect
  shell_state="$work_dir/notify-shell-$dispatch"; binary_state="$work_dir/notify-binary-$dispatch"
  mkdir -p "$work_dir/notify-bin"
  write_host_fixture() {
    local state="$1" id="$2"
    mkdir -p "$state/dispatches/$id/messages" "$state/dispatches/$id/deliveries"
    printf '%s\n' "{\"dispatchId\":\"$id\",\"terminalId\":\"child-terminal\",\"childHost\":\"superset\",\"parentSessionId\":\"parent-terminal\",\"parentHost\":\"$host\",\"parentWorkspaceId\":\"parent-workspace\",\"state\":\"running\",\"processState\":\"running\",\"terminalState\":\"owned\"}" >"$state/dispatches/$id/meta.json"
  }
  write_host_fixture "$shell_state" "$dispatch"
  write_host_fixture "$binary_state" "$dispatch"
  : >"$work_dir/shell-effect"
  : >"$work_dir/binary-effect"
  printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$*" >>"$MEGABRAIN_EFFECT_FILE"' >"$work_dir/notify-bin/$host"
  chmod +x "$work_dir/notify-bin/$host"
  set +e
  env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$shell_state" MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION=shell MEGABRAIN_EFFECT_FILE="$work_dir/shell-effect" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" ask 'notify body' >/dev/null 2>&1
  env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$binary_state" MEGABRAIN_EFFECT_FILE="$work_dir/binary-effect" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" ask 'notify body' >/dev/null 2>&1
  set -e
  shell_effect="$(cat "$work_dir/shell-effect")"
  binary_effect="$(cat "$work_dir/binary-effect")"
  [ "$shell_effect" = "$binary_effect" ] || fail "$host notification effect differs: shell=$shell_effect binary=$binary_effect"
  printf '%s notification effect agrees between shell and binary\n' "$host"
}

run_notification_transport() {
  local host="$1" dispatch="$2" command_name metadata shell_state binary_state shell_effect binary_effect
  shell_state="$work_dir/transport-shell-$dispatch"; binary_state="$work_dir/transport-binary-$dispatch"
  case "$host" in
    orca) command_name=orca; metadata='"parentSessionId":"parent-terminal","parentHost":"orca"' ;;
    superset) command_name=superset; metadata='"parentSessionId":"parent-terminal","parentHost":"superset","parentWorkspaceId":"parent-workspace"' ;;
    tmux) command_name=tmux; metadata='"parentSessionId":"parent-terminal","parentHost":"superset","parentTmuxSession":"parent-session","parentTmuxPane":"%parent","runtime":"tmux","tmuxSession":"parent-session","tmuxPane":"%parent","agent":"codex"' ;;
  esac
  write_transport_fixture() {
    local state="$1"
    mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
    printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"terminalId\":\"child-terminal\",\"childHost\":\"superset\",$metadata,\"state\":\"running\",\"processState\":\"running\",\"terminalState\":\"owned\"}" >"$state/dispatches/$dispatch/meta.json"
  }
  write_transport_fixture "$shell_state"; write_transport_fixture "$binary_state"
  : >"$work_dir/shell-effect"; : >"$work_dir/binary-effect"
  if [ "$host" = tmux ]; then
    printf '%s\n' '#!/usr/bin/env bash' 'case "${1:-}" in has-session) exit 0 ;; list-panes) printf "%%parent\\n" ;; display-message) printf "parent-session\\n" ;; send-keys) printf "%s\\n" "$*" >>"$MEGABRAIN_EFFECT_FILE" ;; esac' >"$work_dir/notify-bin/$command_name"
  else
    printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$*" >>"$MEGABRAIN_EFFECT_FILE"' >"$work_dir/notify-bin/$command_name"
  fi
  chmod +x "$work_dir/notify-bin/$command_name"
  set +e
  env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$shell_state" MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION=shell MEGABRAIN_EFFECT_FILE="$work_dir/shell-effect" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" ask 'notify body' >/dev/null 2>&1
  env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$binary_state" MEGABRAIN_EFFECT_FILE="$work_dir/binary-effect" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" ask 'notify body' >/dev/null 2>&1
  set -e
  shell_effect="$(cat "$work_dir/shell-effect")"; binary_effect="$(cat "$work_dir/binary-effect")"
  [ "$shell_effect" = "$binary_effect" ] || fail "$host notification effect differs: shell=$shell_effect binary=$binary_effect"
  [ -n "$shell_effect" ] || fail "$host notification effect was not recorded"
  printf '%s notification command and arguments agree\n' "$host"
}

run_notification_suppression() {
  local dispatch=suppressed-notification state effect
  for implementation in shell binary; do
    state="$work_dir/$implementation-$dispatch"
    if [ "$implementation" = shell ]; then
      write_fixture "$state" "$dispatch"
      command=(env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION=shell MEGABRAIN_EFFECT_FILE="$work_dir/suppressed-effect" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" ask 'suppressed body')
    else
      write_fixture "$state" "$dispatch"
      command=(env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_EFFECT_FILE="$work_dir/suppressed-effect" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" ask 'suppressed body')
    fi
    mkdir -p "$state/dispatches/$dispatch"
    printf '%s\n' "{\"pid\":$$}" >"$state/dispatches/$dispatch/waiter.json"
    : >"$work_dir/suppressed-effect"
    "${command[@]}" >/dev/null 2>&1
    effect="$(cat "$work_dir/suppressed-effect")"
    [ -z "$effect" ] || fail "$implementation notified despite an active waiter: $effect"
    grep -F 'outcome=suppressed reason=active-waiter' "$state/dispatches/$dispatch/nudge.log" >/dev/null || fail "$implementation did not record active-waiter suppression"
  done
  printf 'active waiter suppresses both notification implementations\n'
}

run_notification_context_suppression() {
  local dispatch=context-suppressed state effect
  printf '%s\n' '#!/usr/bin/env bash' 'case "${1:-}" in has-session) exit 0 ;; list-panes) printf "%%parent\\n" ;; show-environment) printf "MEGABRAIN_STATE_DIR=/other-state\\n" ;; display-message) printf "parent-session\\n" ;; send-keys) printf "%s\\n" "$*" >>"$MEGABRAIN_EFFECT_FILE" ;; esac' >"$work_dir/notify-bin/tmux"
  chmod +x "$work_dir/notify-bin/tmux"
  for implementation in shell binary; do
    state="$work_dir/$implementation-$dispatch"
    mkdir -p "$state/dispatches/$dispatch/messages" "$state/dispatches/$dispatch/deliveries"
    printf '%s\n' "{\"dispatchId\":\"$dispatch\",\"terminalId\":\"child-terminal\",\"childHost\":\"superset\",\"parentSessionId\":\"parent-terminal\",\"parentHost\":\"superset\",\"parentTmuxSession\":\"parent-session\",\"parentTmuxPane\":\"%parent\",\"runtime\":\"tmux\",\"tmuxSession\":\"parent-session\",\"tmuxPane\":\"%parent\",\"agent\":\"codex\",\"state\":\"running\",\"processState\":\"running\"}" >"$state/dispatches/$dispatch/meta.json"
    : >"$work_dir/context-effect"
    if [ "$implementation" = shell ]; then
      env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION=shell MEGABRAIN_EFFECT_FILE="$work_dir/context-effect" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" ask 'context body' >/dev/null
    else
      env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_EFFECT_FILE="$work_dir/context-effect" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" ask 'context body' >/dev/null
    fi
    effect="$(cat "$work_dir/context-effect")"
    [ -z "$effect" ] || fail "$implementation notified across state directories: $effect"
    grep -F 'outcome=suppressed reason=state-directory-mismatch' "$state/dispatches/$dispatch/nudge.log" >/dev/null || fail "$implementation did not record state-directory suppression"
  done
  printf 'cross-context parent notification is suppressed by both implementations\n'
}

run_notification_failure() {
  local dispatch=failed-notification state effect
  printf '%s\n' '#!/usr/bin/env bash' 'exit 1' >"$work_dir/notify-bin/orca"
  chmod +x "$work_dir/notify-bin/orca"
  for implementation in shell binary; do
    state="$work_dir/$implementation-$dispatch"
    write_fixture "$state" "$dispatch"
    : >"$work_dir/failure-effect"
    if [ "$implementation" = shell ]; then
      env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_QUEUE_WRITE_IMPLEMENTATION=shell MEGABRAIN_EFFECT_FILE="$work_dir/failure-effect" SUPERSET_TERMINAL_ID=child-terminal "$root/megabrain" ask 'failed body' >/dev/null
    else
      env -i HOME="$work_dir/home" PATH="$work_dir/notify-bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_EFFECT_FILE="$work_dir/failure-effect" SUPERSET_TERMINAL_ID=child-terminal "$root/.build/megabrain" ask 'failed body' >/dev/null
    fi
    [ "$(find "$state/dispatches/$dispatch/messages" -name '*.json' | wc -l | tr -d ' ')" -eq 1 ] || fail "$implementation lost the durable write after notification failure"
    grep -F 'outcome=failed' "$state/dispatches/$dispatch/nudge.log" >/dev/null || fail "$implementation did not record notification failure"
  done
  printf 'notification failure preserves the durable write\n'
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
run_notification_contract orca notify-orca
run_notification_transport orca notify-orca-transport
run_notification_transport superset notify-superset-transport
run_notification_transport tmux notify-tmux-transport
run_notification_suppression
run_notification_context_suppression
run_notification_failure
run_cross_implementation 'binary write shell read' binary shell cross-binary-shell 'cross binary body'
run_cross_implementation 'shell write binary read' shell binary cross-shell-binary 'cross shell body'
run_binary_concurrency
printf 'ok: queue-write implementations agree across child verbs\n'
