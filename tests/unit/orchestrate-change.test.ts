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

type JsonRecord = Record<string, unknown>;

const codexIdle = "› Ask Codex to do anything";
const codexWorking = "• Working (1s • esc to interrupt)";
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
      if (options.alwaysBusy || interrupts < (options.idleAfterInterrupt ?? 1)) return ok(codexWorking);
      return ok(options.initialComposer ?? codexIdle);
    },
    sendKey: async (_pane, key) => {
      events.push(`key:${key}`);
      if (key === "Escape") interrupts += 1;
      if (key === "Tab" || key === "Enter") delivered = true;
      return ok(undefined);
    },
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
  test("interrupts once, waits for stable idle, and types only into the empty composer", async () => {
    const root = await tempStateDir();
    const harness = installTmux();
    try {
      await writeDispatch(root);
      const result = await executeOrchestrateChange(["change", "--text", direction, "--idle-timeout", "2", "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      const output = result.kind === "ok" ? JSON.parse(result.value) as JsonRecord : {};
      expect(output).toMatchObject({ attempts: 1, idleReached: true, delivered: true, confirmed: true, supersededQueued: 0, supersededDelivered: 0 });
      expect(harness.events).toEqual(["key:Escape", `text:${formatted}`, "key:Tab"]);
      const messages = await readMessages(root);
      expect(messages.map((message) => message.type)).toEqual(["reply", "interrupt", "interrupt-result", "idle-result", "composer-clear", "delivery-result", "delivery-confirmation"]);
      expect((messages[0] as JsonRecord).text).toBe(direction);
    } finally {
      harness.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves a foreign composer draft untouched and keeps the change queued", async () => {
    const root = await tempStateDir();
    const harness = installTmux({ initialComposer: `${codexIdle}\n› operator draft` });
    try {
      await writeDispatch(root);
      const result = await executeOrchestrateChange(["change", "--text", direction, "--idle-timeout", "2", "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ idleReached: true, delivered: false, reason: expect.stringContaining("delivery deferred") });
      const db = requireOk(guardedStateDatabase({ MEGABRAIN_STATE_DIR: root }));
      expect(requireOk(listOutbox(db))).toHaveLength(1);
      expect(requireOk(listDeliveries(db, "change"))[0]).toMatchObject({ transport: "deferred" });
      expect(harness.events).toEqual(["key:Escape"]);
    } finally {
      harness.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries the interrupt while busy and sends only after the second idle result", async () => {
    const root = await tempStateDir();
    const harness = installTmux({ idleAfterInterrupt: 2 });
    try {
      await writeDispatch(root);
      const result = await executeOrchestrateChange(["change", "--text", direction, "--idle-timeout", "2", "--attempts", "3", "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ attempts: 2, idleReached: true, delivered: true });
      expect(harness.events.filter((event) => event === "key:Escape")).toHaveLength(2);
      expect(harness.events).not.toContain("key:C-u");
    } finally {
      harness.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails after three interrupts without typing while keeping the change queued", async () => {
    const root = await tempStateDir();
    const harness = installTmux({ alwaysBusy: true });
    try {
      await writeDispatch(root);
      const result = await executeOrchestrateChange(["change", "--text", direction, "--idle-timeout", "1", "--attempts", "3", "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ attempts: 3, idleReached: false, delivered: false, reason: expect.stringContaining("delivery deferred") });
      expect(harness.events.filter((event) => event === "key:Escape")).toHaveLength(3);
      expect(harness.events.some((event) => event.startsWith("text:"))).toBe(false);
      expect((await readMessages(root)).map((message) => message.type)).toEqual(["reply", "interrupt", "interrupt-result", "idle-result", "interrupt", "interrupt-result", "idle-result", "interrupt", "interrupt-result", "idle-result", "delivery-result"]);
      const db = requireOk(guardedStateDatabase({ MEGABRAIN_STATE_DIR: root }));
      expect(requireOk(listOutbox(db))).toHaveLength(1);
      expect(requireOk(listDeliveries(db, "change"))[0]).toMatchObject({ transport: "deferred" });
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
      expect(harness.events).toContain("text:🔀 codex · megabrain/main new direction\nA new direction is queued; run megabrain check to read it.");
      expect(harness.events.some((event) => event.includes(large))).toBe(false);
    } finally {
      harness.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves the Superset interrupt refusal and leaves the direction queued", async () => {
    const root = await tempStateDir();
    try {
      await writeDispatch(root, { runtime: "host", childHost: "superset", workspaceId: "workspace", terminalId: "child-terminal" });
      const result = await executeOrchestrateChange(["change", "--text", direction, "--json"], environment(root), processAdapter());
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ attempts: 0, idleReached: false, delivered: false });
      expect((await readMessages(root))[0]).toMatchObject({ type: "reply", text: direction });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("uses Orca interrupt, screen reads, and submits full direction", async () => {
    const root = await tempStateDir();
    const calls: string[] = [];
    const restoreHost = installOrcaHost(calls);
    let screenReads = 0;
    const fakeProcess: ProcessAdapter = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
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
      expect(calls.some((call) => call.includes("--interrupt"))).toBe(true);
      expect(calls.some((call) => call.includes("--screen"))).toBe(true);
      expect(calls.some((call) => call.includes("\u0015"))).toBe(false);
      expect(calls.some((call) => call.includes(formatted))).toBe(true);
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
});
