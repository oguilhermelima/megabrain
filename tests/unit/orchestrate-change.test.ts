import { guardedStateDatabase } from "./state-db-guard.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { executeOrchestrateChange } from "../../src/cli/commands/orchestrate-reply.js";
import { createDispatch, getDispatch, listMessages, listOutbox, listDeliveries } from "../../src/adapters/state-db.js";
import { getTmux, registerTmux, unregisterTmux } from "../../src/hosts/tmux.js";
import { getHost, registerHost } from "../../src/hosts/index.js";
import type { HostProvider } from "../../src/hosts/types.js";
import { executeOrchestrateStop } from "../../src/cli/commands/orchestrate-stop-reconcile.js";

type JsonRecord = Record<string, unknown>;

const codexIdle = "› Ask Codex to do anything";
// Real Codex paints the empty-composer placeholder dim (SGR 2); frame measured 2026-10-11 after an interrupt.
const interruptedCodex = [
  "\x1b[2m■ Conversation interrupted - use /feedback if something went wrong\x1b[0m",
  "                                       ⚠ 5h limit: 11% left · resets at 18:49 · /status",
  "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m",
  "",
  "  GPT-6-Luna high · Context 68% left · weekly 59% left · 5h 11% left",
  "  ? for shortcuts                                              ⚠ 3 warnings · f2 to view",
].join("\n");
const codexWorking = "• Working (1s • esc to interrupt)\n› Ask Codex to do anything";
const direction = "Use the existing parser, preserve the current behavior, and update the docs.";
const formatted = `🔀 codex · megabrain/main new direction\nStop the approach you were on and follow this instead:\n${direction}\n(The same text is available with megabrain check.)`;

function requireOk<T>(result: Result<T>): T {
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value;
}

async function tempStateDir(): Promise<string> {
  return mkdtemp(`${tmpdir()}/megabrain-change-`);
}

