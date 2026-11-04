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
fixture="$real_home/.cache/megabrain-e2e/codex-mailbox-repo"
codex_config="${CODEX_HOME:-$real_home/.codex}/config.toml"
server="mb-codex-mail-$RANDOM-$$"
real_tmux="$(command -v tmux || true)"
real_codex="$(command -v codex || true)"
real_git="$(command -v git)"

cleanup() {
  tmux -L "$server" kill-server >/dev/null 2>&1 || true
  remove_test_dir "$state"
  rm -rf "$fixture"
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

printf 'Codex E2E will add one stable trust entry: %s\n' "$fixture"
before_config="$(shasum -a 256 "$codex_config" 2>/dev/null | awk '{print $1}' || true)"
before_config="${before_config:-missing}"
mkdir -p "$(dirname "$fixture")" "$work/legacy/dispatches/codex-mailbox" "$work/bin"
rm -rf "$fixture"
mkdir -p "$fixture"
cd "$fixture"
"$real_git" init -q
"$real_git" config user.name 'Megabrain E2E'
"$real_git" config user.email 'megabrain-e2e@example.invalid'
printf 'temporary fixture\n' >README.md
"$real_git" add README.md
"$real_git" commit -qm 'test fixture'

if ! HOME="$real_home" CODEX_HOME="${CODEX_HOME:-$real_home/.codex}" MEGABRAIN_ROOT="$root" bun --eval 'const { preflightWorktreeTrust } = await import(`${process.env.MEGABRAIN_ROOT}/src/agents/worktree-trust.ts`); const result = await preflightWorktreeTrust("codex", process.argv[1], process.env); if (result.kind !== "ok") { console.error(result.error); process.exit(1); }' "$fixture"; then
  printf 'FAIL: megabrain Codex trust preflight could not trust the stable fixture\n' >&2
  exit 1
fi
after_config="$(shasum -a 256 "$codex_config" 2>/dev/null | awk '{print $1}' || true)"
after_config="${after_config:-missing}"
if [ "$before_config" = "$after_config" ]; then
  printf 'Codex config.toml changed: no (sha256 %s)\n' "$after_config"
else
  printf 'Codex config.toml changed: yes (before %s, after %s)\n' "$before_config" "$after_config"
fi

cat >"$work/bin/tmux" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> '$work/tmux.log'
if [ "\$1" = -L ]; then shift 2; fi
exec "$real_tmux" -L "$server" "\$@"
EOF
chmod +x "$work/bin/tmux"
export PATH="$work/bin:$PATH"

dispatch="codex-mailbox"
codex_command="cd '$fixture' && export MEGABRAIN_DISPATCH_ID='$dispatch' CODEX_HOME='${CODEX_HOME:-$real_home/.codex}' && exec '$real_codex' -c 'approval_policy=\"never\"' -c 'sandbox_mode=\"read-only\"' 'Run sleep 90 in the shell and wait for it to finish before responding. Then say TASK_FINISHED. Do not modify files.'"
pane="$(tmux new-session -d -s test -P -F '#{pane_id}' "$codex_command")"
session_id="$(tmux display-message -p -t "$pane" '#{session_id}')"
pane_pid="$(tmux display-message -p -t "$pane" '#{pane_pid}')"

cat >"$work/legacy/dispatches/$dispatch/meta.json" <<EOF
{"dispatchId":"$dispatch","parentHost":"local","parentSessionId":"parent-session","parentTerminalId":"parent-session","runtime":"tmux","childHost":"tmux","tmuxSession":"test","tmuxSessionId":"$session_id","tmuxPane":"$pane","agent":"codex","agentId":"codex","agentPid":$pane_pid,"state":"running","processState":"running","terminalState":"owned","worktreePath":"$fixture","branch":"test-fixture","createdAt":"$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')","updatedAt":"$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"}
EOF
state_db_import "$root/.build/megabrain" "$state" true "$work/legacy"
printf 'fixture pane: %s; persisted session: %s; live panes: %s\n' "$pane" "$session_id" "$(tmux list-panes -a -F '#{pane_id}|#{session_id}')" >"$work/tmux-preflight.log"

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
if [ "$transport" != pointer ]; then
  printf 'FAIL: busy Codex did not receive a mailbox pointer (transport=%s)\n' "$transport" >&2
  state_db_dispatch "$root/.build/megabrain" "$state" "$dispatch" | jq '{meta: {tmuxSessionId: .meta.tmuxSessionId, tmuxPane: .meta.tmuxPane, tmuxSession: .meta.tmuxSession}, delivery: [.deliveries[] | select(.recipient == "child")]}'
  if [ -f "$state/delivery-decisions.jsonl" ]; then cat "$state/delivery-decisions.jsonl" >&2; fi
  cat "$work/tmux-preflight.log" >&2
  if [ -f "$work/tmux.log" ]; then cat "$work/tmux.log" >&2; fi
  tmux capture-pane -p -t "$pane" 2>/dev/null || true
  exit 1
fi
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
