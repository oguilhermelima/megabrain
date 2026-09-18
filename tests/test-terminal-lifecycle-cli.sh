#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-terminal-lifecycle.XXXXXX")"
binary="$root/.build/megabrain"
trap 'rm -rf "$work"' EXIT

[ -x "$binary" ] || { printf 'skip: compiled terminal binary is missing; run bun run build\n'; exit 0; }

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
mkdir -p "$work/bin" "$work/state/terminals" "$work/worktree"
git -C "$work/worktree" init -q
git -C "$work/worktree" config user.email test@example.invalid
git -C "$work/worktree" config user.name test
printf base >"$work/worktree/base"
git -C "$work/worktree" add base
git -C "$work/worktree" commit -qm base

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
  terminals:close) printf '{"terminalId":"old-terminal","status":"disposed"}\n' ;;
  *) exit 1 ;;
esac
EOF
cat >"$work/bin/kill" <<'EOF'
#!/usr/bin/env bash
printf 'kill\t%s\t%s\n' "$1" "$2" >>"$MEGABRAIN_CALL_LOG"
EOF
cat >"$work/bin/ps" <<'EOF'
#!/usr/bin/env bash
printf '1\n'
EOF
cat >"$work/bin/pgrep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$work/bin/lsof" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$work/bin/"*

export MEGABRAIN_STATE_DIR="$work/state"
export MEGABRAIN_ROOT="$root"
export SUPERSET_WORKSPACE_ID=workspace
export SUPERSET_TERMINAL_ID=parent
export MEGABRAIN_SESSION_ID=parent
export MEGABRAIN_SESSION_HOST=superset
export MEGABRAIN_TEST_WORKTREE="$(cd "$work/worktree" && pwd -P)"
export MEGABRAIN_CALL_LOG="$work/calls"
export PATH="$work/bin:/usr/bin:/bin"

reset_record() {
  rm -f "$work/state/terminals/"*.json
  cat >"$work/state/terminals/old-terminal.json" <<EOF
{"terminalId":"old-terminal","host":"superset","workspaceId":"workspace","worktree":"$MEGABRAIN_TEST_WORKTREE","title":"DEV old","command":"run old","createdAt":"now","pid":123,"rootPid":123,"port":4000,"status":"active"}
EOF
  : >"$MEGABRAIN_CALL_LOG"
}

reset_unowned_record() {
  reset_record
  jq '.pid = null | .rootPid = null' "$work/state/terminals/old-terminal.json" >"$work/state/terminals/unowned.json"
  rm "$work/state/terminals/old-terminal.json"
}

run_shell() {
  local status=0
  MEGABRAIN_TERMINAL_CREATE_IMPLEMENTATION=shell MEGABRAIN_TERMINAL_RESTART_IMPLEMENTATION=shell MEGABRAIN_TERMINAL_CLOSE_IMPLEMENTATION=shell "$root/megabrain" "$@" >"$work/shell.stdout" 2>"$work/shell.stderr" || status=$?
  printf '%s\n' "$status"
}

run_binary() {
  local status=0
  "$binary" "$@" >"$work/binary.stdout" 2>"$work/binary.stderr" || status=$?
  printf '%s\n' "$status"
}

compare() {
  local operation="$1" selector="$2" shell_status binary_status
  local -a options=(--json)
  [ "$operation" = restart ] && options+=(--timeout 0)
  if [ "$operation" = restart ]; then reset_unowned_record; else reset_record; fi
  shell_status="$(run_shell terminal "$operation" "$selector" "${options[@]}")"
  if [ "$operation" = restart ]; then reset_unowned_record; else reset_record; fi
  binary_status="$(run_binary terminal "$operation" "$selector" "${options[@]}")"
  if ! cmp -s "$work/shell.stdout" "$work/binary.stdout" || ! cmp -s "$work/shell.stderr" "$work/binary.stderr" || [ "$shell_status" != "$binary_status" ]; then
    printf 'RED %s %s\n' "$operation" "$selector"
    printf 'shell status=%s stdout=%s stderr=%s\n' "$shell_status" "$(<"$work/shell.stdout")" "$(<"$work/shell.stderr")"
    printf 'binary status=%s stdout=%s stderr=%s\n' "$binary_status" "$(<"$work/binary.stdout")" "$(<"$work/binary.stderr")"
    return 1
  fi
}

compare_help() {
  local operation="$1" shell_status binary_status
  shell_status="$(run_shell terminal "$operation" --help)"
  binary_status="$(run_binary terminal "$operation" --help)"
  if ! cmp -s "$work/shell.stdout" "$work/binary.stdout" || ! cmp -s "$work/shell.stderr" "$work/binary.stderr" || [ "$shell_status" != "$binary_status" ]; then
    printf 'RED %s --help\n' "$operation"
    printf 'shell status=%s stdout=%s stderr=%s\n' "$shell_status" "$(<"$work/shell.stdout")" "$(<"$work/shell.stderr")"
    printf 'binary status=%s stdout=%s stderr=%s\n' "$binary_status" "$(<"$work/binary.stdout")" "$(<"$work/binary.stderr")"
    return 1
  fi
  printf 'GREEN %s --help\n' "$operation"
}

failures=0
for operation in create close restart; do
  compare_help "$operation" || failures=$((failures + 1))
done

for selector in id:old-terminal 'title:DEV old' port:4000 "worktree:$MEGABRAIN_TEST_WORKTREE"; do
  compare close "$selector" || failures=$((failures + 1))
  compare restart "$selector" || failures=$((failures + 1))
done

for selector in id:missing id:megabrain-created; do
  compare close "$selector" || failures=$((failures + 1))
  compare restart "$selector" || failures=$((failures + 1))
done

[ "$failures" -eq 0 ] || fail "$failures contract comparisons differed"
printf 'ok: terminal lifecycle contract matches shell and binary\n'
