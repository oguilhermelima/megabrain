import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { deliveryComposer } from "../../src/cli/commands/delivery-screen.js";
import { stateDatabase, createDispatch, appendMessage, listDeliveries } from "../../src/adapters/state-db.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { ok, failed } from "../../src/core/result.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";
import { startStateOwner, stopStateOwner } from "../../src/db/state-owner.js";

const sessionShape = new URL("../fixtures/claude-session-idle.json", import.meta.url);
const screenShape = new URL("../fixtures/orca-terminal-screen-claude-idle.json", import.meta.url);

function processFor(screen: string, onScreenRead?: (read: number, current: string) => Promise<string | void> | string | void, afterSend?: (current: string) => string, foregroundAgent = "claude") {
  const calls: { command: string; args: readonly string[] }[] = [];
  let screenReads = 0;
  let currentScreen = screen;
  const process: ProcessAdapter = {
    async run(command, args) {
      if (command === "ps" && args[0] === "-ww") {
        const pid = args[2] ?? "0";
        return ok<ProcessOutput>({ stdout: `${pid} ${pid} ${pid} /usr/local/bin/${foregroundAgent}\n`, stderr: "", exitCode: 0 });
      }
      const isSubmitOnly = command === "orca" && args[0] === "terminal" && args[1] === "send" && args.includes("--enter") && (args[args.indexOf("--text") + 1] ?? "") === "";
      if (!isSubmitOnly) calls.push({ command, args: [...args] });
      if (command === "orca" && args[0] === "terminal" && args[1] === "list") {
        return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "parent-terminal" }] }), stderr: "", exitCode: 0 });
      }
      if (command === "orca" && args[0] === "terminal" && args[1] === "read") {
        screenReads += 1;
        const next = await onScreenRead?.(screenReads, currentScreen);
        if (next !== undefined) currentScreen = next;
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
        if (args.includes("--enter")) {
          const value = JSON.parse(currentScreen) as { result: { terminal: { tail: string[] } } };
          value.result.terminal.tail = value.result.terminal.tail.map((line) => line.startsWith("❯") ? "❯" : line);
          currentScreen = JSON.stringify(value);
          if (afterSend !== undefined) currentScreen = afterSend(currentScreen);
        }
        return ok<ProcessOutput>({ stdout: "{}", stderr: "", exitCode: 0 });
      }
      return failed(`unexpected command: ${command} ${args.join(" ")}`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
  return { process, calls, readCount: () => screenReads };
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
  const owner = await startStateOwner(home, process, { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_DELIVERY_TIMEOUT_MS: String(deadlineMs), ...extraEnvironment });
  try {
    const deadline = Date.now() + deadlineMs + 3_000;
    while (Date.now() < deadline) {
      const deliveries = listDeliveries(owner.handle, ids.dispatchId);
      const delivery = deliveries.kind === "ok" ? deliveries.value[0] : undefined;
      if (delivery?.transport !== null && delivery?.transport !== undefined) return ok(`delivery ${delivery.transport}\n`);
      if (owner.pendingDeliveries.size > 0) await Promise.all([...owner.pendingDeliveries]);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return ok("delivery pending\n");
  } finally { await stopStateOwner(owner); }
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

  test("sends an empty-composer notice together with Enter without a read-back gate", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-submit-once-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    session.pid = 31419;
    await fs.writeFile(path.join(sessions, "31419.json"), JSON.stringify(session));
    const ids = await setupWorker(root, session);
    const fake = processFor(await fs.readFile(screenShape, "utf8"));
    try {
      await runWorker(root, ids, fake.process);
      const sends = fake.calls.filter((call) => call.command === "orca" && call.args[0] === "terminal" && call.args[1] === "send");
      expect(sends).toHaveLength(1);
      expect(sends[0]?.args).toContain("--enter");
      const textIndex = sends[0]?.args.indexOf("--text") ?? -1;
      expect(sends[0]?.args[textIndex + 1]).toStartWith("✅ Claude · test finished — The task is complete.");
      expect(sends[0]?.args[textIndex + 1]).toContain("After reading, acknowledge with: megabrain orchestrate ack");
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
      const result = await runWorker(root, ids, fake.process, 2000);
      expect(result).toMatchObject({ kind: "ok", value: "delivery typed\n" });
      expect(fake.calls.filter((call) => call.args[1] === "send")).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("submits a parent notice when the composer cannot be parsed", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-unreadable-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    session.pid = 41236;
    await fs.writeFile(path.join(sessions, "41236.json"), JSON.stringify(session));
    const ids = await setupWorker(root, session);
    const frame = JSON.parse(await fs.readFile(screenShape, "utf8")) as { result: { terminal: { tail: string[] } } };
    frame.result.terminal.tail = ["screen loaded, composer not recognized"];
    const fake = processFor(JSON.stringify(frame));
    try {
      await runWorker(root, ids, fake.process, 2000);
      expect(fake.calls.filter((call) => call.args[1] === "send")).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("delivers to a busy Codex parent when the composer is empty", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-codex-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    session.pid = 41235;
    await fs.writeFile(path.join(sessions, "41235.json"), JSON.stringify(session));
    const ids = await setupWorker(root, session, { parentAgent: "codex", parentAgentPid: session.pid, parentAgentSessionId: undefined });
    const screen = JSON.stringify({ result: { terminal: { tail: ["Working (1s)", "esc to interrupt", "› Ask Codex to do anything"] } } });
    const fake = processFor(screen, undefined, undefined, "codex");
    try {
      const result = await runWorker(root, ids, fake.process, 2000);
      expect(result).toMatchObject({ kind: "ok", value: "delivery typed\n" });
      expect(fake.calls.filter((call) => call.args[1] === "send")).toHaveLength(1);
      const opened = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
      if (opened.kind !== "ok") throw new Error(opened.error);
      try { expect(listDeliveries(opened.value, ids.dispatchId)).toMatchObject({ value: [{ transport: "typed" }] }); }
      finally { opened.value.close(); }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("delivers to a busy parent immediately despite foreign composer text", async () => {
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
          return ok<ProcessOutput>({ stdout: response("human text"), stderr: "", exitCode: 0 });
        }
        return fake.process.run(command, args);
      },
    };
    try {
      await runWorker(root, ids, dynamic, 2500);
      expect(reads).toBeLessThan(6);
      expect(fake.calls.filter((call) => call.args[1] === "send")).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("delivers immediately while a permission dialog is on screen", async () => {
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
      expect(fake.calls.filter((call) => call.args[1] === "send")).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("delivers immediately when a permission dialog has an empty-looking composer", async () => {
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
      expect(fake.calls.filter((call) => call.args[1] === "send")).toHaveLength(1);
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

  test("records bounded Orca composer read-back after submit without withholding the notice", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-parent-race-"));
    const sessions = path.join(root, ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    const session = JSON.parse(await fs.readFile(sessionShape, "utf8")) as Record<string, unknown>;
    session.pid = 31417;
    await fs.writeFile(path.join(sessions, "31417.json"), JSON.stringify(session));
    const ids = await setupWorker(root, session);
    const response = await fs.readFile(screenShape, "utf8");
    const fake = processFor(response, undefined, (current) => {
      const value = JSON.parse(current) as { result: { terminal: Record<string, unknown> } };
      value.result.terminal.draft = "r".repeat(400);
      return JSON.stringify(value);
    });
    const logPath = path.join(root, "delivery-decisions.jsonl");
    try {
      await runWorker(root, ids, fake.process);
      const decisions = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(decisions.at(-1)).toMatchObject({
        decision: "send",
        composerReadback: {
          region: "r".repeat(300),
          orcaDraft: "r".repeat(300),
        },
      });
      const readback = decisions.at(-1)?.composerReadback as { region: string; orcaDraft: string };
      expect(readback.region.length).toBeLessThanOrEqual(300);
      expect(readback.orcaDraft.length).toBeLessThanOrEqual(300);
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

  test("tries to send immediately when the screen is unavailable", async () => {
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
        if (command === "ps" && args[0] === "-ww") return ok<ProcessOutput>({ stdout: "14142 14142 14142 /opt/claude/bin/claude --resume parent\n", stderr: "", exitCode: 0 });
        if (command === "orca" && args[1] === "list") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "parent-terminal" }] }), stderr: "", exitCode: 0 });
        return failed("orca terminal read broke");
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return calls.length; },
    };
    const started = Date.now();
    try {
      await runWorker(root, ids, broken, 300, { MEGABRAIN_PROOF_UNAVAILABLE_MS: "200" });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(calls.some((call) => call[2] === "send")).toBe(true);
      const decisions = (await fs.readFile(path.join(root, "delivery-decisions.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(decisions[0]).toMatchObject({ proofSource: "claude-session", proofReason: expect.stringContaining("orca terminal read broke") });
      const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
      if (db.kind !== "ok") throw new Error(db.error);
      const deliveries = listDeliveries(db.value, ids.dispatchId);
      if (deliveries.kind !== "ok") throw new Error(deliveries.error);
      expect(deliveries.value[0]).toMatchObject({ transport: "failed" });
      expect(decisions.some((decision: { decision?: string }) => decision.decision === "send-failed")).toBe(true);
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
      pasteText: async (_pane, text) => {
        typed.push(text);
        captured = `────────────────────────────────────────────────────────────\n❯ ${text.replace(/\n/g, "\n  ")}\n────────────────────────────────────────────────────────────\n`;
        return ok(undefined);
      },
      sendKey: async (_pane, key) => {
        keys.push(key);
        if (key === "Enter") captured = `────────────────────────────────────────────────────────────\n❯\n────────────────────────────────────────────────────────────\n`;
        return ok(undefined);
      },
    });
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "ps" && args[0] === "-ww") return ok<ProcessOutput>({ stdout: "45678 45678 45678 /opt/claude/bin/claude --resume parent\n", stderr: "", exitCode: 0 });
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
