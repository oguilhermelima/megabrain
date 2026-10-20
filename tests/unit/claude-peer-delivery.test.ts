import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { createDispatch, getDeliveryChannel, listDeliveries, listDeliveryChannels, listOutbox, recordChannelResult, stateDatabase } from "../../src/adapters/state-db.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { claudePeerContent, resolveClaudePeer, sendClaudePeer } from "../../src/agents/claude-peer.js";
import { executeDatabase } from "../../src/cli/commands/db.js";
import { callStateOwner, startStateOwner, stopStateOwner } from "../../src/db/state-owner.js";
import { insertLease } from "../../src/db/queries/outbox-leases.js";
import { channelVerdict, nextRetryAt } from "../../src/core/delivery-channel.js";
import { choosePeerChannel, senderPermissionClass } from "../../src/core/claude-peer-delivery.js";
import { failed, ok } from "../../src/core/result.js";

const fixture = (name: string) => readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const MINUTE = 60_000;
const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("channel policy", () => {
  test("an unrecorded or working channel is tried", () => {
    expect(channelVerdict(undefined, "2.1.296", NOW)).toBe("try");
    expect(channelVerdict({ status: "working", agentVersion: "2.1.296", retryAfter: null }, "2.1.296", NOW)).toBe("try");
  });

  test("a broken channel is skipped until its retry time", () => {
    const retryAfter = new Date(NOW + MINUTE).toISOString();
    expect(channelVerdict({ status: "broken", agentVersion: "2.1.296", retryAfter }, "2.1.296", NOW)).toBe("skip");
    expect(channelVerdict({ status: "broken", agentVersion: "2.1.296", retryAfter }, "2.1.296", NOW + MINUTE)).toBe("try");
  });

  test("an agent update re-probes a broken channel at once", () => {
    const retryAfter = new Date(NOW + 60 * MINUTE).toISOString();
    expect(channelVerdict({ status: "broken", agentVersion: "2.1.200", retryAfter }, "2.1.296", NOW)).toBe("try");
  });

  test("retry waits double per failure and stop growing at six hours", () => {
    expect(nextRetryAt(1, NOW)).toBe(NOW + 5 * MINUTE);
    expect(nextRetryAt(2, NOW)).toBe(NOW + 10 * MINUTE);
    expect(nextRetryAt(3, NOW)).toBe(NOW + 20 * MINUTE);
    expect(nextRetryAt(20, NOW)).toBe(NOW + 360 * MINUTE);
  });
});

