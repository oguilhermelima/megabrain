#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/tests/support/state-dir-guard.bash"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-native-delivery-state.XXXXXX")"
export MEGABRAIN_STATE_DIR="$state_dir"
server="mb-native-delivery-$$"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-native-delivery.XXXXXX")"
cleanup() {
  tmux -L "$server" kill-server >/dev/null 2>&1 || true
  python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)' "$work_dir"
  python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)' "$state_dir"
}
trap cleanup EXIT

unset MEGABRAIN_DISPATCH_ID
for key in $(env | cut -d= -f1 | rg '^(MEGABRAIN_|ORCA_|TMUX)' || true); do unset "$key"; done
export MEGABRAIN_STATE_DIR="$state_dir"
require_megabrain_test_state
mkdir -p "$state_dir"

tmux -L "$server" new-session -d -s test "node '$repo_root/tests/fixtures/native-delivery-agent.mjs' '$work_dir/release' '$work_dir/received'"
pane="$(tmux -L "$server" display-message -p -t test '#{pane_id}')"
bun -e '
  import { createProcessAdapter } from "./src/adapters/proc.ts";
  import { deliverWhenIdle } from "./src/core/idle-delivery.ts";
  import { getTmux, sendTmuxPair } from "./src/hosts/tmux.ts";
  const [root, pane, release, server] = process.argv.slice(1);
  const proc = createProcessAdapter();
  const original = getTmux();
  const run = async (args) => proc.run("tmux", ["-L", server, ...args]);
  const success = async (args) => (await run(args)).kind === "ok";
  (await import("./src/hosts/tmux.ts")).registerTmux({
    ...original,
    capturePane: async (_pane, _lines, _process, _screenOnly) => { const r = await run(["capture-pane", "-p", "-t", pane]); return r.kind === "ok" ? { kind: "ok", value: r.value.stdout } : { kind: "failed", error: r.error, exitCode: r.exitCode }; },
    sendText: async (_pane, text) => await success(["send-keys", "-t", pane, "-l", text]) ? { kind: "ok", value: undefined } : { kind: "failed", error: "send failed", exitCode: 1 },
    sendKey: async (_pane, key) => await success(["send-keys", "-t", pane, key]) ? { kind: "ok", value: undefined } : { kind: "failed", error: "send failed", exitCode: 1 },
  });
  const result = await deliverWhenIdle({
    timeoutMs: 30000, initialDelayMs: 30, maxDelayMs: 100,
    inspect: async () => {
      const screen = await getTmux().capturePane(pane, 40, proc, true);
      return screen.kind === "ok" && screen.value.includes("IDLE") ? "idle" : "busy";
    },
    composer: async () => "",
    clear: async () => true,
    send: async () => (await sendTmuxPair(root, pane, "NATIVE_MESSAGE", "C-m", { MEGABRAIN_LOCK_WAIT_SECONDS: "1" }, proc)).kind === "ok",
    isRead: async () => false,
  });
  if (result !== "delivered") throw Error(`delivery result: ${result}`);
' "$state_dir" "$pane" "$work_dir/release" "$server" &
worker_pid=$!
sleep 0.2
screen="$(tmux -L "$server" capture-pane -p -t "$pane")"
[[ "$screen" == *BUSY* ]] || { printf 'agent was not busy before release\n' >&2; exit 1; }
[[ "$screen" != *NATIVE_MESSAGE* ]] || { printf 'message was typed while busy\n' >&2; exit 1; }
touch "$work_dir/release"
wait "$worker_pid"
for _ in $(seq 1 30); do [[ -f "$work_dir/received" ]] && break; sleep 0.1; done
[[ -f "$work_dir/received" ]] || { printf 'message was not typed after idle\n' >&2; exit 1; }
[[ "$(cat "$work_dir/received")" == NATIVE_MESSAGE ]] || { printf 'unexpected message content\n' >&2; exit 1; }
printf 'ok: native message waits until the tmux agent is idle\n'
