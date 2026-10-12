import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMessage, createDelivery, createDispatch, listDeliveries, listOutbox, stateDatabase } from "../../src/adapters/state-db.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { deliveryComposer, readDeliveryScreen } from "../../src/cli/commands/delivery-screen.js";
import { executeDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";
import { failed, ok } from "../../src/core/result.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";

const fixture = (name: string) => readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const escapes = /\x1b\[[0-9;]*m/g;

async function tmuxScreen(captured: string): Promise<string> {
  const original = getTmux();
  const seen: boolean[] = [];
  registerTmux({
    ...original,
    sessionExists: async () => ok(true),
    panesForSession: async () => ok(["%1"]),
    panePid: async () => ok("100"),
    capturePane: async (_pane, _lines, _process, _screenOnly, _session, withEscapes) => {
      seen.push(withEscapes === true);
      return ok(withEscapes === true ? captured : captured.replace(escapes, ""));
    },
  });
  const process: ProcessAdapter = {
    async run(command, args) {
      if (command === "ps" && args[0] === "-p") return ok<ProcessOutput>({ stdout: "ttys001\n", stderr: "", exitCode: 0 });
      if (command === "ps") return ok<ProcessOutput>({ stdout: "100 1 claude MEGABRAIN_DISPATCH_ID=d1\n", stderr: "", exitCode: 0 });
      return failed(`unexpected ${command}`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
  try {
    const screen = await readDeliveryScreen({ runtime: "tmux", agent: "claude", tmuxSession: "s", tmuxPane: "%1", dispatchId: "d1" }, process);
    if (screen.kind !== "ok") throw new Error("screen unavailable");
    return screen.value;
  } finally {
    registerTmux(original);
  }
}

describe("composer text on tmux", () => {
  test("dim ghost suggestion reads as an empty composer", async () => {
    expect(deliveryComposer("claude", await tmuxScreen(await fixture("tmux-capture-claude-ghost.txt")))).toBe("");
  });

  test("typed text reads as the draft", async () => {
    expect(deliveryComposer("claude", await tmuxScreen(await fixture("tmux-capture-claude-typed.txt")))).toBe("hello");
  });
});

describe("composer region", () => {
  const rule = "─".repeat(60);
  test("prompt lines above the composer rules are transcript, never a draft", () => {
    const screen = ["❯ older prompt from the transcript", "⏺ done", rule, "", rule, "  status"].join("\n");
    expect(deliveryComposer("claude", screen)).toBeUndefined();
  });

  test("the line between the rules is the draft", () => {
    const screen = ["❯ older prompt", "⏺ done", rule, "❯ typing now", rule, "  status"].join("\n");
    expect(deliveryComposer("claude", screen)).toBe("typing now");
  });
});

const sessionShape = new URL("../fixtures/claude-session-idle.json", import.meta.url);

async function orcaScreen(composer: (read: number) => string): Promise<(read: number) => string> {
  const base = JSON.parse(await fixture("orca-terminal-screen-claude-idle.json")) as { result: { terminal: { tail: string[] } } };
  return (read) => {
    const tail = base.result.terminal.tail.map((line) => line.startsWith("❯") ? `❯ ${composer(read)}`.trimEnd() : line);
    return JSON.stringify({ ...base, result: { terminal: { ...base.result.terminal, tail } } });
  };
}

async function orcaRun(composer: (read: number, pasted: boolean) => string, env: Record<string, string>, deadlineMs: number, host = "orca") {
  const root = await mkdtemp(join(tmpdir(), "delivery-ghost-"));
  const session = JSON.parse(await readFile(sessionShape, "utf8")) as Record<string, unknown>;
  session.pid = 41414;
  await mkdir(join(root, ".claude", "sessions"), { recursive: true });
  await writeFile(join(root, ".claude", "sessions", "41414.json"), JSON.stringify(session));
  const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
  if (db.kind !== "ok") throw new Error(db.error);
  const meta = { agent: "claude", agentPid: 1, agentSessionId: "child", parentAgent: "claude", parentAgentPid: 41414, parentAgentSessionId: session.sessionId, parentHost: host, parentWorkspaceId: "workspace", parentTerminalId: "parent-terminal" };
  createDispatch(db.value, { dispatchId: "d-ghost", state: "running", ...meta });
  appendMessage(db.value, "d-ghost", { from: "child", type: "done", text: "finished" }, {
      outbox: { id: "ob-ghost", targetKind: "parent-pointer", target: `${host}:parent-terminal`, payload: { dispatchId: "d-ghost", sequence: 1, meta, pointer: "megabrain check", fullMessage: "✅ test finished" } },
  });
  createDelivery(db.value, { id: "dl-ghost", dispatchId: "d-ghost", messageSeqs: [1], status: "outstanding" });
  let pasted = false;
  const screens = await orcaScreen((read) => composer(read, pasted));
  let reads = 0;
  const sends: string[] = [];
  const process: ProcessAdapter = {
    async run(command, args) {
      if (command === "orca" && args[1] === "list") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "parent-terminal" }] }), stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "read") { reads += 1; return ok<ProcessOutput>({ stdout: screens(reads), stderr: "", exitCode: 0 }); }
      if (command === "orca" && args[1] === "send") {
        sends.push(args.join(" "));
        const textIndex = args.indexOf("--text");
        if (textIndex >= 0 && args[textIndex + 1] !== "") pasted = true;
        return ok<ProcessOutput>({ stdout: "{}", stderr: "", exitCode: 0 });
      }
      return failed(`unexpected ${command} ${args.join(" ")}`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
  try {
    await executeDeliveryWorker(["ob-ghost", "holder", "delivery-target:orca:parent-terminal", String(Date.now() + deadlineMs)], { HOME: root, MEGABRAIN_STATE_DIR: root, ...env }, process);
    const outbox = listOutbox(db.value);
    const deliveries = listDeliveries(db.value, "d-ghost");
    const log = (await readFile(join(root, "delivery-decisions.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    return { sends, log, outbox: outbox.kind === "ok" ? outbox.value : [], deliveries: deliveries.kind === "ok" ? deliveries.value : [] };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("composer text on Orca, where ghost and typed text look the same", () => {
  test("a human draft that stays unchanged for five minutes is never submitted", async () => {
    const run = await orcaRun(() => "write the test file", { MEGABRAIN_GHOST_STATIC_MS: "1" }, 1500);
    expect(run.sends).toHaveLength(0);
    expect(run.outbox[0]).toMatchObject({ status: "failed", detail: "composer-occupied" });
    expect(run.deliveries[0]?.status).not.toBe("acknowledged");
  });

  test("a line that keeps changing is someone typing and is never overwritten", async () => {
    const run = await orcaRun((read) => `write the test fi${read}`, { MEGABRAIN_GHOST_STATIC_MS: "300" }, 2500);
    expect(run.sends).toHaveLength(0);
  });

  test("submits in one call even when the post-paste read-back diverges", async () => {
    const run = await orcaRun((_read, pasted) => pasted ? "✅ test finished plus human text" : "", {}, 1500);
    expect(run.sends).toHaveLength(1);
    expect(run.sends[0]).toContain("--enter");
    expect(run.sends[0]).toContain("--text");
    expect(run.outbox[0]?.status).toBe("sent");
  });

  test("submits the notice and Enter in one call without a composer read-back gate", async () => {
    const run = await orcaRun((_read, pasted) => pasted ? "✅ test finished" : "", {}, 1500);
    expect(run.sends).toHaveLength(1);
    expect(run.sends[0]).toContain("--enter");
    expect(run.sends[0]).toContain("--text");
  });

  test("holds Superset delivery when submit cannot be verified", async () => {
    const run = await orcaRun(() => "", {}, 1500, "superset");
    expect(run.sends).toHaveLength(0);
    expect(run.outbox[0]).toMatchObject({ status: "suppressed", detail: "superset-unverifiable-composer" });
    expect(run.deliveries[0]).toMatchObject({ transport: "deferred" });
  });

  test("a draft that outlasts the deadline fails as composer-occupied and stays unread", async () => {
    const run = await orcaRun(() => "write the test file", { MEGABRAIN_GHOST_STATIC_MS: "60000" }, 1500);
    expect(run.sends).toHaveLength(0);
    expect(run.outbox[0]).toMatchObject({ status: "failed", detail: "composer-occupied" });
    expect(run.deliveries[0]).toMatchObject({ transport: "failed" });
    expect(run.deliveries[0]?.status).not.toBe("acknowledged");
  });
});
