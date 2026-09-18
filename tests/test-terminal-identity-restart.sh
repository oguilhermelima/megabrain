#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
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

source "$root/lib/common.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-worktree.sh"

megabrain_superset_available() { return 0; }
megabrain_workspace_id_for_target() { printf 'workspace-test\n'; }
megabrain_terminal_identity_token() { printf 'test-token\n'; }

megabrain_superset() {
  case "${1:-}:${2:-}" in
    terminals:create)
      printf '%s' "${6:-}" >"$fake_create_command_file"
      # Recreate the listener synchronously; restart must observe a bound port,
      # not race a process that may bind later.
      if [ "$(cat "$fake_port_state")" = free ] && [ "$fake_port_stuck" = false ] && [ "$fake_port_recreate_listens" = true ]; then
        fake_port_bind
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
        printf '{"output":"MEGABRAIN_TERMINAL_PID_test-token=%s"}\n' "$fake_pid"
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
      fake_host_live=false
      printf '{"terminalId":"%s","status":"disposed"}\n' "$fake_id"
      ;;
    *) return 1 ;;
  esac
}

# The process commands are fake fixtures. The child is the listener and the parent is
# the process megabrain recorded when it created the terminal. A naive listener-only kill
# makes the child respawn; killing the recorded root removes the old tree.
lsof() {
  if [ "$(cat "$fake_port_state")" = listening ]; then
    if [ "$(cat "$fake_port_recreated_file")" = yes ]; then
      printf 'yes\n' >"$fake_port_wait_observed_file"
    fi
    printf '101\n'
  fi
}

ps() {
  if [ "${1:-}" = -o ] && [ "${2:-}" = ppid= ]; then
    case "${4:-}" in
      100) printf '1\n' ;;
      101) printf '100\n' ;;
      *) printf '1\n' ;;
    esac
  fi
}

pgrep() {
  if [ "${1:-}" = -P ]; then
    case "${2:-}" in
      100) printf '101\n' ;;
      *) ;;
    esac
  fi
}

kill() {
  local signal pid
  signal="$1"
  pid="$2"
  fake_killed="$fake_killed $pid"
  if [ "$pid" = 100 ]; then
    printf 'gone\n' >"$fake_tree_state"
    if [ "$fake_port_stuck" = false ]; then
      fake_port_set_listening free
    fi
  elif [ "$pid" = 101 ] && [ "$(cat "$fake_tree_state")" = alive ]; then
    fail 'listener-only kill respawned the old process tree'
  fi
  return 0
}

