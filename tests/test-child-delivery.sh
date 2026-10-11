#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/tests/support/state-dir-guard.bash"
source "$root/tests/support/state-db.bash"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-child-delivery.XXXXXX")"
state="$work/state"
server="mb-cd-$RANDOM-$$"
mkdir -p "$work/home" "$work/fakebin"
export HOME="$work/home" MEGABRAIN_STATE_DIR="$state"
require_megabrain_test_state "$state"

real_tmux="$(command -v tmux)"
real_node="$(command -v node)"
real_bun="$(command -v bun)"
real_path="$PATH"
cleanup() {
  tmux -L "$server" kill-server >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

for name in $(compgen -e); do
  case "$name" in MEGABRAIN_*|ORCA_*|TMUX*) unset "$name" ;; esac
done
export HOME="$work/home" MEGABRAIN_STATE_DIR="$state"
require_megabrain_test_state "$state"

cat >"$work/fakebin/tmux" <<EOF
#!/bin/sh
exec "$real_tmux" -L "$server" "\$@"
EOF
cat >"$work/fakebin/codex" <<EOF
#!/bin/sh
if [ "\$1" = queue ]; then
  printf '%s\n' "\$*" >>"$work/codex-queue.log"
  exit 0
fi
export CODEX_THREAD_ID=thread-codex MEGABRAIN_DISPATCH_ID=child-codex MB_AGENT=codex MB_CHANGE_LOG="$work/codex-typed.log"
"$real_node" "$root/tests/fixtures/change-agent.mjs"
sleep 100
EOF
chmod +x "$work/fakebin/tmux" "$work/fakebin/codex"
export PATH="$work/fakebin:$real_path"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_equal() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected '$1' to contain '$2'" ;; esac; }
write_meta() {
  local dispatch="$1" agent="$2" pane="$3" session_id="$4" pane_pid="$5" thread="${6:-}"
  mkdir -p "$work/legacy/dispatches/$dispatch"
  cat >"$work/legacy/dispatches/$dispatch/meta.json" <<EOF
{"dispatchId":"$dispatch","parentHost":"orca","parentSessionId":"parent","runtime":"tmux","tmuxSession":"test","tmuxSessionId":"$session_id","tmuxPane":"$pane","agent":"$agent","agentId":"$agent","agentPid":$pane_pid,"agentThreadId":"$thread","state":"running","processState":"running","terminalState":"owned","createdAt":"2026-10-11T00:00:00.000Z","updatedAt":"2026-10-11T00:00:00.000Z"}
EOF
}
show_dispatch() { MEGABRAIN_STATE_DIR="$state" "$root/.build/megabrain" db show "$1" --json; }
run_reply() {
  local dispatch="$1" body="$2"
  env -i HOME="$HOME" PATH="$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" ORCA_TERMINAL_HANDLE=parent \
    "$root/.build/megabrain" orchestrate reply "$dispatch" --text "$body" --json
}
run_hook() {
  local pane="$1"
  env -i HOME="$HOME" PATH="$PATH" MEGABRAIN_ROOT="$root" MEGABRAIN_STATE_DIR="$state" TMUX=private TMUX_PANE="$pane" \
    "$root/.build/megabrain" hook turn-end
}

[ -x "$root/.build/megabrain" ] || fail 'compiled megabrain missing; run bun run build'

codex_pane="$(tmux -L "$server" new-session -d -s test -P -F '#{pane_id}' "PATH='$PATH' '$work/fakebin/codex' agent")"
codex_session_id="$(tmux -L "$server" display-message -p -t "$codex_pane" '#{session_id}')"
write_meta child-codex codex "$codex_pane" "$codex_session_id" 42 thread-codex
state_db_import "$root/.build/megabrain" "$state" true "$work/legacy"
codex_reply='full Codex reply body'
"$real_bun" -e '
  import { createProcessAdapter } from "./src/adapters/proc.ts";
  import { executeOrchestrateReply } from "./src/cli/commands/orchestrate-reply.ts";
  import { ok, failed } from "./src/core/result.ts";
  const [root, body] = process.argv.slice(1);
  const real = createProcessAdapter();
  const adapter = {
    async run(command, args) {
      if (command === "ps" && args.includes("-p")) return ok({ stdout: "codex CODEX_THREAD_ID=thread-codex", stderr: "", exitCode: 0 });
      if (command === "ps" && args.includes("-ax")) return ok({ stdout: "4242 /usr/local/bin/codex CODEX_THREAD_ID=thread-codex", stderr: "", exitCode: 0 });
      return real.run(command, args);
    },
    async startDetached() { return failed("unexpected deferred worker"); },
    invocationCount() { return 0; },
  };
  const result = await executeOrchestrateReply(["child-codex", "--text", body, "--json"], { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "parent" }, adapter);
  if (result.kind !== "ok") throw Error(result.error);
  if (!result.value.includes("\"nudge\": \"typed\"")) throw Error(result.value);
' "$state" "$codex_reply"
assert_contains "$(cat "$work/codex-queue.log" 2>/dev/null || true)" "$codex_reply"
assert_equal "$(show_dispatch child-codex | jq -r '.deliveries[] | select(.recipient == "child") | .transport')" queue
printf 'Codex child receives the full reply through the queue\n'

tmux -L "$server" kill-session -t test
claude_pane="$(tmux -L "$server" new-session -d -s test -P -F '#{pane_id}' "env MEGABRAIN_DISPATCH_ID=child-claude MB_AGENT=claude MB_CHANGE_LOG='$work/claude-typed.log' node '$root/tests/fixtures/change-agent.mjs'")"
claude_session_id="$(tmux -L "$server" display-message -p -t "$claude_pane" '#{session_id}')"
claude_pane_pid="$(tmux -L "$server" display-message -p -t "$claude_pane" '#{pane_pid}')"
write_meta child-claude claude "$claude_pane" "$claude_session_id" "$claude_pane_pid"
state_db_import "$root/.build/megabrain" "$state" true "$work/legacy"
claude_reply='full Claude reply body'
run_reply child-claude "$claude_reply" >/dev/null
sleep 0.3
tmux -L "$server" capture-pane -p -t "$claude_pane" | grep -Eq 'Working' || fail 'Claude stand-in was not busy before release'
tmux -L "$server" send-keys -t "$claude_pane" Escape Escape
deadline=$((SECONDS + 20))
while [ "$SECONDS" -lt "$deadline" ]; do
  transport="$(show_dispatch child-claude | jq -r '.deliveries[] | select(.recipient == "child") | .transport')"
  [ "$transport" = typed ] && break
  sleep 0.1
done
assert_equal "$transport" typed
assert_contains "$(cat "$work/claude-typed.log" 2>/dev/null || true)" "$claude_reply"
"$real_bun" -e '
  import { appendMessage, stateDatabase } from "./src/adapters/state-db.ts";
  const root = process.argv[1];
  const db = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (db.kind !== "ok") throw Error(db.error);
  const result = appendMessage(db.value, "child-claude", { from: "child", type: "done", text: "finished", sessionId: "child-claude" });
  if (result.kind !== "ok") throw Error(result.error);
' "$state"
hook="$(run_hook "$claude_pane")"
assert_contains "$hook" '{}'
assert_equal "$(show_dispatch child-claude | jq -r '.deliveries[] | select(.recipient == "child") | .transport')" typed
printf 'Claude child waits while busy, receives the full reply when idle, and its hook stays clear after done\n'

printf 'ok: child delivery through Codex queue and Claude idle typing\n'
