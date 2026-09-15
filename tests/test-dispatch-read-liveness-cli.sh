#!/usr/bin/env bash
set -euo pipefail

# Scenarios written before implementation: host read, missing dispatch, and tmux liveness
# classification for working, idle, blocked, and unknown frames.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-read-liveness-cli.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

write_host_fixture() {
  local state="$1"
  mkdir -p "$state/dispatches/host-read/messages"
  printf '%s\n' '{"dispatchId":"host-read","parentSessionId":"parent","parentHost":"orca","runtime":"host","childHost":"orca","terminalId":"child"}' >"$state/dispatches/host-read/meta.json"
}

write_tmux_fixture() {
  local state="$1" frame="$2" dispatch_state="${3:-running}"
  mkdir -p "$state/dispatches/live/messages"
  printf '{"dispatchId":"live","parentSessionId":"parent","parentHost":"orca","runtime":"tmux","childHost":"orca","agent":"codex","tmuxSession":"session","tmuxPane":"%s","state":"%s"}\n' '%1' "$dispatch_state" >"$state/dispatches/live/meta.json"
  cp "$root/tests/fixtures/agent-liveness/$frame.transcript" "$work/pane"
}

run_side() {
  local side="$1" verb="$2" state="$3" executable="$4"; shift 4
  local implementation="" implementation_name="MEGABRAIN_ORCHESTRATE_$(printf '%s' "$verb" | tr '[:lower:]' '[:upper:]')_IMPLEMENTATION"
  [ "$side" = shell ] && implementation="$implementation_name=shell"
  env -i HOME="$work/home" PATH="$work/bin:/usr/bin:/bin" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_SESSION_HOST=orca MEGABRAIN_SESSION_ID=parent ORCA_TERMINAL_HANDLE=parent \
    FAKE_FRAME="$work/pane" $implementation "$executable" orchestrate "$verb" "$@"
}

mkdir -p "$work/home" "$work/bin"
cat >"$work/bin/orca" <<'EOF'
#!/bin/sh
printf '%s\n' '{"ok":true,"result":{"text":"host terminal output"}}'
EOF
chmod +x "$work/bin/orca"

host_shell="$work/host-shell"; host_binary="$work/host-binary"
write_host_fixture "$host_shell"; write_host_fixture "$host_binary"
shell_output="$(run_side shell read "$host_shell" "$root/megabrain" host-read --json)"
if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled read/liveness binary is missing at %s; run bun run build\n' "$root/.build/megabrain"
  exit 0
fi
binary_output="$(run_side binary read "$host_binary" "$root/.build/megabrain" host-read --json)"
[ "$shell_output" = "$binary_output" ] || fail 'host read differs between shell and binary'
printf 'host read agrees between shell and binary\n'

cat >"$work/bin/tmux" <<'EOF'
#!/bin/sh
case "$1" in
  has-session) exit 0 ;;
  list-panes) printf '%%1\n' ;;
  display-message)
    case "$*" in *pane_pid*) printf '99999\n' ;; *session_name*) printf 'session\n' ;; esac ;;
    ;;
  capture-pane) cat "$FAKE_FRAME" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$work/bin/tmux"

for frame in working idle usage-limit transport-error unknown; do
  state="$work/$frame"; write_tmux_fixture "$state" "$frame"
  shell_output="$(run_side shell liveness "$state" "$root/megabrain" live --json 2>&1)"; shell_status=$?
  binary_output="$(run_side binary liveness "$state" "$root/.build/megabrain" live --json 2>&1)"; binary_status=$?
  [ "$shell_status" -eq "$binary_status" ] || fail "liveness status differs for $frame"
  [ "$shell_output" = "$binary_output" ] || fail "liveness output differs for $frame"
done
printf 'tmux liveness agrees for five frame classes\n'

set +e
missing_shell="$(run_side shell read "$work/missing" "$root/megabrain" missing --json 2>&1)"; missing_shell_status=$?
missing_binary="$(run_side binary read "$work/missing" "$root/.build/megabrain" missing --json 2>&1)"; missing_binary_status=$?
set -e
[ "$missing_shell_status" -eq "$missing_binary_status" ] || fail 'missing dispatch status differs'
[ "$missing_shell" = "$missing_binary" ] || fail 'missing dispatch output differs'
printf 'missing dispatch agrees between shell and binary\n'
