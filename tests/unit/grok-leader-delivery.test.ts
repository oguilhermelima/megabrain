import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { appendMessage, createDelivery, createDispatch, getDeliveryChannel, listDeliveries, listOutbox, recordChannelResult, stateDatabase } from "../../src/adapters/state-db.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { grokLeaderSocket, sendGrokLeaderPrompt, stopGrokLeader } from "../../src/agents/grok-leader.js";
import { executeDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";
import { failed, ok } from "../../src/core/result.js";

// A Grok child runs with its own leader (`grok --leader --leader-socket <path>`). Any client on
// that socket can put a prompt into the child's session queue: the session runs it as a user turn
// when the current one ends, even after the sending client disconnects (measured on 1.0.52).

type Frames = { registered: Record<string, unknown>; initializeResult: Record<string, unknown>; queueChangedQueued: { params: Record<string, unknown> } };
const frames = JSON.parse(await readFile(new URL("../fixtures/grok-leader-frames.json", import.meta.url), "utf8")) as Frames;
const SESSION = "01a136f0-62ab-7ad2-839a-fc733715d740";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

type Proof = "queued" | "running" | "error" | "silent";
type Leader = { connections: number; received: Array<Record<string, unknown>> };

function write(socket: Socket, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  socket.write(Buffer.concat([head, body]));
}

const acp = (socket: Socket, payload: unknown) => write(socket, { type: "acp", payload: JSON.stringify(payload) });

// Answers the way the captured leader does: registered, the initialize result, then a queue
// change naming the new prompt.
async function startLeader(path: string, proof: Proof = "queued"): Promise<Leader> {
  const leader: Leader = { connections: 0, received: [] };
  const server: Server = createServer((socket) => {
    leader.connections += 1;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) break;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString()) as Record<string, unknown>;
        buffer = buffer.subarray(4 + length);
        const payload = message.type === "acp" ? JSON.parse(String(message.payload)) as Record<string, unknown> : message;
        leader.received.push(payload);
        if (message.type === "register") write(socket, frames.registered);
        else if (payload.method === "initialize") acp(socket, { ...frames.initializeResult, id: payload.id });
        else if (payload.method === "session/prompt") {
          const params = payload.params as { sessionId: string; _meta?: { promptId?: string } };
          const promptId = params._meta?.promptId ?? "";
          const base = frames.queueChangedQueued.params;
          if (proof === "queued") acp(socket, { jsonrpc: "2.0", method: "_x.ai/queue/changed", params: { ...base, sessionId: params.sessionId, entries: [...(base.entries as unknown[]), { id: promptId, version: 0, kind: "prompt", text: "x", position: 2 }] } });
          else if (proof === "running") acp(socket, { jsonrpc: "2.0", method: "_x.ai/queue/changed", params: { sessionId: params.sessionId, entries: [], runningPromptId: promptId, runningKind: "prompt" } });
          else if (proof === "error") acp(socket, { jsonrpc: "2.0", id: payload.id, error: { code: -32602, message: "session not found" } });
        }
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return leader;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp("/tmp/mbgl-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("leader socket path", () => {
  test("is per dispatch, under the state directory, and short enough for a Unix socket", () => {
    const first = grokLeaderSocket("/Users/someone/.megabrain", "5cc93f09-c651-4851-816f-1554e4a52394");
    const second = grokLeaderSocket("/Users/someone/.megabrain", "term_09aa54f5-8e3f-4e27-93f5-c97729bdd04d");
    expect(first).toStartWith("/Users/someone/.megabrain/grok/");
    expect(first).toEndWith(".sock");
    expect(first).not.toBe(second);
    expect(grokLeaderSocket("/Users/someone/.megabrain", "5cc93f09-c651-4851-816f-1554e4a52394")).toBe(first);
    expect(Buffer.byteLength(first ?? "")).toBeLessThan(104);
  });

  test("is withheld when the state directory would make the path too long to bind", () => {
    expect(grokLeaderSocket(`/tmp/${"d".repeat(120)}`, "dispatch")).toBeUndefined();
  });
});

describe("prompt through the leader", () => {
  test("registers, initializes, then sends one prompt to the child's session with its own prompt id", async () => {
    const root = await tempRoot();
    const leader = await startLeader(join(root, "l.sock"));
    const sent = await sendGrokLeaderPrompt(join(root, "l.sock"), SESSION, "↩ reply: use the second option");
    expect(sent).toMatchObject({ kind: "delivered", version: "1.0.52" });
    const [register, initialize, prompt] = leader.received;
    expect(register).toMatchObject({ type: "register", client_type: "grok-shell" });
    expect(initialize).toMatchObject({ method: "initialize" });
    expect(prompt).toMatchObject({ method: "session/prompt", params: { sessionId: SESSION, prompt: [{ type: "text", text: "↩ reply: use the second option" }] } });
    expect((prompt?.params as { _meta: { promptId: string } })._meta.promptId).toBe(sent.kind === "delivered" ? sent.promptId : "missing");
  });

  test("a prompt the session starts at once counts as delivered", async () => {
    const root = await tempRoot();
    await startLeader(join(root, "l.sock"), "running");
    expect((await sendGrokLeaderPrompt(join(root, "l.sock"), SESSION, "x")).kind).toBe("delivered");
  });

  test("a prompt the leader rejects fails with its reason", async () => {
    const root = await tempRoot();
    await startLeader(join(root, "l.sock"), "error");
    const sent = await sendGrokLeaderPrompt(join(root, "l.sock"), SESSION, "x");
    expect(sent).toMatchObject({ kind: "failed", version: "1.0.52" });
    expect(sent.kind === "failed" ? sent.reason : "").toContain("session not found");
  });

  test("a prompt that never shows up in the session queue fails at the timeout", async () => {
    const root = await tempRoot();
    await startLeader(join(root, "l.sock"), "silent");
    const started = Date.now();
    const sent = await sendGrokLeaderPrompt(join(root, "l.sock"), SESSION, "x", 400);
    expect(sent.kind).toBe("failed");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a missing socket fails without a version", async () => {
    const root = await tempRoot();
    const sent = await sendGrokLeaderPrompt(join(root, "l.sock"), SESSION, "x");
    expect(sent).toMatchObject({ kind: "failed" });
    expect(sent.kind === "failed" ? sent.version : "set").toBeUndefined();
  });
});

describe("leader shutdown", () => {
  function processFor(command: string, calls: string[]): ProcessAdapter {
    return {
      async run(name, args) {
        calls.push(`${name} ${args.join(" ")}`);
        if (name === "ps") return ok<ProcessOutput>({ stdout: `${command}\n`, stderr: "", exitCode: 0 });
        return ok<ProcessOutput>({ stdout: "", stderr: "", exitCode: 0 });
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 0; },
    };
  }

  test("stops the leader named in the socket's lock file", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "l.lock"), "76904");
    const calls: string[] = [];
    await stopGrokLeader(join(root, "l.sock"), processFor("/Users/someone/.grok/bin/grok agent leader --no-exit-on-disconnect", calls));
    expect(calls).toContain("kill 76904");
  });

  test("never kills a process that is not a Grok leader, since the pid may have been reused", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "l.lock"), "76904");
    const calls: string[] = [];
    await stopGrokLeader(join(root, "l.sock"), processFor("/usr/bin/vim notes.txt", calls));
    expect(calls.some((call) => call.startsWith("kill"))).toBe(false);
  });

  test("does nothing without a lock file", async () => {
    const root = await tempRoot();
    const calls: string[] = [];
    await stopGrokLeader(join(root, "l.sock"), processFor("grok agent leader", calls));
    expect(calls).toHaveLength(0);
  });
});

