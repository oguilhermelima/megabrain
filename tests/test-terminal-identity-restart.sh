#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
binary="$root/.build/megabrain"
[ -x "$binary" ] || {
  printf 'skip: compiled binary is missing at %s; run bun run build\n' "$binary"
  exit 0
}
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-terminal.XXXXXX")"
fake_bin="$state_dir/bin"
fake_port_state="$state_dir/fake-port-state"
fake_port_recreated_file="$state_dir/fake-port-recreated"
fake_port_wait_observed_file="$state_dir/fake-port-wait-observed"
fake_tree_state="$state_dir/fake-tree-state"
fake_host_live=true
fake_process_alive=true
fake_create_returns_identity=true
fake_identity_read=true
fake_port_stuck=false
fake_port_recreate_listens=true

export MEGABRAIN_ROOT="$root"
export MEGABRAIN_TEST_WORKTREE="$root"
export fake_bin fake_port_state fake_port_recreated_file fake_port_wait_observed_file fake_tree_state
export fake_create_command_file fake_status_probe_file fake_close_called_file
export fake_host_live fake_process_alive fake_create_returns_identity fake_identity_read fake_port_stuck fake_port_recreate_listens
export fake_id fake_pid fake_port fake_title

printf 'listening\n' >"$fake_port_state"
printf 'no\n' >"$fake_port_recreated_file"
printf 'no\n' >"$fake_port_wait_observed_file"
printf 'alive\n' >"$fake_tree_state"
fake_create_command_file="$state_dir/fake-create-command"
fake_status_probe_file="$state_dir/fake-status-probe"
fake_close_called_file="$state_dir/fake-close-called"
printf 'no\n' >"$fake_status_probe_file"
printf 'no\n' >"$fake_close_called_file"

mkdir -p "$fake_bin"
cat >"$fake_bin/superset" <<'EOF'
#!/usr/bin/env bash
set -eu
case "${1:-}:${2:-}" in
  terminals:create)
    command=''
    previous=''
    for arg in "$@"; do
      if [ "$previous" = --command ]; then command="$arg"; fi
      previous="$arg"
    done
    printf '%s\n' "$command" >"$fake_create_command_file"
    marker="$(printf '%s' "$command" | sed -n 's/.*MEGABRAIN_TERMINAL_PID_\([^=]*\)=.*/\1/p')"
    [ -n "$marker" ] || { printf 'missing terminal identity marker\n' >&2; exit 1; }
    printf '%s\n' "$marker" >"$fake_bin/identity-marker"
    if [ "$(cat "$fake_port_state")" = free ] && [ "$fake_port_stuck" = false ] && [ "$fake_port_recreate_listens" = true ]; then
      printf 'listening\n' >"$fake_port_state"
      printf 'yes\n' >"$fake_port_recreated_file"
    fi
    if [ "$fake_create_returns_identity" = true ]; then
      printf '{"terminalId":"%s","pid":%s,"port":%s}\n' "$fake_id" "$fake_pid" "$fake_port"
    else
      printf '{"terminalId":"%s"}\n' "$fake_id"
    fi
    ;;
  terminals:read)
    if [ "$fake_identity_read" = true ]; then
      printf '{"output":"MEGABRAIN_TERMINAL_PID_%s=%s"}\n' "$(cat "$fake_bin/identity-marker")" "$fake_pid"
    else
      printf '{"output":"terminal started"}\n'
    fi
    ;;
  terminals:list)
    printf 'yes\n' >"$fake_status_probe_file"
    if [ "$fake_host_live" = true ]; then
      if [ "$fake_process_alive" = true ]; then
        printf '{"terminals":[{"terminalId":"%s","pid":%s,"port":%s,"exited":false}]}\n' "$fake_id" "$fake_pid" "$fake_port"
      else
        printf '{"terminals":[{"terminalId":"%s","pid":%s,"port":%s,"exited":true}]}\n' "$fake_id" "$fake_pid" "$fake_port"
      fi
    else
      printf '{"terminals":[]}\n'
    fi
    ;;
  terminals:close)
    printf 'yes\n' >"$fake_close_called_file"
    printf '{"terminalId":"%s","status":"disposed"}\n' "$fake_id"
    ;;
  workspaces:list)
    printf '{"workspaces":[{"id":"workspace-test","worktreePath":"%s"}]}\n' "$MEGABRAIN_TEST_WORKTREE"
    ;;
  *) exit 1 ;;
