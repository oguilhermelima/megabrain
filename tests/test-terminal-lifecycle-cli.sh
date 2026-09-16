#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-terminal-lifecycle.XXXXXX")"
trap 'rm -rf "$work"' EXIT

[ -x "$root/.build/megabrain" ] || { printf 'skip: compiled terminal binary is missing; run bun run build\n'; exit 0; }

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

cat >"$work/state/terminals/old-terminal.json" <<EOF
{"terminalId":"old-terminal","host":"superset","workspaceId":"workspace","worktree":"$work/worktree","title":"DEV old","command":"run old","createdAt":"now","pid":123,"rootPid":123,"port":4000,"status":"active"}
EOF

export MEGABRAIN_CALL_LOG="$work/calls"
export MEGABRAIN_STATE_DIR="$work/state"
export MEGABRAIN_ROOT="$root"
export SUPERSET_WORKSPACE_ID=workspace
export SUPERSET_TERMINAL_ID=parent
export MEGABRAIN_SESSION_ID=parent
export MEGABRAIN_SESSION_HOST=superset
export MEGABRAIN_TEST_WORKTREE="$(cd "$work/worktree" && pwd -P)"
export PATH="$work/bin:/usr/bin:/bin"
: >"$MEGABRAIN_CALL_LOG"

MEGABRAIN_TERMINAL_CREATE_IMPLEMENTATION=shell "$root/megabrain" terminal create --worktree "$work/worktree" --command 'run new' --title 'DEV new' --json >/dev/null
binary_create="$($root/.build/megabrain terminal create --worktree "$work/worktree" --command 'run new' --title 'DEV new' --json)"
printf '%s' "$binary_create" | jq -e '.terminalId == "new-terminal"' >/dev/null || fail 'binary create did not return host identity'
tab="$(printf '\t')"
grep -F "superset${tab}terminals${tab}create${tab}--workspace${tab}workspace${tab}--command" "$MEGABRAIN_CALL_LOG" >/dev/null || fail 'create host invocation was not recorded'

cat >"$work/state/terminals/restart-terminal.json" <<EOF
{"terminalId":"restart-terminal","host":"superset","workspaceId":"workspace","worktree":"$work/worktree","title":"DEV restart","command":"run restart","createdAt":"now","pid":123,"rootPid":123,"port":4000,"status":"active"}
EOF
binary_restart="$($root/.build/megabrain terminal restart id:restart-terminal --timeout 0 --json)"
printf '%s' "$binary_restart" | jq -e '.recreated == true' >/dev/null || fail 'binary restart did not recreate terminal'
grep -F 'kill'"$(printf '\t')"'-TERM' "$MEGABRAIN_CALL_LOG" >/dev/null || fail 'restart kill invocation was not recorded'

MEGABRAIN_TERMINAL_CLOSE_IMPLEMENTATION=shell "$root/megabrain" terminal close id:old-terminal --json >/dev/null || true
cat >"$work/state/terminals/old-terminal.json" <<EOF
{"terminalId":"old-terminal","host":"superset","workspaceId":"workspace","worktree":"$work/worktree","title":"DEV old","command":"run old","createdAt":"now","pid":123,"rootPid":123,"port":4000,"status":"active"}
EOF
binary_close="$($root/.build/megabrain terminal close id:old-terminal --json 2>&1 || true)"
printf '%s' "$binary_close" | jq -e '.status == "closed"' >/dev/null || fail 'binary close did not close managed terminal'
tab="$(printf '\t')"
grep -F "superset${tab}terminals${tab}close${tab}--workspace${tab}workspace${tab}--terminal${tab}old-terminal${tab}--json" "$MEGABRAIN_CALL_LOG" >/dev/null || fail 'close host invocation was not recorded'

printf 'ok: terminal lifecycle host effects were recorded\n'
