#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled queue binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-queue-stray.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

make_dispatch() {
  local state="$1" with_strays="${2:-true}" with_boundary="${3:-false}"
  mkdir -p "$state/dispatches/queue/messages" "$state/dispatches/queue/deliveries"
  printf '%s\n' '{"dispatchId":"queue","parentSessionId":"parent-terminal","parentHost":"superset","state":"running"}' >"$state/dispatches/queue/meta.json"
  printf '%s\n' '{"seq":3,"from":"child","type":"ask","text":"question"}' >"$state/dispatches/queue/messages/0003-child-ask.json"
  printf '%s\n' '{"seq":7,"from":"parent","type":"reply","text":"old"}' >"$state/dispatches/queue/messages/0007-parent-reply.json"
  if [ "$with_boundary" = true ]; then
    printf '%s\n' '{"seq":10000,"from":"parent","type":"reply","text":"boundary payload"}' >"$state/dispatches/queue/messages/10000-parent-reply.json"
  fi
  [ "$with_strays" = true ] || return 0
  printf '%s\n' 'editor backup' >"$state/dispatches/queue/messages/editor-backup.json"
  printf '%s\n' 'copied fixture' >"$state/dispatches/queue/messages/copy-0042-parent-reply.json"
  printf '%s\n' 'unformatted fixture' >"$state/dispatches/queue/messages/9999.json"
  printf '%s\n' 'hidden artifact' >"$state/dispatches/queue/messages/.sync.json"
}

run_reply() {
  local implementation="$1" state="$2" executable="$3"
  if [ "$implementation" = shell ]; then
    env -i HOME="$work_dir/home" PATH="$work_dir/bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
      MEGABRAIN_ORCHESTRATE_REPLY_IMPLEMENTATION=shell SUPERSET_TERMINAL_ID=parent-terminal \
      "$executable" orchestrate reply queue --text answer --json
  else
    env -i HOME="$work_dir/home" PATH="$work_dir/bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$state" \
      SUPERSET_TERMINAL_ID=parent-terminal "$executable" orchestrate reply queue --text answer --json
  fi
}

# Stub the host command used by notification so neither implementation can touch a real host.
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' >"$work_dir/bin/superset"
chmod +x "$work_dir/bin/superset"
mkdir -p "$work_dir/home"

# Scenario written before implementation: stray names must not affect the highest valid sequence.
shell_state="$work_dir/shell-state"
binary_state="$work_dir/binary-state"
make_dispatch "$shell_state"
make_dispatch "$binary_state"
shell_output="$(run_reply shell "$shell_state" "$root/megabrain")" || fail 'shell allocation failed beside stray files'
binary_output="$(run_reply binary "$binary_state" "$root/.build/megabrain")" || fail 'binary allocation failed beside stray files'
[ "$shell_output" = "$binary_output" ] || fail "allocation output differs: shell=$shell_output binary=$binary_output"
[ -f "$shell_state/dispatches/queue/messages/0008-parent-reply.json" ] || fail 'shell did not allocate the next valid sequence'
[ -f "$binary_state/dispatches/queue/messages/0008-parent-reply.json" ] || fail 'binary did not allocate the next valid sequence'
[ ! -e "$shell_state/dispatches/queue/messages/0042-parent-reply.json" ] || fail 'shell treated the nonnumeric prefix as a sequence'
[ ! -e "$binary_state/dispatches/queue/messages/0042-parent-reply.json" ] || fail 'binary treated the nonnumeric prefix as a sequence'
printf 'queue allocation agrees beside unrecognised message names\n'

# A five-digit queue name must advance allocation and preserve the existing record.
boundary_shell_state="$work_dir/boundary-shell-state"
boundary_binary_state="$work_dir/boundary-binary-state"
make_dispatch "$boundary_shell_state" false true
make_dispatch "$boundary_binary_state" false true
boundary_shell_output="$(run_reply shell "$boundary_shell_state" "$root/megabrain")" || fail 'shell boundary allocation failed'
boundary_binary_output="$(run_reply binary "$boundary_binary_state" "$root/.build/megabrain")" || fail 'binary boundary allocation failed'
[ "$boundary_shell_output" = "$boundary_binary_output" ] || fail "boundary output differs: shell=$boundary_shell_output binary=$boundary_binary_output"
for implementation in shell binary; do
  state="$work_dir/boundary-$implementation-state"
  [ "$(jq -r '.seq' "$state/dispatches/queue/messages/10001-parent-reply.json")" = 10001 ] || fail "$implementation did not allocate sequence 10001"
  [ "$(jq -r '.text' "$state/dispatches/queue/messages/10000-parent-reply.json")" = 'boundary payload' ] || fail "$implementation overwrote the five-digit message"
done
printf 'five-digit queue allocation preserves 10000 and writes 10001\n'

# Falsification for visibility: clean dispatches must not report a stray file.
clean_shell_state="$work_dir/clean-shell-state"
clean_binary_state="$work_dir/clean-binary-state"
make_dispatch "$clean_shell_state" false
make_dispatch "$clean_binary_state" false
clean_doctor_binary="$work_dir/clean-doctor-binary.output"
env -i HOME="$work_dir/home" PATH="$work_dir/bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$clean_binary_state" \
  "$root/.build/megabrain" doctor orchestration >"$clean_doctor_binary" 2>&1 || true
case "$(cat "$clean_doctor_binary")" in
  *editor-backup.json*) fail 'binary doctor reported a stray file in a clean dispatch' ;;
esac

# The populated fixture must be reportable through the compiled doctor entry point.
doctor_binary="$work_dir/doctor-binary.output"
doctor_binary_state="$work_dir/doctor-binary-state"
make_dispatch "$doctor_binary_state" true true
env -i HOME="$work_dir/home" PATH="$work_dir/bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$doctor_binary_state" \
  "$root/.build/megabrain" doctor orchestration >"$doctor_binary" 2>&1 || true
case "$(cat "$doctor_binary")" in
  *editor-backup.json*) ;;
  *) fail 'binary doctor did not report the unrecognised message file' ;;
esac

doctor_binary_boundary="$work_dir/doctor-binary-boundary.output"
env -i HOME="$work_dir/home" PATH="$work_dir/bin:/usr/bin:/bin" MEGABRAIN_STATE_DIR="$doctor_binary_state" \
  "$root/.build/megabrain" doctor orchestration >"$doctor_binary_boundary" 2>&1 || true
case "$(cat "$doctor_binary_boundary")" in
  *10000-parent-reply.json*) fail 'binary doctor reported a valid five-digit message' ;;
esac
printf 'doctor reports unrecognised message names\n'

printf 'ok: queue allocation tolerates and reports stray message files\n'