scenario_create_json_preserves_identity() {
  local output record dispatch_id
  fake_id=terminal-create
  fake_pid=100
  fake_port=8082
  output="$(command_terminal create --worktree "$root" --command 'run server' --title "$fake_title" --json)"
  assert_json_true "$output" '.terminalId == "terminal-create" and .pid == 100 and .port == 8082'
  record="$MEGABRAIN_TERMINAL_DIR/terminal-create.json"
  [ -f "$record" ] || fail 'create did not persist a terminal record'
  dispatch_id=identity-dispatch
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal superset superset workspace-test \
    "$(jq -r '.terminalId' <<<"$output")" "$root" main codex label running gpt-5 true codex '' '' host ide >/dev/null
  assert_equal "$(jq -r '.terminalId' "$MEGABRAIN_DISPATCH_DIR/$dispatch_id/meta.json")" terminal-create
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
  output="$(command_terminal restart id:terminal-create --timeout 0 --json)"
  assert_json_true "$output" '.selector == "id:terminal-create" and .killedPid == 100 and .recreated == true'

  fake_id=terminal-title
  fake_pid=100
  fake_port=8083
  fake_title='DEV title'
  command_terminal create --worktree "$root" --command 'run title' --title "$fake_title" --json >/dev/null
  fake_port_set_listening listening
  output="$(command_terminal restart "title:$fake_title" --timeout 0 --json)"
  assert_json_true "$output" '.selector == "title:DEV title" and .recreated == true'

  fake_id=terminal-port
  fake_pid=100
  fake_port=8084
  command_terminal create --worktree "$root" --command 'run port' --title 'DEV port' --json >/dev/null
  fake_port_set_listening listening
  output="$(command_terminal restart port:8084 --timeout 0 --json)"
  assert_json_true "$output" '.selector == "port:8084" and .recreated == true'

  fake_id=terminal-worktree
  fake_pid=100
  fake_port=8085
  command_terminal create --worktree "$root" --command 'run worktree' --title 'DEV worktree' --json >/dev/null
  fake_port_set_listening listening
  output="$(command_terminal restart "worktree:$root" --timeout 0 --json)"
  assert_equal "$(jq -r '.selector' <<<"$output")" "worktree:$root"
  assert_json_true "$output" '.recreated == true'

  if failure_output="$(command_terminal restart id:missing --timeout 0 2>&1)"; then
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
  command_terminal create --worktree "$root" --command 'run tree' --title 'DEV tree' --json >/dev/null
  fake_port_confirm_listening
  output="$(command_terminal restart id:terminal-tree --wait-port 8090 --timeout 2 --json)"
  assert_json_true "$output" '.recreated == true and .port == 8090'
  [ "$(cat "$fake_port_wait_observed_file")" = yes ] || fail 'restart returned without observing the recreated listener'
  [ "$(cat "$fake_tree_state")" = gone ] || fail 'restart did not kill the recorded process root'

  fake_id=terminal-timeout-listening
  fake_pid=100
  fake_port=8091
  fake_port_stuck=false
  fake_port_recreate_listens=false
  fake_port_set_listening listening
  command_terminal create --worktree "$root" --command 'run timeout' --title 'DEV timeout' --json >/dev/null
  fake_port_confirm_listening
  if failure_output="$(command_terminal restart id:terminal-timeout-listening --wait-port 8091 --timeout 0 2>&1)"; then
    fail 'a listener that never returns unexpectedly succeeded'
  fi
  assert_contains "$failure_output" 'timed out waiting for port 8091 to listen again'

  fake_id=terminal-timeout-free
  fake_pid=100
  fake_port=8092
  fake_port_stuck=true
  fake_port_recreate_listens=true
  fake_port_set_listening listening
  command_terminal create --worktree "$root" --command 'run timeout' --title 'DEV timeout' --json >/dev/null
  if failure_output="$(command_terminal restart id:terminal-timeout-free --timeout 0 2>&1)"; then
    fail 'port-free timeout unexpectedly succeeded'
  fi
  assert_contains "$failure_output" 'timed out waiting for port 8092 to become free'

  fake_port_stuck=false
  fake_port_set_listening free
  if failure_output="$(command_terminal restart port:8092 --timeout 0 2>&1)"; then
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
  output="$(command_terminal create --worktree "$root" --command 'run marker' --title 'DEV marker' --port 8086 --json)"
  assert_json_true "$output" '.terminalId == "terminal-marker" and .pid == 333 and .rootPid == 333 and .port == 8086'
  record="$MEGABRAIN_TERMINAL_DIR/terminal-marker.json"
  assert_equal "$(jq -r '.command' "$record")" 'run marker'
  assert_contains "$(cat "$fake_create_command_file")" 'MEGABRAIN_TERMINAL_PID_test-token='
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
  output="$(command_terminal create --worktree "$root" --command 'run restart' --port 8088 --json)"
  fake_port_set_listening listening
  output="$(command_terminal restart id:terminal-marker-restart --timeout 0 --json)"
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
  command_terminal create --worktree "$root" --command 'run close' --port 8089 --json >/dev/null
  record="$MEGABRAIN_TERMINAL_DIR/terminal-close.json"
  output="$(command_terminal close id:terminal-close --json)"
  assert_json_true "$output" '.status == "closed" and .recordRemoved == true and .identity == "recorded"'
  [ "$(cat "$fake_close_called_file")" = yes ] || fail 'close did not call the host'
  [ ! -f "$record" ] || fail 'close did not remove the terminal record'

  fake_id=terminal-no-identity
  fake_host_live=true
  printf 'no\n' >"$fake_close_called_file"
  megabrain_terminal_record_write terminal-no-identity superset workspace-test "$root" 'DEV no identity' 'run no identity' now null null null
  output="$(command_terminal close id:terminal-no-identity --json)"
  assert_json_true "$output" '.status == "closed" and .recordRemoved == true and .identity == "unavailable"'
  [ "$(cat "$fake_close_called_file")" = yes ] || fail 'close skipped a host terminal without process identity'

  fake_id=terminal-forgotten
  fake_host_live=false
  printf 'no\n' >"$fake_close_called_file"
  megabrain_terminal_record_write terminal-forgotten superset workspace-test "$root" 'DEV forgotten' 'run forgotten' now 337 8090 337
  if failure_output="$(command_terminal close id:terminal-forgotten --json 2>/dev/null)"; then
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
