import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { deliveryComposer } from "../../src/cli/commands/delivery-screen.js";
import { executeDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";
import { stateDatabase, createDispatch, appendMessage, listDeliveries } from "../../src/adapters/state-db.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { ok, failed } from "../../src/core/result.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";

const sessionShape = new URL("../fixtures/claude-session-idle.json", import.meta.url);
const screenShape = new URL("../fixtures/orca-terminal-screen-claude-idle.json", import.meta.url);

function processFor(screen: string, onScreenRead?: (read: number) => Promise<void> | void) {
  const calls: { command: string; args: readonly string[] }[] = [];
  let screenReads = 0;
  let currentScreen = screen;
  const process: ProcessAdapter = {
    async run(command, args) {
      const isSubmitOnly = command === "orca" && args[0] === "terminal" && args[1] === "send" && args.includes("--enter") && (args[args.indexOf("--text") + 1] ?? "") === "";
      if (!isSubmitOnly) calls.push({ command, args: [...args] });
      if (command === "orca" && args[0] === "terminal" && args[1] === "list") {
        return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "parent-terminal" }] }), stderr: "", exitCode: 0 });
      }
      if (command === "orca" && args[0] === "terminal" && args[1] === "read") {
        screenReads += 1;
        await onScreenRead?.(screenReads);
        return ok<ProcessOutput>({ stdout: currentScreen, stderr: "", exitCode: 0 });
      }
      if (command === "orca" && args[0] === "terminal" && args[1] === "send") {
        const textIndex = args.indexOf("--text");
        const pasted = textIndex < 0 ? "" : args[textIndex + 1] ?? "";
        if (pasted !== "") {
          const value = JSON.parse(currentScreen) as { result: { terminal: { tail: string[] } } };
          value.result.terminal.tail = value.result.terminal.tail.map((line) => line.startsWith("❯") ? `❯ ${pasted}` : line);
          currentScreen = JSON.stringify(value);
        }
        return ok<ProcessOutput>({ stdout: "{}", stderr: "", exitCode: 0 });
      }
      return failed(`unexpected command: ${command} ${args.join(" ")}`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
  return { process, calls };
}

async function setupWorker(home: string, session: Record<string, unknown>, metaOverrides: Record<string, unknown> = {}, payloadMeta?: Record<string, unknown>) {
  const db = stateDatabase({ HOME: home, MEGABRAIN_STATE_DIR: home });
  if (db.kind !== "ok") throw new Error(db.error);
  const dispatchId = "dispatch-parent-gate";
  const metadata = {
    agent: "claude",
    agentPid: 99999,
    agentSessionId: "child-claude-session",
    parentAgent: "claude",
    parentAgentPid: session.pid,
    parentAgentSessionId: session.sessionId,
    parentHost: "orca",
    parentTerminalId: "parent-terminal",
    ...metaOverrides,
  };
  const created = createDispatch(db.value, { dispatchId, state: "running", ...metadata });
  if (created.kind !== "ok") throw new Error(created.error);
  const now = new Date().toISOString();
  const appended = appendMessage(db.value, dispatchId, { from: "child", type: "done", text: "finished" }, {
    delivery: { id: "parent-delivery-test", recipient: "parent", messageSeqs: [], status: "outstanding", createdAt: now, updatedAt: now, acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null },
    outbox: {
      id: "parent-pointer-test",
      targetKind: "parent-pointer",
      target: "orca:parent-terminal",
      payload: {
        dispatchId,
        sequence: 1,
        meta: payloadMeta ?? metadata,
        pointer: "megabrain check",
        fullMessage: "✅ Claude · test finished — The task is complete.",
      },
    },
  });
  if (appended.kind !== "ok") throw new Error(appended.error);
  return { dispatchId, outboxId: "parent-pointer-test" };
}

async function runWorker(home: string, ids: { dispatchId: string; outboxId: string }, process: ProcessAdapter, deadlineMs = 100, extraEnvironment: Record<string, string> = {}) {
  const now = Date.now();
  return executeDeliveryWorker(
    [ids.outboxId, "holder", "delivery-target:orca:parent-terminal", String(now + deadlineMs)],
    { HOME: home, MEGABRAIN_STATE_DIR: home, ...extraEnvironment },
    process,
  );
}