function meta(overrides: JsonRecord = {}): JsonRecord {
  const now = new Date().toISOString();
  return {
    dispatchId: "change",
    state: "running",
    parentHost: "orca",
    parentSessionId: "parent-terminal",
    childHost: "orca",
    workspaceId: null,
    terminalId: "child-terminal",
    worktreePath: "/tmp/worktree",
    branch: "feat/example",
    chatName: "feat/example",
    parentAgent: "codex",
    parentChatName: "megabrain/main",
    agent: "codex",
    agentId: "codex",
    agentPid: 999,
    runtime: "tmux",
    tmuxSession: "child-session",
    tmuxPane: "%2",
    processState: "running",
    terminalState: "owned",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function writeDispatch(root: string, overrides: JsonRecord = {}): Promise<void> {
  const db = requireOk(guardedStateDatabase({ MEGABRAIN_STATE_DIR: root }));
  requireOk(createDispatch(db, meta(overrides)));
}

function environment(root: string, overrides: Record<string, string> = {}): Record<string, string> {
  return { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "parent-terminal", ...overrides };
}

function processAdapter(): ProcessAdapter {
  return {
    async run(command, args) {
      if (command === "ps" && args[0] === "-ww") return ok({ stdout: "999 999 999 /usr/local/bin/codex --resume child\n", stderr: "", exitCode: 0 });
      if (command === "ps" && args[0] === "-p") return ok({ stdout: "pts/7\n", stderr: "", exitCode: 0 });
      if (command === "ps" && args[0] === "eww") return ok({ stdout: "999 1 child MEGABRAIN_DISPATCH_ID=change\n", stderr: "", exitCode: 0 });
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    },
    async startDetached() { return ok({ pid: 1 }); },
    invocationCount() { return 0; },
  };
}

type HarnessOptions = Readonly<{
  readonly idleAfterInterrupt?: number;
  readonly alwaysBusy?: boolean;
  readonly idleAfterDelivery?: boolean;
  readonly initialComposer?: string;
}>;

function installTmux(options: HarnessOptions = {}) {
  const original = getTmux();
  const events: string[] = [];
  let interrupts = 0;
  let delivered = false;
  registerTmux({
    ...original,
    sessionExists: async () => ok(true),
    panesForSession: async () => ok(["%2"]),
    panePid: async () => ok("999"),
    capturePane: async () => {
      if (delivered) return ok(options.idleAfterDelivery ? codexIdle : codexWorking);
      if (options.initialComposer !== undefined) return ok(options.initialComposer);
      if (options.alwaysBusy || interrupts < (options.idleAfterInterrupt ?? 1)) return ok(codexWorking);
      return ok(codexIdle);
    },
    sendKey: async (_pane, key) => {
      events.push(`key:${key}`);
      if (key === "Escape") interrupts += 1;
      if (key === "Tab" || key === "Enter") delivered = true;
      return ok(undefined);
    },
    pasteText: async (_pane, text) => { events.push(`text:${text}`); return ok(undefined); },
    sendText: async (_pane, text) => {
      events.push(`text:${text}`);
      return ok(undefined);
    },
  });
  return { events, restore: () => registerTmux(original) };
}

async function readMessages(root: string): Promise<JsonRecord[]> {
  const db = requireOk(guardedStateDatabase({ MEGABRAIN_STATE_DIR: root }));
  return requireOk(listMessages(db, "change")) as JsonRecord[];
}

function installOrcaHost(processCalls: string[]) {
  const original = getHost("orca") as HostProvider;
  const host: HostProvider = {
    ...original,
    list: () => ok({ command: "orca", args: ["terminal", "list", "--json"] }),
    read: ({ terminalId }) => ok({ command: "orca", args: ["terminal", "read", "--terminal", terminalId, "--screen", "--json"] }),
    send: ({ terminalId, text, interrupt, enter = true }) => ok({
      command: "orca",
      args: ["terminal", "send", "--terminal", terminalId, ...(interrupt ? ["--interrupt"] : ["--text", text ?? "", ...(enter ? ["--enter"] : [])]), "--json"],
    }),
  };
  registerHost(host);
  return () => registerHost(original);
}

afterEach(() => {
  unregisterTmux("tmux");
  registerTmux(getTmux());
});

describe("orchestrate change delivery", () => {
  test("interrupts a busy child once and delivers without waiting for idle", async () => {
    const root = await tempStateDir();
    const harness = installTmux({ alwaysBusy: true });
    try {
      await writeDispatch(root);
      const result = await executeOrchestrateChange(["change", "--text", direction, "--idle-timeout", "1", "--attempts", "1", "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      const output = result.kind === "ok" ? JSON.parse(result.value) as JsonRecord : {};
      expect(output).toMatchObject({ attempts: 1, idleReached: false, delivered: true, confirmed: true });
      expect(harness.events[0]).toBe("key:Escape");
      expect(harness.events[1]).toStartWith(`text:${formatted}`);
      expect(harness.events[1]).toContain("acknowledge with: megabrain ack");
      expect(harness.events[2]).toBe("key:Enter");
    } finally {
      harness.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("interrupts once before delivering into an empty idle composer", async () => {
    const root = await tempStateDir();
    const harness = installTmux();
    try {
      await writeDispatch(root);
      const result = await executeOrchestrateChange(["change", "--text", direction, "--idle-timeout", "2", "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      const output = result.kind === "ok" ? JSON.parse(result.value) as JsonRecord : {};
      expect(output).toMatchObject({ attempts: 1, idleReached: false, delivered: true, confirmed: true, supersededQueued: 0, supersededDelivered: 0 });
      expect(harness.events[0]).toBe("key:Escape");
      expect(harness.events[1]).toStartWith(`text:${formatted}`);
      expect(harness.events[1]).toContain("acknowledge with: megabrain ack");
      expect(harness.events[2]).toBe("key:Enter");
      const messages = await readMessages(root);
      expect(messages.map((message) => message.type)).toEqual(["reply", "composer-clear", "delivery-result", "delivery-confirmation"]);
      expect((messages[0] as JsonRecord).text).toBe(direction);
    } finally {
      harness.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("submits the change immediately over foreign composer text", async () => {
    const root = await tempStateDir();
    const harness = installTmux({ initialComposer: `${codexWorking}\n› operator draft` });
    try {
      await writeDispatch(root);
      const result = await executeOrchestrateChange(["change", "--text", direction, "--idle-timeout", "2", "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ attempts: 1, idleReached: false, delivered: true });
      const db = requireOk(guardedStateDatabase({ MEGABRAIN_STATE_DIR: root }));
      expect(requireOk(listOutbox(db))).toMatchObject([{ status: "sent" }]);
      expect(requireOk(listDeliveries(db, "change"))[0]).toMatchObject({ transport: "typed" });
      expect(harness.events[0]).toBe("key:Escape");
      expect(harness.events[1]).toStartWith(`text:${formatted}`);
      expect(harness.events[1]).toContain("acknowledge with: megabrain ack");
      expect(harness.events[2]).toBe("key:Enter");
    } finally {
      harness.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("interrupts once and delivers to a busy child immediately", async () => {
    const root = await tempStateDir();
    const harness = installTmux({ idleAfterInterrupt: 2 });
    try {
      await writeDispatch(root);
      const result = await executeOrchestrateChange(["change", "--text", direction, "--idle-timeout", "2", "--attempts", "3", "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ attempts: 1, idleReached: false, delivered: true });
      expect(harness.events[0]).toBe("key:Escape");
      expect(harness.events[1]).toStartWith(`text:${formatted}`);
      expect(harness.events[1]).toContain("acknowledge with: megabrain ack");
      expect(harness.events[2]).toBe("key:Enter");
    } finally {
      harness.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("submits a direction immediately while foreign text remains in the composer", async () => {
    const root = await tempStateDir();
    const harness = installTmux({ alwaysBusy: true, initialComposer: `${codexWorking}\n› operator draft` });
    try {
      await writeDispatch(root);
      const result = await executeOrchestrateChange(["change", "--text", direction, "--idle-timeout", "1", "--attempts", "3", "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ attempts: 1, idleReached: false, delivered: true });
      expect(harness.events.filter((event) => event === "key:Escape")).toHaveLength(1);
      expect(harness.events.some((event) => event.startsWith(`text:${formatted}`) && event.includes("acknowledge with: megabrain ack"))).toBe(true);
      expect((await readMessages(root)).map((message) => message.type)).toEqual(["reply", "composer-clear", "delivery-result", "delivery-confirmation"]);
      const db = requireOk(guardedStateDatabase({ MEGABRAIN_STATE_DIR: root }));
      expect(requireOk(listOutbox(db))).toMatchObject([{ status: "sent" }]);
      expect(requireOk(listDeliveries(db, "change"))[0]).toMatchObject({ transport: "typed" });
    } finally {
      harness.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sends a check pointer for directions over the tmux byte limit", async () => {
    const root = await tempStateDir();
    const harness = installTmux();
    const large = "é".repeat(6001);
    try {
      await writeDispatch(root);
      const result = await executeOrchestrateChange(["change", "--text", large, "--idle-timeout", "2", "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ delivered: true, oversized: true });
      expect(harness.events.some((event) => event.startsWith("text:🔀 codex · megabrain/main new direction\nA new direction is queued; run megabrain check to read it.") && event.includes("acknowledge with: megabrain ack"))).toBe(true);
      expect(harness.events.some((event) => event.includes(large))).toBe(false);
    } finally {
      harness.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("delivers through Superset even though it cannot interrupt", async () => {
    const root = await tempStateDir();
    try {
      await writeDispatch(root, { runtime: "host", childHost: "superset", workspaceId: "workspace", terminalId: "child-terminal" });
      const result = await executeOrchestrateChange(["change", "--text", direction, "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ attempts: 1, idleReached: false, delivered: true });
      expect((await readMessages(root))[0]).toMatchObject({ type: "reply", text: direction });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("interrupts a busy Orca terminal once and sends the full direction", async () => {
    const root = await tempStateDir();
    const calls: string[] = [];
    const restoreHost = installOrcaHost(calls);
    let screenReads = 0;
    const fakeProcess: ProcessAdapter = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "ps" && args[0] === "-ww") return ok({ stdout: "999 999 999 /usr/local/bin/codex --resume child\n", stderr: "", exitCode: 0 });
        if (command === "orca" && args[1] === "list") return ok({ stdout: JSON.stringify({ result: { terminals: [{ handle: "child-terminal" }] } }), stderr: "", exitCode: 0 });
        if (command === "orca" && args[1] === "read") {
          screenReads += 1;
          const tail = screenReads === 1 ? codexWorking : codexIdle;
          return ok({ stdout: JSON.stringify({ result: { terminal: { tail: [tail] } } }), stderr: "", exitCode: 0 });
        }
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      },
      async startDetached() { return ok({ pid: 1 }); },
      invocationCount() { return calls.length; },
    };
    try {
      await writeDispatch(root, { runtime: "host", tmuxSession: null, tmuxPane: null });
      const result = await executeOrchestrateChange(["change", "--text", direction, "--idle-timeout", "2", "--json"], environment(root), fakeProcess);
      expect(result.kind).toBe("ok");
      expect(calls.filter((call) => call.includes("\u001b"))).toHaveLength(1);
      expect(calls.some((call) => call.includes("--interrupt"))).toBe(false);
      expect(calls.some((call) => call.includes("--screen"))).toBe(true);
      expect(calls.some((call) => call.includes("\u0015"))).toBe(false);
      expect(calls.some((call) => call.includes(direction))).toBe(true);
    } finally {
      restoreHost();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports delivered and confirmed independently", async () => {
    const root = await tempStateDir();
    const harness = installTmux({ idleAfterDelivery: true });
    try {
      await writeDispatch(root);
      const result = await executeOrchestrateChange(["change", "--text", direction, "--idle-timeout", "2", "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ delivered: true, confirmed: false });
    } finally {
      harness.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("interrupts once before delivering into the dim Codex placeholder", async () => {
    const root = await tempStateDir();
    const harness = installTmux({ initialComposer: interruptedCodex });
    try {
      await writeDispatch(root);
      const result = await executeOrchestrateChange(["change", "--text", direction, "--idle-timeout", "2", "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ attempts: 1, idleReached: false, delivered: true });
      expect(harness.events[0]).toBe("key:Escape");
      expect(harness.events[1]).toStartWith(`text:${formatted}`);
      expect(harness.events[1]).toContain("acknowledge with: megabrain ack");
      expect(harness.events[2]).toBe("key:Enter");
    } finally {
      harness.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stop and the idle proof agree: the interrupted frame is idle, a Working frame is busy", async () => {
    const root = await tempStateDir();
    let frame = interruptedCodex;
    const original = getTmux();
    registerTmux({ ...original, sessionExists: async () => ok(true), panesForSession: async () => ok(["%2"]), panePid: async () => ok("999"), capturePane: async () => ok(frame), sendKey: async () => ok(undefined) });
    try {
      await writeDispatch(root);
      const idle = await executeOrchestrateStop(["change", "--json"], environment(root), processAdapter());
      expect(idle.kind).toBe("failed");
      expect(idle.kind === "failed" ? idle.error : "").toContain("empty Codex composer");
      frame = `${codexWorking}\n\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m`;
      const busy = await executeOrchestrateStop(["change", "--json"], environment(root), processAdapter());
      expect(busy.kind).toBe("ok");
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });
});
