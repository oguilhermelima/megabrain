#!/usr/bin/env bash
set -euo pipefail

if [ "${MEGABRAIN_RUN_CODEX_E2E:-}" != 1 ]; then
  printf 'SKIP: set MEGABRAIN_RUN_CODEX_E2E=1 to run the real Codex mailbox check\n'
  exit 0
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/support/state-dir-guard.bash"
source "$root/tests/support/state-db.bash"
real_home="${HOME:?HOME must be set so Codex can use existing credentials}"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-codex-mailbox.XXXXXX")"
state="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-codex-state.XXXXXX")"
server="mb-codex-mail-$RANDOM-$$"
real_tmux="$(command -v tmux || true)"
real_codex="$(command -v codex || true)"
real_git="$(command -v git)"

cleanup() {
  tmux -L "$server" kill-server >/dev/null 2>&1 || true
  remove_test_dir "$state"
  remove_test_dir "$work"
}
trap cleanup EXIT

if [ -z "$real_tmux" ] || [ -z "$real_codex" ]; then
  printf 'SKIP: this check requires both tmux and codex\n'
  exit 0
fi
[ -x "$root/.build/megabrain" ] || { printf 'FAIL: compiled megabrain missing; run bun run build\n' >&2; exit 1; }
export HOME="$real_home" MEGABRAIN_STATE_DIR="$state"
require_megabrain_test_state "$state"

for name in $(compgen -e); do
  case "$name" in MEGABRAIN_*|ORCA_*|TMUX*) unset "$name" ;; esac
done
export HOME="$real_home" MEGABRAIN_STATE_DIR="$state"

mkdir -p "$work/repo" "$work/legacy/dispatches/codex-mailbox" "$work/bin"
cd "$work/repo"
"$real_git" init -q
"$real_git" config user.name 'Megabrain E2E'
"$real_git" config user.email 'megabrain-e2e@example.invalid'
printf 'temporary fixture\n' >README.md
"$real_git" add README.md
"$real_git" commit -qm 'test fixture'

cat >"$work/bin/tmux" <<EOF
#!/bin/sh
exec "$real_tmux" -L "$server" "\$@"
EOF
chmod +x "$work/bin/tmux"
export PATH="$work/bin:$PATH"

dispatch="codex-mailbox"
codex_command="cd '$work/repo' && export MEGABRAIN_DISPATCH_ID='$dispatch' CODEX_HOME='$real_home/.codex' && exec '$real_codex' -c 'approval_policy=\"never\"' -c 'sandbox_mode=\"read-only\"' 'Run sleep 90 in the shell and wait for it to finish before responding. Then say TASK_FINISHED. Do not modify files.'"
pane="$(tmux new-session -d -s test -P -F '#{pane_id}' "$codex_command")"
session_id="$(tmux display-message -p -t "$pane" '#{session_id}')"
pane_pid="$(tmux display-message -p -t "$pane" '#{pane_pid}')"

cat >"$work/legacy/dispatches/$dispatch/meta.json" <<EOF
{"dispatchId":"$dispatch","parentHost":"local","parentSessionId":"parent-session","parentTerminalId":"parent-session","runtime":"tmux","childHost":"tmux","tmuxSession":"test","tmuxSessionId":"$session_id","tmuxPane":"$pane","agent":"codex","agentId":"codex","agentPid":$pane_pid,"state":"running","processState":"running","terminalState":"owned","worktreePath":"$work/repo","branch":"test-fixture","createdAt":"$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')","updatedAt":"$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"}
EOF
state_db_import "$root/.build/megabrain" "$state" true "$work/legacy"

deadline=$((SECONDS + 90))
busy=0
while [ "$SECONDS" -lt "$deadline" ]; do
  screen="$(tmux capture-pane -p -t "$pane" 2>/dev/null || true)"
  if printf '%s\n' "$screen" | grep -Eiq 'Working|Thinking|sleep 90'; then busy=1; break; fi
  if printf '%s\n' "$screen" | grep -Eiq 'Trust this folder\?'; then
    printf 'FAIL-UNVERIFIED: Codex requested folder trust; no supported trust mechanism reached the mailbox assertions\n' >&2
    exit 1
  fi
  if printf '%s\n' "$screen" | grep -Eiq 'log in|authentication required|not authenticated'; then
    printf 'SKIP: Codex requires authentication; the test left the dialog unanswered\n'
    exit 0
  fi
  sleep 1
done
[ "$busy" = 1 ] || { printf 'FAIL: Codex did not enter a visible working turn within 90 seconds\n' >&2; exit 1; }

env -i HOME="$real_home" PATH="$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_SESSION_HOST=local MEGABRAIN_SESSION_ID=parent-session \
  "$root/.build/megabrain" orchestrate reply "$dispatch" --text 'Please continue after the current command.' --json >/dev/null

deadline=$((SECONDS + 30))
transport=""
while [ "$SECONDS" -lt "$deadline" ]; do
  record="$(state_db_dispatch "$root/.build/megabrain" "$state" "$dispatch")"
  transport="$(printf '%s' "$record" | jq -r '.deliveries[] | select(.recipient == "child") | .transport // empty' | tail -n 1)"
  [ "$transport" = pointer ] && break
  sleep 0.2
done
[ "$transport" = pointer ] || { printf 'FAIL: busy Codex did not receive a mailbox pointer (transport=%s)\n' "$transport" >&2; exit 1; }
assert_unread="$(state_db_dispatch "$root/.build/megabrain" "$state" "$dispatch" | jq -r '.deliveries[] | select(.recipient == "child") | .status')"
[ "$assert_unread" = outstanding ] || { printf 'FAIL: transport changed mailbox status to %s before child check\n' "$assert_unread" >&2; exit 1; }

check_env=(env -i HOME="$real_home" PATH="$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" MEGABRAIN_DISPATCH_ID="$dispatch" TMUX=private TMUX_PANE="$pane")
first="$("${check_env[@]}" "$root/.build/megabrain" check --timeout 0 --json)"
printf '%s' "$first" | jq -e '.text == "Please continue after the current command." and .deliveryId != null' >/dev/null
status="$(state_db_dispatch "$root/.build/megabrain" "$state" "$dispatch" | jq -r '.deliveries[] | select(.recipient == "child") | .status')"
[ "$status" = acknowledged ] || { printf 'FAIL: child check did not acknowledge its reply (status=%s)\n' "$status" >&2; exit 1; }
second="$("${check_env[@]}" "$root/.build/megabrain" check --timeout 0 --json)"
printf '%s' "$second" | jq -e '.status == "empty"' >/dev/null

printf 'ok: real busy Codex receives a pointer, reads persisted mail once, then acknowledges it\n'
