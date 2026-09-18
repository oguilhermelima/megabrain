#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-terminal-lifecycle.XXXXXX")"
binary="$root/.build/megabrain"
trap 'rm -rf "$work"' EXIT

[ -x "$binary" ] || { printf 'skip: compiled terminal binary is missing; run bun run build\n'; exit 0; }

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected '$1' to contain '$2'" ;; esac; }
assert_json() { printf '%s' "$1" | jq -e "$2" >/dev/null || fail "JSON assertion failed: $2\n$1"; }

mkdir -p "$work/bin" "$work/state/terminals" "$work/worktree/.superset"
git -C "$work/worktree" init -q
git -C "$work/worktree" config user.email test@example.invalid
git -C "$work/worktree" config user.name test
printf base >"$work/worktree/base"
git -C "$work/worktree" add base
git -C "$work/worktree" commit -qm base
printf '%s\n' '{"run":["pnpm dev","pnpm test"]}' >"$work/worktree/.superset/config.json"

cat >"$work/bin/superset" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'superset' >>"$MEGABRAIN_CALL_LOG"
for arg in "$@"; do printf '\t%s' "$arg" >>"$MEGABRAIN_CALL_LOG"; done
printf '\n' >>"$MEGABRAIN_CALL_LOG"
case "${1:-}:${2:-}" in
  terminals:create) printf '{"terminalId":"new-terminal","pid":123,"rootPid":123,"port":4000}\n' ;;
  workspaces:list) printf '{"workspaces":[{"id":"workspace","worktreePath":"%s"}]}\n' "$MEGABRAIN_TEST_WORKTREE" ;;
  terminals:list) printf '{"terminals":[{"terminalId":"old-terminal","pid":123,"rootPid":123,"port":4000,"status":"active"}]}\n' ;;
  terminals:close)
    if [ "${MEGABRAIN_TEST_CLOSE_FAILURE:-false}" = true ]; then exit 1; fi
    printf '{"terminalId":"old-terminal","status":"disposed"}\n' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$work/bin/superset"
cat >"$work/bin/lsof" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$work/bin/pgrep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$work/bin/kill" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$work/bin/"{lsof,pgrep,kill}

export MEGABRAIN_STATE_DIR="$work/state"
export SUPERSET_WORKSPACE_ID=workspace
export SUPERSET_TERMINAL_ID=parent
export MEGABRAIN_TEST_WORKTREE="$(cd "$work/worktree" && pwd -P)"
export MEGABRAIN_CALL_LOG="$work/calls"
export PATH="$work/bin:/usr/bin:/bin"

run_binary() {
  local status=0
  "$binary" "$@" >"$work/stdout" 2>"$work/stderr" || status=$?
  printf '%s\n' "$status"
}

write_record() {
  local id="$1" pid="${2:-123}" root_pid="${3:-123}"
  rm -f "$work/state/terminals/"*.json
  cat >"$work/state/terminals/$id.json" <<EOF
{"terminalId":"$id","host":"superset","workspaceId":"workspace","worktree":"$MEGABRAIN_TEST_WORKTREE","title":"DEV old","command":"run old","createdAt":"now","pid":$pid,"rootPid":$root_pid,"port":4000,"status":"active"}
EOF
  : >"$MEGABRAIN_CALL_LOG"
}

scenario_route_reaches_binary() {
  local fixture="$work/routing-fixture" status operation
  make_entrypoint_routing_fixture "$root" "$fixture" 97
  for operation in create restart close; do
    set +e
    case "$operation" in
      create) env MEGABRAIN_STATE_DIR="$work/route-$operation" "$fixture/megabrain" terminal create --command run >"$work/route-$operation.out" 2>&1 ;;
      *) env MEGABRAIN_STATE_DIR="$work/route-$operation" "$fixture/megabrain" terminal "$operation" id:terminal >"$work/route-$operation.out" 2>&1 ;;
    esac
    status=$?
    set -e
    assert_equal "$status" 97
    printf '%s route marker: %s\n' "$operation" "$status"
  done
}

scenario_create_content() {
  local status output record
  status="$(run_binary terminal create --worktree "$MEGABRAIN_TEST_WORKTREE" --json)"
  assert_equal "$status" 0
  output="$(cat "$work/stdout")"
  assert_json "$output" '.terminalId == "new-terminal" and .worktree == env.MEGABRAIN_TEST_WORKTREE and .port == 4000'
  record="$work/state/terminals/new-terminal.json"
  assert_json "$(cat "$record")" '.command == "pnpm dev && pnpm test" and .workspaceId == "workspace"'
  printf 'create derives the run script and persists content\n'

  rm "$work/worktree/.superset/config.json"
  status="$(run_binary terminal create --worktree "$MEGABRAIN_TEST_WORKTREE")"
  assert_equal "$status" 2
  assert_equal "$(cat "$work/stderr")" "megabrain: no --command given and no .superset/config.json run script found in $MEGABRAIN_TEST_WORKTREE"
  printf 'create refuses missing command and run script with shell parity\n'
  printf '%s\n' '{"run":["pnpm dev","pnpm test"]}' >"$work/worktree/.superset/config.json"
}

scenario_restart_content() {
  local status output
  write_record old-terminal
  status="$(run_binary terminal restart id:old-terminal --timeout 0 --json)"
  assert_equal "$status" 0
  output="$(cat "$work/stdout")"
  assert_json "$output" '.selector == "id:old-terminal" and .killedPid == 123 and .recreated == true and .recreatedTerminalId == "new-terminal" and .port == 4000'
  assert_contains "$(cat "$MEGABRAIN_CALL_LOG")" 'terminals'
  printf 'restart kills the recorded root and recreates the terminal\n'
}

scenario_close_content() {
  local status output
  write_record old-terminal
  status="$(run_binary terminal close id:old-terminal --json)"
  assert_equal "$status" 0
  output="$(cat "$work/stdout")"
  assert_json "$output" '.status == "closed" and .terminalId == "old-terminal" and .recordRemoved == true and .identity == "recorded"'
  [ ! -f "$work/state/terminals/old-terminal.json" ] || fail 'close did not remove the live record'
  printf 'close verifies host identity and removes the live record\n'

  write_record stale-terminal
  status="$(run_binary terminal close id:stale-terminal --json)"
  assert_equal "$status" 1
  output="$(cat "$work/stdout")"
  assert_json "$output" '.status == "stale" and .recordRemoved == true and .terminalId == "stale-terminal"'
  [ ! -f "$work/state/terminals/stale-terminal.json" ] || fail 'close did not remove the stale record'
  printf 'close removes stale records without calling the host\n'

  write_record old-terminal
  status="$(MEGABRAIN_TEST_CLOSE_FAILURE=true run_binary terminal close id:old-terminal --json)"
  assert_equal "$status" 1
  assert_contains "$(cat "$work/stderr")" 'record retained'
  [ -f "$work/state/terminals/old-terminal.json" ] || fail 'close did not retain the record after host failure'
  printf 'close retains records when the host close fails\n'
}

source "$root/tests/fixtures/entrypoint-routing.sh"
scenario_route_reaches_binary
scenario_create_content
scenario_restart_content
scenario_close_content
printf 'ok: terminal lifecycle routing and content contracts\n'