describe("Claude parent idle delivery", () => {
  test("recognizes the captured Claude placeholder as an empty composer", async () => {
    const response = await readFile(screenShape, "utf8");
    const screen = JSON.parse(response).result.terminal.tail.join("\n") as string;
    expect(deliveryComposer("claude", screen)).toBe("");
  });

  test("delivers to an idle Claude parent on the first attempt using its session pid", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    const pid = 31415;
    session.pid = pid;
    await fs.writeFile(path.join(sessions, `${pid}.json`), JSON.stringify(session));
    const ids = await setupWorker(root, session);
    const response = await fs.readFile(screenShape, "utf8");
    const fake = processFor(response);
    try {
      await runWorker(root, ids, fake.process);
      expect(fake.calls.some((call) => call.args[1] === "send")).toBe(true);
      expect(fake.calls.filter((call) => call.args[1] === "send")).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("delivers to a busy Claude parent when the composer is empty", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    session.pid = 41234;
    session.status = "busy";
    session.statusUpdatedAt = Number(session.statusUpdatedAt) + 1;
    await fs.writeFile(path.join(sessions, "41234.json"), JSON.stringify(session));
    const ids = await setupWorker(root, session);
    const screenValue = JSON.parse(await fs.readFile(screenShape, "utf8")) as { result: { terminal: { tail: string[] } } };
    const empty = JSON.stringify({ ...screenValue, result: { terminal: { ...screenValue.result.terminal, tail: screenValue.result.terminal.tail.map((line) => line.startsWith("❯") ? "❯" : line) } } });
    const fake = processFor(empty);
    try {
      await runWorker(root, ids, fake.process, 2000);
      expect(fake.calls.filter((call) => call.args[1] === "send")).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("holds a human composer draft and delivers after it clears while Claude is busy", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    session.pid = 42345;
    session.status = "busy";
    session.statusUpdatedAt = Number(session.statusUpdatedAt) + 1;
    await fs.writeFile(path.join(sessions, "42345.json"), JSON.stringify(session));
    const ids = await setupWorker(root, session);
    const value = JSON.parse(await fs.readFile(screenShape, "utf8")) as { result: { terminal: { tail: string[] } } };
    let reads = 0;
    const fake = processFor("", async () => { reads += 1; });
    const response = (draft: string) => JSON.stringify({ ...value, result: { terminal: { ...value.result.terminal, tail: value.result.terminal.tail.map((line) => line.startsWith("❯") ? `❯ ${draft}` : line) } } });
    // Replace only screen responses so the first probe sees a human draft and later probes see an empty composer.
    const dynamic: ProcessAdapter = {
      ...fake.process,
      async run(command, args) {
        if (command === "orca" && args[0] === "terminal" && args[1] === "read") {
          reads += 1;
          return ok<ProcessOutput>({ stdout: response(reads < 3 ? "human text" : ""), stderr: "", exitCode: 0 });
        }
        return fake.process.run(command, args);
      },
    };
    try {
      await runWorker(root, ids, dynamic, 2500);
      expect(reads).toBeGreaterThanOrEqual(3);
      expect(fake.calls.filter((call) => call.args[1] === "send")).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("holds delivery while a permission dialog is on screen", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    session.pid = 43456;
    session.status = "busy";
    await fs.writeFile(path.join(sessions, "43456.json"), JSON.stringify(session));
    const ids = await setupWorker(root, session);
    const fixture = JSON.parse(await fs.readFile(screenShape, "utf8")) as { result: { terminal: { tail: string[] } } };
    const dialog = JSON.stringify({ ...fixture, result: { terminal: { ...fixture.result.terminal, tail: [...fixture.result.terminal.tail, "Allow this action?", "1. Yes", "2. No"] } } });
    const fake = processFor(dialog);
    try {
      await runWorker(root, ids, fake.process, 100);
      expect(fake.calls.some((call) => call.args[1] === "send")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("holds delivery when a permission dialog has an empty-looking composer", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    session.pid = 44567;
    await fs.writeFile(path.join(sessions, "44567.json"), JSON.stringify(session));
    const ids = await setupWorker(root, session);
    const fixture = JSON.parse(await fs.readFile(screenShape, "utf8")) as { result: { terminal: { tail: string[] } } };
    const dialog = JSON.stringify({ ...fixture, result: { terminal: { ...fixture.result.terminal, tail: [...fixture.result.terminal.tail, "Allow this action?", "1. Yes", "2. No"] } } });
    const fake = processFor(dialog);
    try {
      await runWorker(root, ids, fake.process, 100);
      expect(fake.calls.some((call) => call.args[1] === "send")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("logs the proof, composer, and decision for each delivery attempt", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    const pid = 31416;
    session.pid = pid;
    await fs.writeFile(path.join(sessions, `${pid}.json`), JSON.stringify(session));
    const ids = await setupWorker(root, session);
    const response = await fs.readFile(screenShape, "utf8");
    const fake = processFor(response);
    const logPath = path.join(root, "delivery-decisions.jsonl");
    try {
      await runWorker(root, ids, fake.process);
      expect(existsSync(logPath)).toBe(true);
      const decisions = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0]).toMatchObject({ proofSource: "claude-session", status: "idle", composer: "empty" });
      expect(decisions.at(-1)).toMatchObject({ decision: "send" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("types when the Claude session turns busy during the send preflight if the composer stays empty", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    const pid = 27182;
    session.pid = pid;
    await fs.writeFile(path.join(sessions, `${pid}.json`), JSON.stringify(session));
    const ids = await setupWorker(root, session);
    const response = await fs.readFile(screenShape, "utf8");
    const sessionFile = path.join(sessions, `${pid}.json`);
    const screenValue = JSON.parse(response) as { result: { terminal: { tail: string[] } } };
    const idleScreen = JSON.stringify({ ...screenValue, result: { terminal: { ...screenValue.result.terminal, tail: screenValue.result.terminal.tail.map((line) => line.startsWith("❯") ? "❯" : line) } } });
    const fake = processFor(idleScreen, async (read) => {
      if (read === 5) await fs.writeFile(sessionFile, JSON.stringify({ ...session, status: "busy", statusUpdatedAt: Number(session.statusUpdatedAt) + 1 }));
    });
    try {
      await runWorker(root, ids, fake.process);
      expect(fake.calls.some((call) => call.args[1] === "send")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("loads the parent proof from the dispatch record when the payload snapshot has no parent fields", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    const pid = 16180;
    session.pid = pid;
    await fs.writeFile(path.join(sessions, `${pid}.json`), JSON.stringify(session));
    const ids = await setupWorker(root, session, {}, { agent: "claude", agentPid: 99999 });
    const fake = processFor(await fs.readFile(screenShape, "utf8"));
    try {
      await runWorker(root, ids, fake.process);
      expect(fake.calls.filter((call) => call.args[1] === "send")).toHaveLength(1);
      const decisions = (await fs.readFile(path.join(root, "delivery-decisions.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(decisions.at(-1)).toMatchObject({ proofSource: "claude-session", decision: "send" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("stops waiting after the screen stays unavailable, records why, and never types", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    const pid = 14142;
    session.pid = pid;
    await fs.writeFile(path.join(sessions, `${pid}.json`), JSON.stringify(session));
    const ids = await setupWorker(root, session);
    const calls: string[][] = [];
    const broken: ProcessAdapter = {
      async run(command, args) {
        calls.push([command, ...args]);
        if (command === "orca" && args[1] === "list") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "parent-terminal" }] }), stderr: "", exitCode: 0 });
        return failed("orca terminal read broke");
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return calls.length; },
    };
    const started = Date.now();
    try {
      await runWorker(root, ids, broken, 8000, { MEGABRAIN_PROOF_UNAVAILABLE_MS: "200" });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(calls.some((call) => call[2] === "send")).toBe(false);
      const decisions = (await fs.readFile(path.join(root, "delivery-decisions.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(decisions[0]).toMatchObject({ proofSource: "claude-session", proofReason: expect.stringContaining("orca terminal read broke") });
      const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
      if (db.kind !== "ok") throw new Error(db.error);
      const deliveries = listDeliveries(db.value, ids.dispatchId);
      if (deliveries.kind !== "ok") throw new Error(deliveries.error);
      expect(deliveries.value[0]).toMatchObject({ transport: "failed", transportReason: "proof-unavailable" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("tmux parent composer suggestion", () => {
  test("delivers when the only composer text is a dim suggestion", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-tmux-ghost-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    session.pid = 45678;
    await fs.writeFile(path.join(sessions, "45678.json"), JSON.stringify(session));
    const ids = await setupWorker(root, session, { parentHost: "tmux", parentTmuxSession: "private", parentTmuxPane: "%1" });
    const original = getTmux();
    let captured = await fs.readFile(new URL("../fixtures/tmux-capture-claude-ghost.txt", import.meta.url), "utf8");
    const typed: string[] = [];
    const keys: string[] = [];
    registerTmux({
      ...original,
      sessionExists: async () => ok(true),
      panesForSession: async () => ok(["%1"]),
      panePid: async () => ok("45678"),
      capturePane: async () => ok(captured),
      sendText: async (_pane, text) => {
        typed.push(text);
        captured = `────────────────────────────────────────────────────────────\n❯ ${text.replace(/\n/g, "\n  ")}\n────────────────────────────────────────────────────────────\n`;
        return ok(undefined);
      },
      sendKey: async (_pane, key) => { keys.push(key); return ok(undefined); },
    });
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "ps" && args[0] === "-p") return ok<ProcessOutput>({ stdout: "ttys001\n", stderr: "", exitCode: 0 });
        if (command === "ps") return ok<ProcessOutput>({ stdout: "45678 1 claude MEGABRAIN_DISPATCH_ID=dispatch-parent-gate\n", stderr: "", exitCode: 0 });
        return failed(`unexpected command: ${command} ${args.join(" ")}`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 0; },
    };
    try {
      await runWorker(root, ids, process);
      expect(typed).toHaveLength(1);
      expect(keys).toEqual(["Enter"]);
    } finally {
      registerTmux(original);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
