import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { resolveCaller } from "../../src/cli/commands/queue-write.js";
import { executeOrchestrateAdopt } from "../../src/cli/commands/orchestrate-adopt.js";
import { isAgentSessionId } from "../../src/core/context.js";
import { guardedStateDatabase } from "./state-db-guard.js";
import { createDispatch, getDispatch } from "../../src/adapters/state-db.js";

// Grok and Agy export no session id to the commands they run, but both record which process holds
// which session, measured 2026-10-12 against Grok 1.0.52 and Antigravity CLI 1.3.3:
// - Grok keeps <GROK_HOME>/active_sessions.json, [{session_id, pid, cwd, opened_at}], one entry per
//   live process; `grok --resume <id>` adds the same session_id under the new pid.
// - Agy holds <home>/.gemini/antigravity-cli/presence/<conversation>.lock open from its first prompt
//   on; `agy --conversation <id>` holds the same lock at once.
// Commands run as children of that process (agy -> sh; grok -> zsh -> sh), so it is the caller's
// stable ancestor.

type Row = Readonly<{ ppid: number; lstart: string; command: string }>;
type Table = Readonly<Record<number, Row>>;
type Call = Readonly<{ command: string; args: readonly string[] }>;

const started = "Mon Oct 12 16:05:20 2026";
const grokSession = "01a13181-4d46-74c0-a881-5db282186424";
const agyConversation = "a0aeeeaa-ba98-40c3-9e3d-bc6ea7744166";

function agentTable(agent: string, pid: number): Table {
  return {
    [process.ppid]: { ppid: pid, lstart: "Mon Oct 12 16:06:00 2026", command: "/bin/sh -c megabrain orchestrate watch x" },
    [pid]: { ppid: 7660, lstart: started, command: agent },
    7660: { ppid: 1, lstart: started, command: "tmux" },
  };
}

