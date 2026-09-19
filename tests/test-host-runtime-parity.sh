#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-host-runtime.XXXXXX")"

cleanup() {
  local rc=$?
  rm -rf "$state_dir"
  return "$rc"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equal() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_file() {
  [ -e "$1" ] || fail "expected path to exist: $1"
}

assert_missing() {
  [ ! -e "$1" ] || fail "expected path to be absent: $1"
}

export MEGABRAIN_STATE_DIR="$state_dir"
export MEGABRAIN_ROOT="$root"
export MEGABRAIN_ORCHESTRATE_READ_IMPLEMENTATION=shell
export SUPERSET_TERMINAL_ID=parent-terminal
unset TMUX TMUX_PANE ORCA_TERMINAL_HANDLE

source "$root/lib/common.sh"
source "$root/lib/module-tmux-runtime.sh"
source "$root/lib/module-context.sh"
source "$root/lib/module-orchestrate.sh"
source "$root/lib/module-worktree.sh"

# The host command responses are mocked below; keep this fixture runnable in the
# container where the real Orca and Superset CLIs are intentionally absent.
megabrain_require_command() {
  return 0
}

megabrain_superset_available() {
  return 0
}

megabrain_dispatch_require_parent() {
  megabrain_dispatch_meta_read "$1"
}

close_log="$state_dir/close.log"
orca_title_log="$state_dir/orca-title.log"
superset_terminals='{"sessions":[]}'
orca_terminals='{"result":{"terminals":[]}}'
host_close_mode=success
megabrain_superset() {
  if [ "${1:-}" = terminals ] && [ "${2:-}" = list ]; then
    printf '%s\n' "$superset_terminals"
    return 0
  fi
  if [ "${1:-}" = terminals ] && [ "${2:-}" = read ]; then
    printf '%s\n' '{"output":"superset host output"}'
    return 0
  fi
  if [ "${1:-}" = terminals ] && [ "${2:-}" = close ]; then
    printf 'superset:%s\n' "${6:-}" >>"$close_log"
    if [ "$host_close_mode" = failure ]; then
      printf '%s\n' '{"error":{"message":"host close denied"}}'
      return 1
    fi
    printf '%s\n' '{"ok":true}'
    return 0
  fi
  return 1
}

orca() {
  if [ "${1:-}" = terminal ] && [ "${2:-}" = list ]; then
    printf '%s\n' "$orca_terminals"
    return 0
  fi
  if [ "${1:-}" = terminal ] && [ "${2:-}" = create ]; then
    local title=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --title ]; then
        title="${2:-}"
        shift 2
      else
        shift
      fi
    done
    printf '%s\n' "$title" >"$orca_title_log"
    printf '%s\n' '{"result":{"terminal":{"handle":"orca-launch-terminal"}}}'
    return 0
  fi
  if [ "${1:-}" = terminal ] && [ "${2:-}" = read ]; then
    printf '%s\n' '{"text":"orca host output"}'
    return 0
  fi
  if [ "${1:-}" = terminal ] && [ "${2:-}" = send ]; then
    printf '%s\n' '{"ok":true}'
    return 0
  fi
  if [ "${1:-}" = terminal ] && [ "${2:-}" = wait ]; then
    return 0
  fi
  if [ "${1:-}" = terminal ] && [ "${2:-}" = close ]; then
    printf 'orca:%s\n' "${4:-}" >>"$close_log"
    printf '%s\n' '{"ok":true}'
    return 0
  fi
  return 1
}

create_host_dispatch() {
  local dispatch_id="$1" host="${2:-superset}" state="${3:-running}" terminal_id="${4:-$1-terminal}"
  megabrain_dispatch_meta_write "$dispatch_id" parent-terminal "$host" "$host" workspace-test "$terminal_id" \
    "$root" main codex label "$state" gpt-5 true codex '' '' host ide >/dev/null
}

superset_terminals='{"sessions":[{"terminalId":"superset-release-terminal","title":"renamed tab"}]}'
create_host_dispatch host-release superset running superset-release-terminal
megabrain_dispatch_meta_update_process_state host-release succeeded
megabrain_dispatch_meta_update_state host-release done
assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/host-release/meta.json")" released
assert_equal "$(jq -r '.processState' "$state_dir/dispatches/host-release/meta.json")" succeeded
assert_equal "$(cat "$close_log")" 'superset:superset-release-terminal'
printf 'Superset proves and closes a terminal by sessions.terminalId\n'

orca_terminals='{"result":{"terminals":[{"handle":"orca-renamed-terminal","title":"renamed tab"}]}}'
create_host_dispatch host-orca orca running orca-renamed-terminal
megabrain_dispatch_meta_update_process_state host-orca succeeded
megabrain_dispatch_meta_update_state host-orca done
assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/host-orca/meta.json")" released
assert_equal "$(tail -n 1 "$close_log")" 'orca:orca-renamed-terminal'
printf 'Orca proves and closes a terminal by terminals.handle\n'
printf 'renaming a host terminal does not affect identity proof\n'

superset_terminals='{"sessions":[{"terminalId":"host-read-terminal","title":"host read"}]}'
create_host_dispatch host-read superset running host-read-terminal
host_read_result="$(command_orchestrate read host-read --json)"
assert_equal "$(printf '%s' "$host_read_result" | jq -r '.source')" host
assert_equal "$(printf '%s' "$host_read_result" | jq -r '.text')" 'superset host output'
printf 'host read returns output from the Superset terminal\n'