esac
EOF
cat >"$fake_bin/lsof" <<'EOF'
#!/usr/bin/env bash
if [ "$(cat "$fake_port_state")" = listening ]; then
  if [ "$(cat "$fake_port_recreated_file")" = yes ]; then printf 'yes\n' >"$fake_port_wait_observed_file"; fi
  printf '101\n'
fi
EOF
cat >"$fake_bin/ps" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -o ] && [ "${2:-}" = ppid= ]; then
  case "${4:-}" in
    100) printf '1\n' ;;
    101) printf '100\n' ;;
    *) printf '1\n' ;;
  esac
fi
EOF
cat >"$fake_bin/pgrep" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -P ] && [ "${2:-}" = 100 ]; then printf '101\n'; fi
EOF
cat >"$fake_bin/kill" <<'EOF'
#!/usr/bin/env bash
pid="${2:-${1:-}}"
if [ "$pid" = 100 ]; then
  printf 'gone\n' >"$fake_tree_state"
  if [ "$fake_port_stuck" = false ]; then printf 'free\n' >"$fake_port_state"; fi
fi
exit 0
EOF
chmod +x "$fake_bin"/*
export PATH="$fake_bin:$PATH"

fake_port_set_listening() {
  printf '%s\n' "$1" >"$fake_port_state"
}
fake_port_bind() {
  fake_port_set_listening listening
}
fake_port_confirm_listening() {
  [ "$(cat "$fake_port_state")" = listening ] || fail 'fixture port did not bind before restart'
}
fake_id=terminal-one
fake_pid=100
fake_port=8082
fake_title='DEV web'
fake_killed=''
fake_old_tree_gone=false

cleanup() {
  rm -rf "$state_dir"
}
trap cleanup EXIT

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

assert_json_true() {
  printf '%s' "$1" | jq -e "$2" >/dev/null || fail "JSON assertion failed: $2\n$1"
}

export MEGABRAIN_STATE_DIR="$state_dir"
export SUPERSET_TERMINAL_ID=parent-terminal
unset ORCA_TERMINAL_HANDLE TMUX TMUX_PANE

# terminal (lib/module-worktree.sh) is now a full, unconditional binary passthrough for
# create/restart/close (confirmed by reading it: every subcommand execs .build/megabrain and
# returns its exit code, no shell fallback) — so this file drives the binary directly instead of
# sourcing lib/ for a shell wrapper function that would immediately re-exec the same binary.
# Everything the binary subprocess itself observes goes through real executables on PATH
# (fake_bin/superset, fake_bin/lsof, fake_bin/ps, fake_bin/pgrep, fake_bin/kill, written above) —
# a shell *function* named the same cannot be seen by a separate compiled-binary process at all,
# so the second, function-based copies of those same fixtures that used to sit here (for the old
# shell terminal to call) were dead weight even before this rewrite; removed rather than
# kept as unreachable duplicates.

terminal() {
  MEGABRAIN_STATE_DIR="$state_dir" "$binary" terminal "$@"
}

terminal_dir="$state_dir/terminals"
dispatch_dir="$state_dir/dispatches"

# Fixture-only replacement for megabrain_dispatch_meta_write (lib/module-orchestrate.sh),
# which is production-dead (zero callers anywhere in lib/, megabrain, hooks/): writes just enough
# of the real meta.json shape to prove a returned terminalId round-trips into dispatch metadata.
write_dispatch_meta() {
  local id="$1" terminal_id="$2"
  mkdir -p "$dispatch_dir/$id/messages" "$dispatch_dir/$id/deliveries"
  jq -n --arg id "$id" --arg terminalId "$terminal_id" '{dispatchId: $id, terminalId: $terminalId, state: "running"}' \
    >"$dispatch_dir/$id/meta.json"
}

# Fixture-only replacement for megabrain_terminal_record_write (lib/module-worktree.sh), also
# production-dead (zero callers): writes the same terminal-record shape directly.
write_terminal_record() {
  local id="$1" host="$2" pid_json="$3" port_json="$4" root_pid_json="$5"
  mkdir -p "$terminal_dir"
  jq -n --arg terminalId "$id" --arg host "$host" --argjson pid "$pid_json" --argjson port "$port_json" --argjson rootPid "$root_pid_json" \
    '{terminalId: $terminalId, host: $host, workspaceId: "workspace-test", worktree: "'"$root"'", title: null, command: "run", createdAt: "now", pid: $pid, rootPid: $rootPid, port: $port, status: "active"}' \
    >"$terminal_dir/$id.json"
}

scenario_create_json_preserves_identity() {
  local output record dispatch_id
  fake_id=terminal-create
  fake_pid=100
  fake_port=8082
  output="$(terminal create --worktree "$root" --command 'run server' --title "$fake_title" --json)"
  assert_json_true "$output" '.terminalId == "terminal-create" and .pid == 100 and .port == 8082'
  record="$terminal_dir/terminal-create.json"
  [ -f "$record" ] || fail 'create did not persist a terminal record'
  dispatch_id=identity-dispatch
  write_dispatch_meta "$dispatch_id" "$(jq -r '.terminalId' <<<"$output")"
  assert_equal "$(jq -r '.terminalId' "$dispatch_dir/$dispatch_id/meta.json")" terminal-create
  printf 'create --json returns the identity used by dispatch metadata\n'
}

scenario_restart_selectors() {
  local output failure_output
  fake_host_live=true
  fake_port_set_listening listening
  fake_port_stuck=false
  fake_id=terminal-create
  fake_pid=100
  fake_port=8082
  output="$(terminal restart id:terminal-create --timeout 0 --json)"
  assert_json_true "$output" '.selector == "id:terminal-create" and .killedPid == 100 and .recreated == true'

  fake_id=terminal-title
  fake_pid=100
  fake_port=8083
  fake_title='DEV title'
  terminal create --worktree "$root" --command 'run title' --title "$fake_title" --json >/dev/null
  fake_port_set_listening listening
  output="$(terminal restart "title:$fake_title" --timeout 0 --json)"
  assert_json_true "$output" '.selector == "title:DEV title" and .recreated == true'

  fake_id=terminal-port
  fake_pid=100
  fake_port=8084
  terminal create --worktree "$root" --command 'run port' --title 'DEV port' --json >/dev/null
  fake_port_set_listening listening
  output="$(terminal restart port:8084 --timeout 0 --json)"
  assert_json_true "$output" '.selector == "port:8084" and .recreated == true'

  fake_id=terminal-worktree
  fake_pid=100
  fake_port=8085
  terminal create --worktree "$root" --command 'run worktree' --title 'DEV worktree' --json >/dev/null
  fake_port_set_listening listening
  output="$(terminal restart "worktree:$root" --timeout 0 --json)"
  assert_equal "$(jq -r '.selector' <<<"$output")" "worktree:$root"
  assert_json_true "$output" '.recreated == true'

  if failure_output="$(terminal restart id:missing --timeout 0 2>&1)"; then
    fail 'unresolvable selector unexpectedly succeeded'
  fi
  assert_contains "$failure_output" 'terminal selector could not be resolved'
  printf 'restart resolves id, title, port and worktree selectors independently\n'
}

scenario_restart_safety_and_wait() {
  local output failure_output
  fake_id=terminal-tree
  fake_pid=100
  fake_port=8090
  fake_port_set_listening listening
  fake_port_stuck=false
  printf 'alive\n' >"$fake_tree_state"
  fake_port_recreate_listens=true
  printf 'no\n' >"$fake_port_recreated_file"
  printf 'no\n' >"$fake_port_wait_observed_file"
  fake_port_bind
  fake_port_confirm_listening
  terminal create --worktree "$root" --command 'run tree' --title 'DEV tree' --json >/dev/null
  fake_port_confirm_listening
  output="$(terminal restart id:terminal-tree --wait-port 8090 --timeout 2 --json)"
  assert_json_true "$output" '.recreated == true and .port == 8090'
  [ "$(cat "$fake_port_wait_observed_file")" = yes ] || fail 'restart returned without observing the recreated listener'
  [ "$(cat "$fake_tree_state")" = gone ] || fail 'restart did not kill the recorded process root'

  fake_id=terminal-timeout-listening
  fake_pid=100
  fake_port=8091
  fake_port_stuck=false
  fake_port_recreate_listens=false
  fake_port_set_listening listening
  terminal create --worktree "$root" --command 'run timeout' --title 'DEV timeout' --json >/dev/null
  fake_port_confirm_listening
  if failure_output="$(terminal restart id:terminal-timeout-listening --wait-port 8091 --timeout 0 2>&1)"; then
    fail 'a listener that never returns unexpectedly succeeded'
  fi
  assert_contains "$failure_output" 'timed out waiting for port 8091 to listen again'

  fake_id=terminal-timeout-free
  fake_pid=100
  fake_port=8092
  fake_port_stuck=true
  fake_port_recreate_listens=true
  fake_port_set_listening listening
  terminal create --worktree "$root" --command 'run timeout' --title 'DEV timeout' --json >/dev/null
  if failure_output="$(terminal restart id:terminal-timeout-free --timeout 0 2>&1)"; then
    fail 'port-free timeout unexpectedly succeeded'
  fi
  assert_contains "$failure_output" 'timed out waiting for port 8092 to become free'

  fake_port_stuck=false
  fake_port_set_listening free
  if failure_output="$(terminal restart port:8092 --timeout 0 2>&1)"; then
    fail 'a non-listening port unexpectedly resolved'
  fi
  assert_contains "$failure_output" 'port 8092 is not listening'
  printf 'restart kills the recorded root, waits for free ports, and distinguishes timeout\n'
}

scenario_create_marker_identity() {
  local output record
  fake_id=terminal-marker
  fake_pid=333
  fake_port=8086
  fake_host_live=true
  fake_create_returns_identity=false
  fake_identity_read=true
  output="$(terminal create --worktree "$root" --command 'run marker' --title 'DEV marker' --port 8086 --json)"
  assert_json_true "$output" '.terminalId == "terminal-marker" and .pid == 333 and .rootPid == 333 and .port == 8086'
  record="$terminal_dir/terminal-marker.json"
  assert_equal "$(jq -r '.command' "$record")" 'run marker'
  assert_contains "$(cat "$fake_create_command_file")" 'MEGABRAIN_TERMINAL_PID_'
  printf 'create wraps the command and persists its self-reported root identity\n'
}

scenario_restart_marker_identity() {
  local output
  fake_id=terminal-marker-restart
  fake_pid=100
  fake_port=8088
  fake_host_live=true
  fake_process_alive=true
  fake_create_returns_identity=false
  fake_identity_read=true
  fake_port_set_listening listening
  output="$(terminal create --worktree "$root" --command 'run restart' --port 8088 --json)"
  fake_port_set_listening listening
  output="$(terminal restart id:terminal-marker-restart --timeout 0 --json)"
  assert_json_true "$output" '.killedPid == 100 and .recreated == true'
  printf 'restart reaches an identity obtained from the create marker\n'
}

scenario_close_lifecycle() {
  local output record failure_output
  fake_id=terminal-close
  fake_pid=336
  fake_port=8089
  fake_host_live=true
  fake_create_returns_identity=true
  printf 'no\n' >"$fake_close_called_file"
  terminal create --worktree "$root" --command 'run close' --port 8089 --json >/dev/null
  record="$terminal_dir/terminal-close.json"
  output="$(terminal close id:terminal-close --json)"
  assert_json_true "$output" '.status == "closed" and .recordRemoved == true and .identity == "recorded"'
  [ "$(cat "$fake_close_called_file")" = yes ] || fail 'close did not call the host'
  [ ! -f "$record" ] || fail 'close did not remove the terminal record'

  fake_id=terminal-no-identity
  fake_host_live=true
  printf 'no\n' >"$fake_close_called_file"
  write_terminal_record terminal-no-identity superset null null null
  output="$(terminal close id:terminal-no-identity --json)"
  assert_json_true "$output" '.status == "closed" and .recordRemoved == true and .identity == "unavailable"'
  [ "$(cat "$fake_close_called_file")" = yes ] || fail 'close skipped a host terminal without process identity'

  fake_id=terminal-forgotten
  fake_host_live=false
  printf 'no\n' >"$fake_close_called_file"
  write_terminal_record terminal-forgotten superset 337 8090 337
  if failure_output="$(terminal close id:terminal-forgotten --json 2>/dev/null)"; then
    fail 'close claimed success for a terminal forgotten by the host'
  fi
  assert_json_true "$failure_output" '.status == "stale" and .recordRemoved == true'
  [ "$(cat "$fake_close_called_file")" = no ] || fail 'close attempted to close a terminal the host forgot'
  printf 'close reports identity and host-missing outcomes while removing records\n'
}

case "${SCENARIO:-all}" in
  1) scenario_create_json_preserves_identity ;;
  3) scenario_restart_selectors ;;
  4) scenario_restart_safety_and_wait ;;
  5) scenario_create_marker_identity ;;
  7) scenario_restart_marker_identity ;;
  8) scenario_close_lifecycle ;;
  all)
    scenario_create_json_preserves_identity
    scenario_restart_selectors
    scenario_restart_safety_and_wait
    scenario_create_marker_identity
    scenario_restart_marker_identity
    scenario_close_lifecycle
    printf 'ok: terminal identity, selector resolution, safe tree restart, waits and close\n'
    ;;
  *) fail "unknown scenario: $SCENARIO" ;;
esac
