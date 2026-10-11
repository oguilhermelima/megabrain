import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { deliveryComposer } from "../../src/cli/commands/delivery-screen.js";
import { executeDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";
import { stateDatabase, createDispatch, appendMessage } from "../../src/adapters/state-db.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { ok, failed } from "../../src/core/result.js";

const sessionShape = new URL("../fixtures/claude-session-idle.json", import.meta.url);
const screenShape = new URL("../fixtures/orca-terminal-screen-claude-idle.json", import.meta.url);

function processFor(screen: string, onScreenRead?: (read: number) => Promise<void> | void) {
  const calls: { command: string; args: readonly string[] }[] = [];
  let screenReads = 0;
  const process: ProcessAdapter = {
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command === "orca" && args[0] === "terminal" && args[1] === "list") {
        return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "parent-terminal" }] }), stderr: "", exitCode: 0 });
      }
      if (command === "orca" && args[0] === "terminal" && args[1] === "read") {
        screenReads += 1;
        await onScreenRead?.(screenReads);
        return ok<ProcessOutput>({ stdout: screen, stderr: "", exitCode: 0 });
      }
      if (command === "orca" && args[0] === "terminal" && args[1] === "send") {
        return ok<ProcessOutput>({ stdout: "{}", stderr: "", exitCode: 0 });
      }
      return failed(`unexpected command: ${command} ${args.join(" ")}`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
  return { process, calls };
}

async function setupWorker(home: string, session: Record<string, unknown>, metaOverrides: Record<string, unknown> = {}) {
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
  const appended = appendMessage(db.value, dispatchId, { from: "child", type: "done", text: "finished" }, {
    outbox: {
      id: "parent-pointer-test",
      targetKind: "parent-pointer",
      target: "orca:parent-terminal",
      payload: {
        dispatchId,
        sequence: 1,
        meta: metadata,
        pointer: "megabrain check",
        fullMessage: "✅ Claude · test finished — The task is complete.",
      },
    },
  });
  if (appended.kind !== "ok") throw new Error(appended.error);
  return { dispatchId, outboxId: "parent-pointer-test" };
}

async function runWorker(home: string, ids: { dispatchId: string; outboxId: string }, process: ProcessAdapter, deadlineMs = 100) {
  const now = Date.now();
  return executeDeliveryWorker(
    [ids.outboxId, "holder", "delivery-target:orca:parent-terminal", String(now + deadlineMs)],
    { HOME: home, MEGABRAIN_STATE_DIR: home },
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

  test("does not type when the Claude session turns busy during the send preflight", async () => {
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
      expect(fake.calls.some((call) => call.args[1] === "send")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