describe("channel table", () => {
  test("records failures with backoff and clears them on success", async () => {
    const root = await mkdtemp("/tmp/mbpeer-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
    if (db.kind !== "ok") throw new Error(db.error);
    recordChannelResult(db.value, { agent: "claude", channel: "peer-socket", agentVersion: "2.1.296", ok: false, error: "connect ECONNREFUSED", now: NOW });
    recordChannelResult(db.value, { agent: "claude", channel: "peer-socket", agentVersion: "2.1.296", ok: false, error: "not consumed", now: NOW });
    const broken = getDeliveryChannel(db.value, "claude", "peer-socket");
    expect(broken.kind === "ok" ? broken.value : undefined).toMatchObject({
      status: "broken", agentVersion: "2.1.296", failures: 2, lastError: "not consumed", retryAfter: new Date(NOW + 10 * MINUTE).toISOString(),
    });
    recordChannelResult(db.value, { agent: "claude", channel: "peer-socket", agentVersion: "2.1.296", ok: true, now: NOW + MINUTE });
    const working = getDeliveryChannel(db.value, "claude", "peer-socket");
    expect(working.kind === "ok" ? working.value : undefined).toMatchObject({
      status: "working", failures: 0, retryAfter: null, lastSuccessAt: new Date(NOW + MINUTE).toISOString(), lastError: "not consumed",
    });
    const listed = listDeliveryChannels(db.value);
    expect(listed.kind === "ok" ? listed.value.length : -1).toBe(1);
    const shown = await executeDatabase(["show", "--delivery-channels", "--json"], { HOME: root, MEGABRAIN_STATE_DIR: root });
    expect(shown.kind).toBe("ok");
    expect(JSON.parse(shown.kind === "ok" ? shown.value : "[]")).toMatchObject([{ agent: "claude", channel: "peer-socket", status: "working" }]);
  });
});

type Frame = Record<string, unknown>;
type Inbox = { connections: number; frames: Frame[][]; processing: Promise<void>[]; receivedAt?: number };

async function startInbox(path: string, onFrames: (frames: Frame[]) => Promise<void> | void = () => undefined): Promise<Inbox> {
  const inbox: Inbox = { connections: 0, frames: [], processing: [] };
  const server: Server = createServer((socket) => {
    inbox.connections += 1;
    let buffer = "";
    socket.on("data", (chunk) => { inbox.receivedAt ??= Date.now(); buffer += chunk.toString(); });
    socket.on("end", () => {
      const frames = buffer.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Frame);
      inbox.frames.push(frames);
      const processing = Promise.resolve(onFrames(frames));
      inbox.processing.push(processing);
      void processing.finally(() => socket.end());
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return inbox;
}

async function received(inbox: Inbox, count = 1): Promise<void> {
  const deadline = Date.now() + 2000;
  while (inbox.frames.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.all(inbox.processing);
}

type Scene = {
  root: string;
  session: Record<string, unknown>;
  transcript: string;
  token: string;
};

async function scene(status: "idle" | "busy" = "idle", options: { protocol?: number | null } = {}): Promise<Scene> {
  const root = await mkdtemp("/tmp/mbpeer-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const session = JSON.parse(await fixture("claude-session-peer.json")) as Record<string, unknown>;
  session.status = status;
  session.messagingSocketPath = join(root, "inbox.sock");
  if (options.protocol === null) delete session.peerProtocol;
  else if (options.protocol !== undefined) session.peerProtocol = options.protocol;
  const sessions = join(root, ".claude", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, "41414.json"), JSON.stringify(session));
  const key = await fixture("claude-session-peer.key.json");
  await writeFile(join(sessions, "41414.a1b2c3d4.key"), key, { mode: 0o600 });
  const project = join(root, ".claude", "projects", "-Users-example-Workspaces-project");
  await mkdir(project, { recursive: true });
  const transcript = join(project, `${String(session.sessionId)}.jsonl`);
  await writeFile(transcript, `${modeEntry("bypassPermissions")}\n`);
  return { root, session, transcript, token: (JSON.parse(key) as { peerToken: string }).peerToken };
}

const modeEntry = (mode: string) => JSON.stringify({ type: "user", permissionMode: mode, message: { role: "user", content: "go" } });

// Claude writes a consumed peer message to the transcript with origin.msg_id.
const consume = (current: Scene) => async (frames: Frame[]) => {
  const message = frames.find((frame) => frame.type === "user");
  if (message === undefined) return;
  await appendFile(current.transcript, `${JSON.stringify({ type: "user", origin: { kind: "peer", msg_id: message.msg_id } })}\n`);
};

describe("claude peer socket", () => {
  test("resolves the session socket, token and version", async () => {
    const current = await scene();
    const target = await resolveClaudePeer(current.root, 41414, String(current.session.sessionId));
    expect(target).toMatchObject({ kind: "ok", value: { socketPath: current.session.messagingSocketPath, token: current.token, version: "2.1.296", transcript: current.transcript } });
  });

  test("a session file without the peer protocol is unsupported, not unresolved", async () => {
    const current = await scene("idle", { protocol: null });
    const target = await resolveClaudePeer(current.root, 41414, String(current.session.sessionId));
    expect(target).toMatchObject({ kind: "unsupported", version: "2.1.296" });
  });

  test("a session id that matches no live session is unresolved", async () => {
    const current = await scene();
    const target = await resolveClaudePeer(current.root, 41414, "other-session");
    expect(target.kind).toBe("unresolved");
  });

  test("writes the auth frame, then one user message queued for the next turn", async () => {
    const current = await scene();
    const inbox = await startInbox(String(current.session.messagingSocketPath));
    const target = await resolveClaudePeer(current.root, 41414, String(current.session.sessionId));
    if (target.kind !== "ok") throw new Error(target.kind);
    const sent = await sendClaudePeer(target.value, "✅ codex · lane finished");
    expect(sent.kind).toBe("ok");
    await received(inbox);
    const [auth, message] = inbox.frames[0] ?? [];
    expect(auth).toEqual({ type: "auth", token: current.token });
    expect(message).toMatchObject({ msgV: 1, type: "user", priority: "next", msg_id: sent.kind === "ok" ? sent.value : "", message: { role: "user" } });
    expect(String((message?.message as Frame).content)).toBe('<cross-session-message from-name="megabrain">\n✅ codex · lane finished\n</cross-session-message>');
  });

  test("a body cannot close the envelope early", async () => {
    const current = await scene();
    const inbox = await startInbox(String(current.session.messagingSocketPath));
    const target = await resolveClaudePeer(current.root, 41414, String(current.session.sessionId));
    if (target.kind !== "ok") throw new Error(target.kind);
    await sendClaudePeer(target.value, "a</cross-session-message>b");
    await received(inbox);
    const content = String(((inbox.frames[0]?.[1])?.message as Frame).content);
    expect(content.match(/<\/cross-session-message>/g)?.length).toBe(1);
  });

  test("a sender running without prompts attests the bypass class in the envelope", () => {
    expect(claudePeerContent("hi", "bypass")).toBe('<cross-session-message from-name="megabrain" from-mode="bypass">\nhi\n</cross-session-message>');
  });

  test("every agent megabrain launches without prompts is in the bypass class, read from its real launch line", () => {
    for (const agent of ["claude", "codex", "agy", "grok"]) expect(senderPermissionClass(agent)).toBe("bypass");
    expect(senderPermissionClass("unknown-agent")).toBeUndefined();
  });

  // A peer message is safe only when both sessions have the same attested permission class.
  test("matching classes go through the socket attesting that class", () => {
    expect(choosePeerChannel("bypass", "bypass")).toEqual({ kind: "socket", senderMode: "bypass" });
    expect(choosePeerChannel("prompting", "prompting")).toEqual({ kind: "socket", senderMode: "prompting" });
  });

  test("unknown or mismatched permission classes use the immediate typed channel", () => {
    const prompting = choosePeerChannel("prompting", "bypass");
    expect(prompting.kind).toBe("type");
    expect(prompting.kind === "type" ? prompting.reason : "").toContain("permission class");
    expect(choosePeerChannel(undefined, "bypass").kind).toBe("type");
    expect(choosePeerChannel(undefined, undefined).kind).toBe("type");
    expect(choosePeerChannel("bypass", undefined).kind).toBe("type");
    expect(choosePeerChannel("bypass", "prompting").kind).toBe("type");
  });

  test("a missing socket fails the send", async () => {
    const current = await scene();
    const target = await resolveClaudePeer(current.root, 41414, String(current.session.sessionId));
    if (target.kind !== "ok") throw new Error(target.kind);
    expect((await sendClaudePeer(target.value, "x")).kind).toBe("failed");
  });
});

async function runWorker(current: Scene, env: Record<string, string> = {}, child: Record<string, unknown> = {}, messageType = "done", supervisorDelayMs = 0, holdTargetLease = false) {
  const db = stateDatabase({ HOME: current.root, MEGABRAIN_STATE_DIR: current.root });
  if (db.kind !== "ok") throw new Error(db.error);
  const meta = { agent: "codex", agentPid: 1, parentAgent: "claude", parentAgentPid: 41414, parentAgentSessionId: current.session.sessionId, parentHost: "orca", parentWorkspaceId: "workspace", parentTerminalId: "parent-terminal", ...child };
  createDispatch(db.value, { dispatchId: "d-peer", state: "running", ...meta });
  const messageText = messageType === "ask" ? "Need a decision" : "finished";
  const screen = JSON.parse(await fixture("orca-terminal-screen-claude-idle.json")) as unknown;
  const sends: string[] = [];
  const process: ProcessAdapter = {
    async run(command, args) {
      if (command === "ps" && args[0] === "-ww") return ok<ProcessOutput>({ stdout: "41414 41414 41414 /opt/claude/bin/claude --resume parent-session\n", stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "list") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "parent-terminal" }] }), stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "read") return ok<ProcessOutput>({ stdout: JSON.stringify(screen), stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "send") { sends.push(args.join(" ")); return ok<ProcessOutput>({ stdout: "{}", stderr: "", exitCode: 0 }); }
      return failed(`unexpected ${command} ${args.join(" ")}`);
    },
    async startDetached() {
      if (supervisorDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, supervisorDelayMs));
      return failed("not used");
    },
    invocationCount() { return 0; },
  };
  const ownerEnvironment = { HOME: current.root, MEGABRAIN_STATE_DIR: current.root, MEGABRAIN_PEER_IDLE_DROP_MS: "300", MEGABRAIN_DELIVERY_TIMEOUT_MS: "5000", ...env };
  const owner = await startStateOwner(current.root, process, ownerEnvironment);
  if (holdTargetLease) insertLease(db.value.db, { key: "delivery-target:orca:parent-terminal", holder: "legacy-delivery-worker", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const publishedAt = Date.now();
  try {
    await callStateOwner(current.root, { operation: "append-message", dispatchId: "d-peer", message: { from: "child", type: messageType, text: messageText }, delivery: { id: "dl-peer", recipient: "parent", status: "outstanding" }, outbox: { id: "ob-peer", targetKind: "parent-pointer", target: "orca:parent-terminal", payload: { dispatchId: "d-peer", sequence: 1, meta, pointer: "megabrain check", fullMessage: messageType === "ask" ? `❓ codex · ${messageText}` : "✅ codex · lane finished" } } });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const currentOutbox = listOutbox(owner.handle);
      if (currentOutbox.kind === "ok" && currentOutbox.value.find((item) => item.id === "ob-peer")?.status !== "pending") break;
      if (owner.pendingDeliveries.size > 0) await Promise.all([...owner.pendingDeliveries]);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally { await stopStateOwner(owner); }
  const outbox = listOutbox(db.value);
  const deliveries = listDeliveries(db.value, "d-peer");
  const channel = getDeliveryChannel(db.value, "claude", "peer-socket");
  return {
    sends,
    outbox: outbox.kind === "ok" ? outbox.value : [],
    deliveries: deliveries.kind === "ok" ? deliveries.value : [],
    channel: channel.kind === "ok" ? channel.value : undefined,
    elapsedMs: Date.now() - publishedAt,
    db: db.value,
  };
}

describe("parent notice to a Claude parent", () => {
  test("leaves accepted peer messages pending verification without waiting for transcript consumption", async () => {
    const current = await scene("busy");
    const inbox = await startInbox(String(current.session.messagingSocketPath));
    const startedAt = Date.now();
    const worker = runWorker(current);
    await received(inbox);
    const run = await worker;
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(inbox.frames).toHaveLength(1);
    expect(run.sends).toHaveLength(0);
    expect(run.outbox[0]?.status).toBe("sent");
    expect(run.deliveries[0]).toMatchObject({ transport: "ack-verifying" });
  });

  test("goes through the peer socket and never types into the composer", async () => {
    const current = await scene();
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runWorker(current);
    expect(inbox.connections).toBe(1);
    expect(String(((inbox.frames[0]?.[1])?.message as Frame).content)).toContain("✅ codex · lane finished");
    expect(run.sends).toHaveLength(0);
    expect(run.outbox[0]?.status).toBe("sent");
    expect(run.deliveries[0]).toMatchObject({ transport: "ack-verifying" });
    expect(run.channel).toBeUndefined();
  });

  test("sends an ask from a child of a Claude parent through the peer socket", async () => {
    const current = await scene();
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runWorker(current, {}, {}, "ask");
    expect(inbox.connections).toBe(1);
    expect(String(((inbox.frames[0]?.[1])?.message as Frame).content)).toContain("Need a decision");
    expect(run.sends).toHaveLength(0);
    expect(run.outbox[0]?.status).toBe("sent");
  });

  test("publishes to the peer socket in 50ms despite a legacy target lease and slow supervisor startup", async () => {
    const current = await scene();
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runWorker(current, {}, {}, "ask", 2_500, true);
    expect(inbox.connections).toBe(1);
    expect(run.outbox[0]?.status).toBe("sent");
    expect(inbox.receivedAt).toBeDefined();
    expect((inbox.receivedAt ?? Date.now()) - Date.parse(String(run.outbox[0]?.createdAt))).toBeLessThan(50);
  });

  test("a notice from a child launched without prompts attests bypass, so a bypass parent accepts it", async () => {
    const current = await scene();
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    await runWorker(current);
    await received(inbox);
    expect(String(((inbox.frames[0]?.[1])?.message as Frame).content)).toStartWith('<cross-session-message from-name="megabrain" from-mode="bypass">');
  });

  test("a parent outside bypass gets a typed notice when the socket would hold it", async () => {
    const current = await scene();
    await appendFile(current.transcript, `${modeEntry("default")}\n`);
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runWorker(current);
    expect(inbox.connections).toBe(0);
    expect(run.sends).toHaveLength(1);
    expect(run.deliveries[0]).toMatchObject({ transport: "typed" });
  });

  test("a Claude child that left bypass is typed to a bypass parent without trying the socket", async () => {
    const current = await scene();
    await appendFile(current.transcript, `${modeEntry("bypassPermissions")}\n`);
    await writeFile(join(dirname(current.transcript), "child-session-0001.jsonl"), `${modeEntry("acceptEdits")}\n`);
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runWorker(current, {}, { agent: "claude", agentSessionId: "child-session-0001" });
    expect(inbox.connections).toBe(0);
    expect(run.sends).toHaveLength(1);
    expect(run.channel).toBeUndefined();
  });

  test("a Claude child still in bypass attests bypass to a bypass parent", async () => {
    const current = await scene();
    await appendFile(current.transcript, `${modeEntry("bypassPermissions")}\n`);
    await writeFile(join(dirname(current.transcript), "child-session-0001.jsonl"), `${modeEntry("bypassPermissions")}\n`);
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runWorker(current, {}, { agent: "claude", agentSessionId: "child-session-0001" });
    expect(String(((inbox.frames[0]?.[1])?.message as Frame).content)).toStartWith('<cross-session-message from-name="megabrain" from-mode="bypass">');
    expect(run.sends).toHaveLength(0);
  });

  test("an uncertain peer permission class bypasses the socket and types immediately", async () => {
    const current = await scene();
    await writeFile(current.transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "mode unavailable" } })}\n`);
    const inbox = await startInbox(String(current.session.messagingSocketPath));
    const started = Date.now();
    const run = await runWorker(current, { MEGABRAIN_PEER_IDLE_DROP_MS: "4000" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(inbox.connections).toBe(0);
    expect(run.sends).toHaveLength(1);
    expect(run.channel).toBeUndefined();
  });

  test("returns after acceptance while leaving a busy parent's message unverified", async () => {
    const current = await scene("busy");
    await startInbox(String(current.session.messagingSocketPath));
    const run = await runWorker(current);
    expect(run.sends).toHaveLength(0);
    expect(run.deliveries[0]).toMatchObject({ transport: "ack-verifying" });
    expect(run.channel).toBeUndefined();
  });

  test("queues peer verification without waiting for transcript consumption", async () => {
    const current = await scene();
    await startInbox(String(current.session.messagingSocketPath));
    const run = await runWorker(current);
    expect(run.sends).toHaveLength(0);
    expect(run.outbox[0]?.status).toBe("sent");
    expect(run.deliveries[0]).toMatchObject({ transport: "ack-verifying" });
    expect(run.channel).toBeUndefined();
  });

  test("a socket nobody listens on falls back to typing and marks the channel broken", async () => {
    const current = await scene();
    const run = await runWorker(current);
    expect(run.sends).toHaveLength(1);
    expect(run.channel).toMatchObject({ status: "broken", failures: 1 });
  });

  test("a broken channel inside its retry window is not tried", async () => {
    const current = await scene();
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const db = stateDatabase({ HOME: current.root, MEGABRAIN_STATE_DIR: current.root });
    if (db.kind !== "ok") throw new Error(db.error);
    recordChannelResult(db.value, { agent: "claude", channel: "peer-socket", agentVersion: "2.1.296", ok: false, error: "not consumed", now: Date.now() });
    const run = await runWorker(current);
    expect(inbox.connections).toBe(0);
    expect(run.sends).toHaveLength(1);
    expect(run.channel).toMatchObject({ status: "broken", failures: 1 });
  });

  test("a Claude update re-probes a broken channel and restores it", async () => {
    const current = await scene();
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const db = stateDatabase({ HOME: current.root, MEGABRAIN_STATE_DIR: current.root });
    if (db.kind !== "ok") throw new Error(db.error);
    recordChannelResult(db.value, { agent: "claude", channel: "peer-socket", agentVersion: "2.1.200", ok: false, error: "not consumed", now: Date.now() });
    const run = await runWorker(current);
    expect(inbox.connections).toBe(1);
    expect(run.sends).toHaveLength(0);
    expect(run.channel).toMatchObject({ status: "broken", agentVersion: "2.1.200", failures: 1 });
  });

  test("a Claude without the peer protocol is typed to and recorded broken", async () => {
    const current = await scene("idle", { protocol: null });
    const run = await runWorker(current);
    expect(run.sends).toHaveLength(1);
    expect(run.channel).toMatchObject({ status: "broken", agentVersion: "2.1.296" });
  });

  test("a lost lease after socket acceptance never causes a duplicate typed send", async () => {
    const current = await scene("busy");
    const db = stateDatabase({ HOME: current.root, MEGABRAIN_STATE_DIR: current.root });
    if (db.kind !== "ok") throw new Error(db.error);
    const steal = () => { db.value.db.run("UPDATE outbox SET lease_holder = 'another-worker'"); };
    await startInbox(String(current.session.messagingSocketPath), steal);
    const run = await runWorker(current);
    expect(run.sends).toHaveLength(0);
    expect(run.deliveries[0]).toMatchObject({ transport: "ack-verifying" });
  });

  test("a parent session that cannot be found says nothing about the channel", async () => {
    const current = await scene();
    await rm(join(current.root, ".claude", "sessions", "41414.json"));
    const run = await runWorker(current);
    expect(run.sends).toHaveLength(1);
    expect(run.channel).toBeUndefined();
  });
});