orca_terminals='{"result":{"terminals":[{"handle":"host-read-terminal","title":"host read"}]}}'
jq '.childHost = "orca"' "$state_dir/dispatches/host-read/meta.json" >"$state_dir/orca-meta.json"
mv -f "$state_dir/orca-meta.json" "$state_dir/dispatches/host-read/meta.json"
orca_read_result="$(command_orchestrate read host-read --json)"
assert_equal "$(printf '%s' "$orca_read_result" | jq -r '.source')" host
assert_equal "$(printf '%s' "$orca_read_result" | jq -r '.text')" 'orca host output'
printf 'host read returns output from the Orca terminal\n'

superset_terminals='{"sessions":[{"terminalId":"different-terminal","title":"host-unproven"}]}'
create_host_dispatch host-unproven superset running absent-terminal
megabrain_dispatch_meta_update_process_state host-unproven succeeded
megabrain_dispatch_meta_update_state host-unproven done
assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/host-unproven/meta.json")" retained
assert_equal "$(jq -r '.terminalReason' "$state_dir/dispatches/host-unproven/meta.json")" 'host terminal identity is unproven; process was not released'
printf 'unproven host terminal is retained with a release reason\n'

create_host_dispatch host-no-terminal-id superset running ''
megabrain_dispatch_meta_update_process_state host-no-terminal-id succeeded
megabrain_dispatch_meta_update_state host-no-terminal-id done
assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/host-no-terminal-id/meta.json")" retained
assert_equal "$(jq -r '.terminalReason' "$state_dir/dispatches/host-no-terminal-id/meta.json")" 'host terminal identity is unproven; process was not released'
assert_equal "$(tail -n 1 "$close_log")" 'orca:orca-renamed-terminal'
printf 'a dispatch without terminalId is retained without release\n'

create_host_dispatch host-missing-identity-helper superset running absent-terminal
megabrain_dispatch_meta_update_process_state host-missing-identity-helper succeeded
unset -f megabrain_dispatch_terminal_status
megabrain_dispatch_meta_update_state host-missing-identity-helper done
assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/host-missing-identity-helper/meta.json")" retained
assert_equal "$(jq -r '.terminalReason' "$state_dir/dispatches/host-missing-identity-helper/meta.json")" \
  'terminal identity check unavailable; process was not released'
assert_equal "$(tail -n 1 "$close_log")" 'orca:orca-renamed-terminal'
printf 'missing identity helper retains the terminal without release\n'

source "$root/lib/module-context.sh"
host_close_mode=failure
superset_terminals='{"sessions":[{"terminalId":"superset-release-failure","title":"release failure"}]}'
create_host_dispatch host-release-failure superset running superset-release-failure
megabrain_dispatch_meta_update_process_state host-release-failure succeeded
if megabrain_dispatch_meta_update_state host-release-failure done; then
  release_transition_status=0
else
  release_transition_status=$?
fi
assert_equal "$release_transition_status" 0
assert_equal "$(jq -r '.state' "$state_dir/dispatches/host-release-failure/meta.json")" done
assert_equal "$(jq -r '.terminalState' "$state_dir/dispatches/host-release-failure/meta.json")" retained
assert_equal "$(jq -r '.terminalReason' "$state_dir/dispatches/host-release-failure/meta.json")" 'host close denied'
printf 'release failure does not reject a completed dispatch\n'
host_close_mode=success

old='2020-01-01T00:00:00Z'
jq --arg old "$old" '.createdAt = $old | .updatedAt = $old' \
  "$state_dir/dispatches/host-unproven/meta.json" >"$state_dir/old-meta.json"
mv -f "$state_dir/old-meta.json" "$state_dir/dispatches/host-unproven/meta.json"
prune_result="$(command_orchestrate prune --json)"
assert_equal "$(printf '%s' "$prune_result" | jq -r '.archived')" 0
assert_equal "$(printf '%s' "$prune_result" | jq -r '.skippedDispatches[] | select(.dispatchId == "host-unproven") | .reason')" 'terminal identity is unproven'
assert_file "$state_dir/dispatches/host-unproven/meta.json"
printf 'prune keeps a host dispatch whose terminal identity is unproven\n'

megabrain_context_detect() {
  printf 'orca\n'
}
megabrain_session_id() {
  MEGABRAIN_SESSION_ID=parent-session
  MEGABRAIN_SESSION_HOST=orca
}
megabrain_workspace_id_for_target() {
  printf 'workspace-test\n'
}
megabrain_resolve_spawn_runtime() {
  MEGABRAIN_SPAWN_RUNTIME=host
  MEGABRAIN_SPAWN_CONTEXT=orca
}
megabrain_dispatch_preamble() {
  printf 'test preamble\n'
}
megabrain_agent_command() {
  printf 'true\n'
}
megabrain_dispatch_send_prompt_with_receipt() {
  return 0
}
orca_terminals='{"result":{"terminals":[{"handle":"orca-launch-terminal","title":"renamed by host"}]}}'
megabrain_launch_agent "$root" workspace-test codex gpt-5 low title-check label false >/dev/null
assert_equal "$(cat "$orca_title_log")" "codex $root"
printf 'Orca host launch title does not carry dispatch identity\n'

printf 'ok: host runtime release, read, and prune parity\n'
