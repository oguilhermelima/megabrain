#!/usr/bin/env bash
set -euo pipefail

unset MEGABRAIN_SESSION_ID MEGABRAIN_SESSION_HOST CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID \
  ORCA_STRUCTURED_SESSION ORCA_AGENT_SESSION_SPAWN_TOKEN ORCA_TERMINAL_HANDLE SUPERSET_TERMINAL_ID \
  TMUX TMUX_PANE MEGABRAIN_DISPATCH_ID

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/stable-owner-shells.XXXXXX")"
source "$root/tests/support/state-dir-guard.bash"
export MEGABRAIN_STATE_DIR="$work/.megabrain-test-state"
require_megabrain_test_state
export HOME="$work/home"
mkdir -p "$HOME" "$work/bin"
trap 'rm -rf "$work"' EXIT

if [ ! -x "$root/.build/megabrain" ]; then
  printf 'skip: compiled binary is missing; run bun run build\n'
  exit 0
fi

cat >"$work/bin/superset" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' '{"ok":true}'
EOF
chmod +x "$work/bin/superset"
export PATH="$work/bin:$PATH"

cat >"$work/run-shells.mjs" <<'EOF'
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, work] = process.argv.slice(2);
const binary = join(root, ".build", "megabrain");
const state = join(work, "state");
const id = "dispatch-stable-shell";
const start = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
const owner = `proc:${process.pid}:${start}`;
mkdirSync(join(state, "dispatches", id), { recursive: true });
writeFileSync(join(state, "dispatches", id, "meta.json"), JSON.stringify({
  dispatchId: id, parentHost: "local", parentSessionId: owner, parentTerminalId: null,
  parentTmuxSession: null, parentTmuxPane: null, childHost: "superset", workspaceId: "workspace-test",
  terminalId: "terminal-test", runtime: "host", agent: "codex", agentId: "codex", branch: "fix/stable-local-owner",
  state: "running", processState: "running", terminalState: "owned", promptReceipt: "received",
  promptState: "confirmed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}));
const env = { ...process.env, MEGABRAIN_STATE_DIR: state, HOME: join(work, "home"), MEGABRAIN_BIN: binary };
const imported = spawnSync(binary, ["db", "import", state, "--replace", "--json"], { env, encoding: "utf8" });
if (imported.status !== 0) throw new Error(`fixture import failed: ${imported.stderr || imported.stdout}`);

let sleeper;
try {
  // Spawn a harmless stand-in child from one sh -c, then use three fresh shells under this parent.
  const spawned = spawnSync("sh", ["-c", "sleep 60 >/dev/null 2>&1 & printf '%s' \"$!\""], { encoding: "utf8" });
  sleeper = Number(spawned.stdout);
  if (spawned.status !== 0 || !Number.isSafeInteger(sleeper)) throw new Error("could not start stand-in child");
  for (const [name, command] of [
    ["watch", `\"$MEGABRAIN_BIN\" orchestrate watch ${id} --timeout 0 --json`],
    ["reply", `\"$MEGABRAIN_BIN\" orchestrate reply ${id} --text hello --json`],
    ["close", `\"$MEGABRAIN_BIN\" orchestrate close ${id} --json`],
  ]) {
    const result = spawnSync("sh", ["-c", command], { env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${name} from a fresh shell failed: ${result.stderr || result.stdout}`);
    process.stdout.write(`${name}: ${result.stdout.trim()}\n`);
  }
} finally {
  if (Number.isSafeInteger(sleeper)) {
    try { process.kill(sleeper, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
EOF

node "$work/run-shells.mjs" "$root" "$work"
printf 'ok: fresh sh invocations under one parent can watch, reply, and close\n'
