import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMessage, createDelivery, createDispatch, listDeliveries, listOutbox, stateDatabase } from "../../src/adapters/state-db.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { deliveryComposer, readDeliveryScreen } from "../../src/cli/commands/delivery-screen.js";
import { deliverWithOwner } from "./owner-delivery.js";
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
      if (command === "ps" && args[0] === "-ww") return ok<ProcessOutput>({ stdout: "41414 41414 41414 /opt/claude/bin/claude --resume parent-session\n", stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "list") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "parent-terminal" }] }), stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "read") { reads += 1; return ok<ProcessOutput>({ stdout: screens(reads), stderr: "", exitCode: 0 }); }
      if (command === "orca" && args[1] === "send") {
        sends.push(args.join(" "));
        const textIndex = args.indexOf("--text");
        if (textIndex >= 0 && args[textIndex + 1] !== "") pasted = true;
        return ok<ProcessOutput>({ stdout: "{}", stderr: "", exitCode: 0 });
      }
      if (command === "superset" && args[0] === "terminals" && args[1] === "send") {
        sends.push(args.join(" "));
        return ok<ProcessOutput>({ stdout: "{}", stderr: "", exitCode: 0 });
      }
      return failed(`unexpected ${command} ${args.join(" ")}`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
  try {
    await deliverWithOwner(root, process, { HOME: root, ...env }, "ob-ghost", deadlineMs);
    const outbox = listOutbox(db.value);
    const deliveries = listDeliveries(db.value, "d-ghost");
    const log = (await readFile(join(root, "delivery-decisions.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    return { sends, log, outbox: outbox.kind === "ok" ? outbox.value : [], deliveries: deliveries.kind === "ok" ? deliveries.value : [] };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("composer text on Orca, where ghost and typed text look the same", () => {
  test("submits a parent notice even when Orca cannot distinguish suggestion text from a draft", async () => {
    const run = await orcaRun(() => "sim, agenda a cada 15 min e pode seguir as 3 fases", {}, 1500);
    expect(run.sends).toHaveLength(1);
    expect(run.sends[0]).toContain("--enter");
    expect(run.outbox[0]?.status).toBe("sent");
    expect(run.deliveries[0]?.transport).toBe("typed");
  });

  test("submits a parent notice while composer text changes", async () => {
    const run = await orcaRun((read) => `write the test fi${read}`, {}, 1500);
    expect(run.sends).toHaveLength(1);
    expect(run.sends[0]).toContain("--enter");
    expect(run.outbox[0]?.status).toBe("sent");
  });

  test("submits in one call even when the post-paste read-back diverges", async () => {
    const run = await orcaRun((_read, pasted) => pasted ? "✅ test finished plus human text" : "", {}, 1500);
    expect(run.sends).toHaveLength(1);
    expect(run.sends[0]).toContain("--enter");
    expect(run.sends[0]).toContain("--text");
    expect(run.outbox[0]?.status).toBe("sent");
  });

  test("does not submit twice when the composer shows the exact ack line we sent", async () => {
    const run = await orcaRun((_read, pasted) => pasted ? "✅ test finished — After reading, acknowledge with: megabrain orchestrate ack d-ghost dl-ghost" : "", {}, 5000);
    expect(run.sends).toHaveLength(1);
    expect(run.sends[0]).toContain("--enter");
    expect(run.sends[0]).toContain("--text");
    expect(run.sends[0]).toContain("After reading, acknowledge with: megabrain orchestrate ack d-ghost dl-ghost");
  });

  test("submits to Superset without a readable composer proof", async () => {
    const run = await orcaRun(() => "", {}, 1500, "superset");
    expect(run.sends).toHaveLength(1);
    expect(run.sends[0]).toContain("--text ✅ test finished");
    expect(run.outbox[0]?.status).toBe("sent");
    expect(run.deliveries[0]?.transport).toBe("typed");
  });

});