// ps answers per pid; lsof answers "-p <pid> -Fn" with the files a process holds, and "-t <path>"
// with the pids holding a path.
function fakeProcess(table: Table, open: Readonly<Record<number, readonly string[]>> = {}): ProcessAdapter & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command: string, args: readonly string[]): Promise<Result<ProcessOutput>> {
      calls.push({ command, args: [...args] });
      if (command === "lsof") {
        if (args.includes("-t")) {
          const path = args.at(-1) ?? "";
          const holders = Object.entries(open).filter(([, files]) => files.includes(path)).map(([pid]) => pid);
          return holders.length === 0 ? failed("lsof exited with status 1") : ok({ stdout: `${holders.join("\n")}\n`, stderr: "", exitCode: 0 });
        }
        const pid = Number(args[args.indexOf("-p") + 1]);
        return ok({ stdout: `p${pid}\n${(open[pid] ?? []).map((file) => `f4\nn${file}`).join("\n")}\n`, stderr: "", exitCode: 0 });
      }
      if (command !== "ps") return ok({ stdout: "", stderr: "", exitCode: 0 });
      const pid = Number(args[args.indexOf("-p") + 1]);
      const row = table[pid];
      if (row === undefined) return failed("ps exited with status 1");
      if (args.includes("tty=")) return ok({ stdout: "??\n", stderr: "", exitCode: 0 });
      if (args.includes("lstart=") && !args.includes("ppid=")) return ok({ stdout: `${row.lstart}\n`, stderr: "", exitCode: 0 });
      return ok({ stdout: ` ${row.ppid} ${row.lstart} ${row.command}\n`, stderr: "", exitCode: 0 });
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

async function grokHome(entries: ReadonlyArray<{ session_id: string; pid: number }>): Promise<string> {
  const home = await mkdtemp(`${tmpdir()}/megabrain-grok-home-`);
  await writeFile(join(home, "active_sessions.json"), JSON.stringify(entries.map((entry) => ({ ...entry, cwd: "/repo", opened_at: "2026-10-12T19:05:20Z" }))));
  return home;
}

const lock = (home: string, id: string): string => join(home, ".gemini/antigravity-cli/presence", `${id}.lock`);

describe("a Grok or Agy caller is owned by its agent session", () => {
  test("a grok ancestor listed in active_sessions.json is grok:<session>", async () => {
    const home = await grokHome([{ session_id: grokSession, pid: 22554 }]);
    const caller = await resolveCaller({ GROK_HOME: home }, fakeProcess(agentTable("/Users/u/.grok/bin/grok", 22554)));
    expect(caller).toMatchObject({ id: `grok:${grokSession}`, host: "local" });
  });

  test("a grok process with no session entry stays a process owner", async () => {
    const home = await grokHome([{ session_id: grokSession, pid: 1 }]);
    const caller = await resolveCaller({ GROK_HOME: home }, fakeProcess(agentTable("grok", 22554)));
    expect(caller.id).toBe(`proc:22554:${started}`);
  });

  test("an agy ancestor holding a presence lock is agy:<conversation>", async () => {
    const home = "/Users/u";
    const caller = await resolveCaller({ HOME: home }, fakeProcess(agentTable("agy", 93600), { 93600: [join(home, ".gemini/antigravity-cli/presence"), lock(home, agyConversation)] }));
    expect(caller).toMatchObject({ id: `agy:${agyConversation}`, host: "local" });
  });

  test("agy before its first prompt holds no lock and stays a process owner", async () => {
    const home = "/Users/u";
    const caller = await resolveCaller({ HOME: home }, fakeProcess(agentTable("agy", 93600), { 93600: [join(home, ".gemini/antigravity-cli/presence")] }));
    expect(caller.id).toBe(`proc:93600:${started}`);
  });

  test("the agent session beats a tmux pane, which still names the terminal", async () => {
    const home = await grokHome([{ session_id: grokSession, pid: 22554 }]);
    const table = agentTable("grok", 22554);
    const process = fakeProcess(table);
    const tmuxAware: ProcessAdapter = {
      ...process,
      async run(command, args) {
        if (command === "tmux") return ok({ stdout: "work\n", stderr: "", exitCode: 0 });
        return process.run(command, args);
      },
    };
    const caller = await resolveCaller({ GROK_HOME: home, TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%3" }, tmuxAware);
    expect(caller).toMatchObject({ id: `grok:${grokSession}`, host: "tmux", terminalId: "work:%3" });
  });

  test("a Claude or Codex session id is used without walking the process tree", async () => {
    const process = fakeProcess(agentTable("grok", 22554));
    expect((await resolveCaller({ CODEX_THREAD_ID: "t-1" }, process)).id).toBe("codex:t-1");
    expect(process.calls.filter((call) => call.command === "ps" || call.command === "lsof")).toHaveLength(0);
  });

  test("grok and agy owners are agent sessions", () => {
    expect(isAgentSessionId(`grok:${grokSession}`)).toBe(true);
    expect(isAgentSessionId(`agy:${agyConversation}`)).toBe(true);
  });
});

describe("adopting a dispatch from a Grok or Agy owner", () => {
  async function seed(owner: string): Promise<{ root: string; id: string }> {
    const root = await mkdtemp(`${tmpdir()}/megabrain-agent-owner-`);
    const handle = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
    if (handle.kind !== "ok") throw new Error(handle.error);
    const now = new Date().toISOString();
    createDispatch(handle.value, {
      dispatchId: "dispatch-agent-owner-1", parentHost: "local", parentSessionId: owner, parentTerminalId: null, parentTmuxSession: null, parentTmuxPane: null,
      childHost: "tmux", terminalId: "tmux:s:%9", worktreePath: "/tmp/worktree", branch: "feat/x", agent: "codex", agentId: "codex",
      runtime: "tmux", tmuxSession: "s", tmuxPane: "%9", state: "running", processState: "running", terminalState: "owned",
      promptReceipt: "received", promptState: "confirmed", createdAt: now, updatedAt: now,
    });
    return { root, id: "dispatch-agent-owner-1" };
  }
  const adopter: Table = { [process.ppid]: { ppid: 900001, lstart: started, command: "zsh" }, 900001: { ppid: 1, lstart: started, command: "node /opt/dash.js" } };

  test("a grok owner whose session is still open needs --force", async () => {
    const { root, id } = await seed(`grok:${grokSession}`);
    const home = await grokHome([{ session_id: grokSession, pid: 22554 }]);
    const result = await executeOrchestrateAdopt([id], { MEGABRAIN_STATE_DIR: root, GROK_HOME: home }, fakeProcess({ ...adopter, 22554: { ppid: 1, lstart: started, command: "grok" } }));
    expect(result.kind === "failed" ? result.error : "").toContain("--force");
  });

  test("a grok owner whose session closed can be adopted", async () => {
    const { root, id } = await seed(`grok:${grokSession}`);
    const home = await grokHome([]);
    const result = await executeOrchestrateAdopt([id], { MEGABRAIN_STATE_DIR: root, GROK_HOME: home }, fakeProcess(adopter));
    expect(result.kind).toBe("ok");
    const handle = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
    if (handle.kind !== "ok") throw new Error(handle.error);
    const stored = getDispatch(handle.value, id);
    expect(stored.kind === "ok" ? stored.value : undefined).toMatchObject({ parentSessionId: `proc:900001:${started}` });
  });

  test("an agy owner is alive while a process holds its presence lock", async () => {
    const home = "/Users/u";
    const held = await seed(`agy:${agyConversation}`);
    const live = await executeOrchestrateAdopt([held.id], { MEGABRAIN_STATE_DIR: held.root, HOME: home }, fakeProcess(adopter, { 93600: [lock(home, agyConversation)] }));
    expect(live.kind === "failed" ? live.error : "").toContain("--force");
    const released = await seed(`agy:${agyConversation}`);
    expect((await executeOrchestrateAdopt([released.id], { MEGABRAIN_STATE_DIR: released.root, HOME: home }, fakeProcess(adopter))).kind).toBe("ok");
  });
});
