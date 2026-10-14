import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { appendMessage, createDelivery, createDispatch, getDeliveryChannel, getDispatch, listDeliveries, listOutbox, recordChannelResult, stateDatabase } from "../../src/adapters/state-db.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { agyLanguageServerFile } from "../../src/agents/agy-ls.js";
import { executeDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";
import { executeQueueWrite } from "../../src/cli/commands/queue-write.js";
import { executeOrchestrateClose } from "../../src/cli/commands/orchestrate-close.js";
import { failed, ok } from "../../src/core/result.js";

// Antigravity CLI 1.3.4 runs its language server in process and hands each tool shell
// ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN and ANTIGRAVITY_CONVERSATION_ID (measured). The
// child's own `megabrain received` runs in such a shell, so megabrain learns the endpoint there.
// SendUserCascadeMessage then queues a user message into the conversation; it needs the cascade
// config the CLI itself sends, which every user input in the trajectory records.

const TOKEN = "11111111-2222-3333-4444-555555555555";
const CONVERSATION = "ad20a592-a9bb-4804-a7be-f1a510388263";
const USER_CONFIG = { plannerConfig: { planModel: "MODEL_PLACEHOLDER_M319" }, executorConfig: {}, conversationHistoryConfig: {} };
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp("/tmp/mbagy-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

type Mode = "accept" | "accept-never-shown" | "unauthorized" | "missing-method" | "no-config";
type Server_ = { address: string; sent: Array<Record<string, unknown>>; calls: string[] };

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  return raw === "" ? {} : JSON.parse(raw) as Record<string, unknown>;
}

// The two Connect methods as the real server answers them: JSON in, JSON out, CSRF header checked.
async function startLanguageServer(mode: Mode = "accept"): Promise<Server_> {
  const state: Server_ = { address: "", sent: [], calls: [] };
  const steps: Array<Record<string, unknown>> = mode === "no-config" ? [] : [{ userInput: { items: [{ text: "the brief" }], userConfig: USER_CONFIG } }];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const method = String(request.url).split("/").at(-1) ?? "";
      state.calls.push(method);
      const json = (status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
      if (mode === "unauthorized" || request.headers["x-codeium-csrf-token"] !== TOKEN) { json(401, { code: "unauthenticated", message: "unauthenticated: missing CSRF token" }); return; }
      const input = await body(request);
      if (method === "GetCascadeTrajectory") { json(200, { trajectory: { cascadeId: input.cascadeId, steps } }); return; }
      if (method === "SendUserCascadeMessage") {
        if (mode === "missing-method") { json(404, { code: "unimplemented", message: "method not found" }); return; }
        state.sent.push(input);
        if (mode !== "accept-never-shown") steps.push({ userInput: { items: input.items, userConfig: input.cascadeConfig } });
        json(200, {});
        return;
      }
      json(404, { code: "unimplemented" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  state.address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

async function endpointFile(root: string, dispatch: string, address: string): Promise<void> {
  const file = agyLanguageServerFile(root, dispatch);
  await mkdir(join(root, "agy"), { recursive: true });
  await writeFile(file, JSON.stringify({ address, csrfToken: TOKEN, conversationId: CONVERSATION, version: "1.3.4" }), { mode: 0o600 });
}

const processAdapter: ProcessAdapter = {
  async run() { return ok<ProcessOutput>({ stdout: "", stderr: "", exitCode: 0 }); },
  async startDetached() { return failed("not used"); },
  invocationCount() { return 0; },
};

describe("endpoint capture", () => {
  test("received from an agy child stores the language server endpoint in a private file, never in the dispatch record", async () => {
    const root = await tempRoot();
    const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
    if (db.kind !== "ok") throw new Error(db.error);
    createDispatch(db.value, { dispatchId: "d-agy", agent: "agy", state: "running", processState: "running", runtime: "host", childHost: "local", terminalId: "agy-child" });
    const result = await executeQueueWrite("received", [], {
      HOME: root, MEGABRAIN_STATE_DIR: root, MEGABRAIN_DISPATCH_ID: "d-agy", MEGABRAIN_SESSION_ID: "agy-child",
      ANTIGRAVITY_LS_ADDRESS: "localhost:51139", ANTIGRAVITY_CSRF_TOKEN: TOKEN, ANTIGRAVITY_CONVERSATION_ID: CONVERSATION, ANTIGRAVITY_LS_VERSION: "1.3.4",
    }, processAdapter);
    expect(result.kind).toBe("ok");
    const file = agyLanguageServerFile(root, "d-agy");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ address: "localhost:51139", csrfToken: TOKEN, conversationId: CONVERSATION, version: "1.3.4" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const record = getDispatch(db.value, "d-agy");
    expect(JSON.stringify(record.kind === "ok" ? record.value : {})).not.toContain(TOKEN);
  });

  test("a child that is not agy stores nothing", async () => {
    const root = await tempRoot();
    const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
    if (db.kind !== "ok") throw new Error(db.error);
    createDispatch(db.value, { dispatchId: "d-codex", agent: "codex", state: "running", processState: "running", runtime: "host", childHost: "local", terminalId: "codex-child" });
    await executeQueueWrite("received", [], { HOME: root, MEGABRAIN_STATE_DIR: root, MEGABRAIN_DISPATCH_ID: "d-codex", MEGABRAIN_SESSION_ID: "codex-child", ANTIGRAVITY_LS_ADDRESS: "localhost:1", ANTIGRAVITY_CSRF_TOKEN: TOKEN, ANTIGRAVITY_CONVERSATION_ID: CONVERSATION }, processAdapter);
    expect(existsSync(agyLanguageServerFile(root, "d-codex"))).toBe(false);
  });
});

describe("endpoint lifetime", () => {
  test("closing an agy dispatch deletes its recorded token", async () => {
    const root = await tempRoot();
    const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
    if (db.kind !== "ok") throw new Error(db.error);
    createDispatch(db.value, { dispatchId: "d-agy", agent: "agy", state: "done", runtime: "host", childHost: "orca", terminalId: "t", workspaceId: "w", terminalState: "owned", parentHost: "orca", parentSessionId: "coord" });
    await endpointFile(root, "d-agy", "127.0.0.1:1");
    const result = await executeOrchestrateClose(["d-agy"], { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "coord" }, processAdapter);
    expect(result.kind).toBe("ok");
    expect(existsSync(agyLanguageServerFile(root, "d-agy"))).toBe(false);
  });
});

const idleTail = (await readFile(new URL("../fixtures/orca-terminal-screen-agy-idle.json", import.meta.url), "utf8"));

async function runReply(root: string, withEndpoint: string | undefined) {
  const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
  if (db.kind !== "ok") throw new Error(db.error);
  const meta = { agent: "agy", agentPid: 1, runtime: "host", childHost: "orca", workspaceId: "workspace", terminalId: "child-terminal", parentAgent: "claude", parentHost: "orca", parentTerminalId: "parent-terminal" };
  createDispatch(db.value, { dispatchId: "d-agy", state: "running", ...meta });
  if (withEndpoint !== undefined) await endpointFile(root, "d-agy", withEndpoint);
  appendMessage(db.value, "d-agy", { from: "parent", type: "reply", text: "use the second option" }, {
    outbox: { id: "ob-agy", targetKind: "child-delivery", target: "orca:child-terminal", payload: { dispatchId: "d-agy", sequence: 1, meta, targetKind: "child-delivery", fullMessage: "↩ reply: use the second option" } },
  });
  createDelivery(db.value, { id: "dl-agy", dispatchId: "d-agy", messageSeqs: [1], status: "outstanding" });
  const sends: string[] = [];
  const process: ProcessAdapter = {
    async run(command, args) {
      if (command === "orca" && args[1] === "list") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "child-terminal" }] }), stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "read") return ok<ProcessOutput>({ stdout: idleTail, stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "send") { sends.push(args.join(" ")); return ok<ProcessOutput>({ stdout: "{}", stderr: "", exitCode: 0 }); }
      return failed(`unexpected ${command} ${args.join(" ")}`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
  await executeDeliveryWorker(["ob-agy", "holder", "delivery-target:orca:child-terminal", String(Date.now() + 3000)], { HOME: root, MEGABRAIN_STATE_DIR: root, MEGABRAIN_AGY_POLL_MS: "50" }, process);
  const deliveries = listDeliveries(db.value, "d-agy");
  const outbox = listOutbox(db.value);
  const channel = getDeliveryChannel(db.value, "agy", "language-server");
  return {
    sends,
    deliveries: deliveries.kind === "ok" ? deliveries.value : [],
    outbox: outbox.kind === "ok" ? outbox.value : [],
    channel: channel.kind === "ok" ? channel.value : undefined,
  };
}

describe("reply to an agy child", () => {
  test("is queued into its conversation with the CLI's own cascade config, and never typed", async () => {
    const root = await tempRoot();
    const server = await startLanguageServer();
    const run = await runReply(root, server.address);
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]).toMatchObject({ cascadeId: CONVERSATION, items: [{ text: "↩ reply: use the second option" }], deliveryStrategy: "MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE", cascadeConfig: USER_CONFIG });
    expect(run.sends).toHaveLength(0);
    expect(run.outbox[0]?.status).toBe("sent");
    expect(run.deliveries[0]).toMatchObject({ transport: "socket" });
    expect(run.channel).toMatchObject({ status: "working", agentVersion: "1.3.4" });
  });

  test("without a recorded cascade config nothing is sent, since the CLI would fail to run it", async () => {
    const root = await tempRoot();
    const server = await startLanguageServer("no-config");
    const run = await runReply(root, server.address);
    expect(server.sent).toHaveLength(0);
    expect(run.deliveries[0]?.transport).not.toBe("socket");
    expect(run.channel).toBeUndefined();
  });

  test("a stale token or a restarted agy falls back without marking the channel broken", async () => {
    const root = await tempRoot();
    const server = await startLanguageServer("unauthorized");
    const run = await runReply(root, server.address);
    expect(run.deliveries[0]?.transport).not.toBe("socket");
    expect(run.channel).toBeUndefined();
    const gone = await tempRoot();
    const closed = await runReply(gone, "127.0.0.1:1");
    expect(closed.deliveries[0]?.transport).not.toBe("socket");
    expect(closed.channel).toBeUndefined();
  });

  test("a language server that no longer has the method marks the channel broken", async () => {
    const root = await tempRoot();
    const server = await startLanguageServer("missing-method");
    const run = await runReply(root, server.address);
    expect(run.deliveries[0]?.transport).not.toBe("socket");
    expect(run.channel).toMatchObject({ status: "broken", failures: 1 });
  });

  test("a message that never reaches the conversation is not counted as delivered", async () => {
    const root = await tempRoot();
    const server = await startLanguageServer("accept-never-shown");
    const run = await runReply(root, server.address);
    expect(server.sent).toHaveLength(1);
    expect(run.deliveries[0]?.transport).not.toBe("socket");
  });

  test("a broken channel inside its retry window is not tried", async () => {
    const root = await tempRoot();
    const server = await startLanguageServer();
    const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
    if (db.kind !== "ok") throw new Error(db.error);
    recordChannelResult(db.value, { agent: "agy", channel: "language-server", agentVersion: "1.3.4", ok: false, error: "method not found", now: Date.now() });
    await runReply(root, server.address);
    expect(server.calls).toHaveLength(0);
  });

  test("an agy child with no recorded endpoint keeps the typed path", async () => {
    const root = await tempRoot();
    const run = await runReply(root, undefined);
    expect(run.channel).toBeUndefined();
    expect(run.deliveries[0]?.transport).not.toBe("socket");
  });
});

// An agy session that spawns a child runs `megabrain orchestrate spawn` in one of its own tool
// shells, so the same endpoint is known for the parent; the child's mail then enters the parent's
// conversation instead of being typed into its composer.
async function runParentNotice(root: string, record: Record<string, unknown>, endpoints: Readonly<{ parent?: string; child?: string }>) {
  const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
  if (db.kind !== "ok") throw new Error(db.error);
  const meta = { agentPid: 1, runtime: "host", childHost: "orca", workspaceId: "workspace", terminalId: "child-terminal", parentHost: "orca", parentTerminalId: "parent-terminal", parentSessionId: "parent-terminal", ...record };
  createDispatch(db.value, { dispatchId: "d-agy", state: "running", ...meta });
  if (endpoints.parent !== undefined) await endpointFile(root, "d-agy.parent", endpoints.parent);
  if (endpoints.child !== undefined) await endpointFile(root, "d-agy", endpoints.child);
  appendMessage(db.value, "d-agy", { from: "child", type: "done", text: "finished the migration" }, {
    outbox: { id: "ob-parent", targetKind: "parent-pointer", target: "parent-terminal", payload: { dispatchId: "d-agy", sequence: 1, meta, targetKind: "parent-pointer", pointer: "mail: megabrain orchestrate watch d-agy", fullMessage: "✅ done: finished the migration" } },
  });
  createDelivery(db.value, { id: "dl-parent", dispatchId: "d-agy", messageSeqs: [1], status: "outstanding" });
  const sends: string[] = [];
  const process: ProcessAdapter = {
    async run(command, args) {
      if (command === "orca" && args[1] === "list") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "parent-terminal" }, { handle: "child-terminal" }] }), stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "read") return ok<ProcessOutput>({ stdout: idleTail, stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "send") { sends.push(args.join(" ")); return ok<ProcessOutput>({ stdout: "{}", stderr: "", exitCode: 0 }); }
      return failed(`unexpected ${command} ${args.join(" ")}`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
  await executeDeliveryWorker(["ob-parent", "holder", "delivery-target:orca:parent-terminal", String(Date.now() + 3000)], { HOME: root, MEGABRAIN_STATE_DIR: root, MEGABRAIN_AGY_POLL_MS: "50" }, process);
  const outbox = listOutbox(db.value);
  return { sends, outbox: outbox.kind === "ok" ? outbox.value : [] };
}

describe("child mail to an agy parent", () => {
  test("is queued into the parent's conversation and never typed", async () => {
    const root = await tempRoot();
    const server = await startLanguageServer();
    const run = await runParentNotice(root, { agent: "codex", parentAgent: "agy" }, { parent: server.address });
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]).toMatchObject({ cascadeId: CONVERSATION, items: [{ text: "✅ done: finished the migration" }], cascadeConfig: USER_CONFIG });
    expect(run.sends).toHaveLength(0);
    expect(run.outbox[0]?.status).toBe("sent");
  });

  test("never goes to an agy child's own conversation", async () => {
    const root = await tempRoot();
    const server = await startLanguageServer();
    await runParentNotice(root, { agent: "agy", parentAgent: "claude" }, { child: server.address });
    expect(server.calls).toHaveLength(0);
  });

  test("closing the dispatch deletes the parent's recorded token too", async () => {
    const root = await tempRoot();
    const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
    if (db.kind !== "ok") throw new Error(db.error);
    createDispatch(db.value, { dispatchId: "d-agy", agent: "codex", parentAgent: "agy", state: "done", runtime: "host", childHost: "orca", terminalId: "t", workspaceId: "w", terminalState: "owned", parentHost: "orca", parentSessionId: "coord" });
    await endpointFile(root, "d-agy.parent", "127.0.0.1:1");
    const result = await executeOrchestrateClose(["d-agy"], { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "coord" }, processAdapter);
    expect(result.kind).toBe("ok");
    expect(existsSync(agyLanguageServerFile(root, "d-agy.parent"))).toBe(false);
  });
});