const idleTail = (await readFile(new URL("../fixtures/tmux-capture-grok-idle.txt", import.meta.url), "utf8")).split("\n");

async function runReply(root: string, socket: string | undefined) {
  await mkdir(root, { recursive: true });
  const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
  if (db.kind !== "ok") throw new Error(db.error);
  const meta = {
    agent: "grok", agentPid: 1, grokSessionId: SESSION, runtime: "host", childHost: "orca", workspaceId: "workspace", terminalId: "child-terminal",
    parentAgent: "claude", parentHost: "orca", parentTerminalId: "parent-terminal", ...(socket === undefined ? {} : { grokLeaderSocket: socket }),
  };
  createDispatch(db.value, { dispatchId: "d-grok", state: "running", ...meta });
  appendMessage(db.value, "d-grok", { from: "parent", type: "reply", text: "use the second option" }, {
    outbox: { id: "ob-grok", targetKind: "child-delivery", target: "orca:child-terminal", payload: { dispatchId: "d-grok", sequence: 1, meta, targetKind: "child-delivery", fullMessage: "↩ reply: use the second option" } },
  });
  createDelivery(db.value, { id: "dl-grok", dispatchId: "d-grok", messageSeqs: [1], status: "outstanding" });
  const screen = { id: "x", ok: true, result: { terminal: { handle: "child-terminal", status: "running", tail: idleTail } } };
  const sends: string[] = [];
  const process: ProcessAdapter = {
    async run(command, args) {
      if (command === "orca" && args[1] === "list") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "child-terminal" }] }), stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "read") return ok<ProcessOutput>({ stdout: JSON.stringify(screen), stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "send") { sends.push(args.join(" ")); return ok<ProcessOutput>({ stdout: "{}", stderr: "", exitCode: 0 }); }
      return failed(`unexpected ${command} ${args.join(" ")}`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
  await executeDeliveryWorker(["ob-grok", "holder", "delivery-target:orca:child-terminal", String(Date.now() + 4000)], { HOME: root, MEGABRAIN_STATE_DIR: root }, process);
  const outbox = listOutbox(db.value);
  const deliveries = listDeliveries(db.value, "d-grok");
  const channel = getDeliveryChannel(db.value, "grok", "leader-socket");
  const log = (await readFile(join(root, "delivery-decisions.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    sends,
    log,
    outbox: outbox.kind === "ok" ? outbox.value : [],
    deliveries: deliveries.kind === "ok" ? deliveries.value : [],
    channel: channel.kind === "ok" ? channel.value : undefined,
  };
}

describe("reply to a Grok child", () => {
  test("goes into the child's session queue through its leader and never types", async () => {
    const root = await tempRoot();
    const leader = await startLeader(join(root, "l.sock"));
    const run = await runReply(root, join(root, "l.sock"));
    expect(leader.connections).toBe(1);
    expect(run.sends).toHaveLength(0);
    expect(run.outbox[0]?.status).toBe("sent");
    expect(run.deliveries[0]).toMatchObject({ transport: "socket" });
    expect(run.channel).toMatchObject({ status: "working", agentVersion: "1.0.52", failures: 0 });
  });

  // The typed path cannot read Grok's boxed composer, so these assert the hand-off to it through
  // the decision log rather than through a keystroke.
  test("a leader that is gone falls back to the typed path and marks the channel broken", async () => {
    const root = await tempRoot();
    const run = await runReply(root, join(root, "l.sock"));
    expect(run.deliveries[0]?.transport).not.toBe("socket");
    expect(String(run.log.at(-1)?.peerFallback)).toContain("ENOENT");
    expect(run.channel).toMatchObject({ status: "broken", failures: 1 });
  });

  test("a broken channel inside its retry window is not tried", async () => {
    const root = await tempRoot();
    const leader = await startLeader(join(root, "l.sock"));
    const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
    if (db.kind !== "ok") throw new Error(db.error);
    recordChannelResult(db.value, { agent: "grok", channel: "leader-socket", agentVersion: "1.0.52", ok: false, error: "refused", now: Date.now() });
    const run = await runReply(root, join(root, "l.sock"));
    expect(leader.connections).toBe(0);
    expect(String(run.log.at(-1)?.peerFallback)).toContain("marked broken");
  });

  test("a Grok child started without a leader keeps the typed path and says nothing about the channel", async () => {
    const root = await tempRoot();
    const run = await runReply(root, undefined);
    expect(run.deliveries[0]?.transport).not.toBe("socket");
    expect(run.log.length).toBeGreaterThan(0);
    expect(run.log.some((entry) => "peerFallback" in entry)).toBe(false);
    expect(run.channel).toBeUndefined();
  });
});
