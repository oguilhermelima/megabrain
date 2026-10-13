import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { appendMessage, createDelivery, createDispatch, getDeliveryChannel, listDeliveries, listDeliveryChannels, listOutbox, recordChannelResult, stateDatabase } from "../../src/adapters/state-db.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { resolveClaudePeer, sendClaudePeer } from "../../src/agents/claude-peer.js";
import { executeDatabase } from "../../src/cli/commands/db.js";
import { executeDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";
import { channelVerdict, nextRetryAt } from "../../src/core/delivery-channel.js";
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
type Inbox = { connections: number; frames: Frame[][] };

async function startInbox(path: string, onFrames: (frames: Frame[]) => Promise<void> | void = () => undefined): Promise<Inbox> {
  const inbox: Inbox = { connections: 0, frames: [] };
  const server: Server = createServer((socket) => {
    inbox.connections += 1;
    let buffer = "";
    socket.on("data", (chunk) => { buffer += chunk.toString(); });
    socket.on("end", () => {
      const frames = buffer.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Frame);
      inbox.frames.push(frames);
      void Promise.resolve(onFrames(frames)).finally(() => socket.end());
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return inbox;
}

async function received(inbox: Inbox, count = 1): Promise<void> {
  const deadline = Date.now() + 2000;
  while (inbox.frames.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
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
  await writeFile(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "earlier" } })}\n`);
  return { root, session, transcript, token: (JSON.parse(key) as { peerToken: string }).peerToken };
}

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

  test("a missing socket fails the send", async () => {
    const current = await scene();
    const target = await resolveClaudePeer(current.root, 41414, String(current.session.sessionId));
    if (target.kind !== "ok") throw new Error(target.kind);
    expect((await sendClaudePeer(target.value, "x")).kind).toBe("failed");
  });
});

async function runWorker(current: Scene, env: Record<string, string> = {}) {
  const db = stateDatabase({ HOME: current.root, MEGABRAIN_STATE_DIR: current.root });
  if (db.kind !== "ok") throw new Error(db.error);
  const meta = { agent: "codex", agentPid: 1, parentAgent: "claude", parentAgentPid: 41414, parentAgentSessionId: current.session.sessionId, parentHost: "orca", parentWorkspaceId: "workspace", parentTerminalId: "parent-terminal" };
  createDispatch(db.value, { dispatchId: "d-peer", state: "running", ...meta });
  appendMessage(db.value, "d-peer", { from: "child", type: "done", text: "finished" }, {
    outbox: { id: "ob-peer", targetKind: "parent-pointer", target: "orca:parent-terminal", payload: { dispatchId: "d-peer", sequence: 1, meta, pointer: "megabrain check", fullMessage: "✅ codex · lane finished" } },
  });
  createDelivery(db.value, { id: "dl-peer", dispatchId: "d-peer", messageSeqs: [1], status: "outstanding" });
  const screen = JSON.parse(await fixture("orca-terminal-screen-claude-idle.json")) as unknown;
  const sends: string[] = [];
  const process: ProcessAdapter = {
    async run(command, args) {
      if (command === "orca" && args[1] === "list") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "parent-terminal" }] }), stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "read") return ok<ProcessOutput>({ stdout: JSON.stringify(screen), stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "send") { sends.push(args.join(" ")); return ok<ProcessOutput>({ stdout: "{}", stderr: "", exitCode: 0 }); }
      return failed(`unexpected ${command} ${args.join(" ")}`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
  await executeDeliveryWorker(["ob-peer", "holder", "delivery-target:orca:parent-terminal", String(Date.now() + 5000)], { HOME: current.root, MEGABRAIN_STATE_DIR: current.root, MEGABRAIN_PEER_IDLE_DROP_MS: "300", ...env }, process);
  const outbox = listOutbox(db.value);
  const deliveries = listDeliveries(db.value, "d-peer");
  const channel = getDeliveryChannel(db.value, "claude", "peer-socket");
  return {
    sends,
    outbox: outbox.kind === "ok" ? outbox.value : [],
    deliveries: deliveries.kind === "ok" ? deliveries.value : [],
    channel: channel.kind === "ok" ? channel.value : undefined,
    db: db.value,
  };
}

describe("parent notice to a Claude parent", () => {
  test("goes through the peer socket and never types into the composer", async () => {
    const current = await scene();
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runWorker(current);
    expect(inbox.connections).toBe(1);
    expect(String(((inbox.frames[0]?.[1])?.message as Frame).content)).toContain("✅ codex · lane finished");
    expect(run.sends).toHaveLength(0);
    expect(run.outbox[0]?.status).toBe("sent");
    expect(run.deliveries[0]).toMatchObject({ transport: "socket" });
    expect(run.channel).toMatchObject({ status: "working", agentVersion: "2.1.296", failures: 0 });
  });

  test("waits while the parent is busy instead of calling the message dropped", async () => {
    const current = await scene("busy");
    const late = async (frames: Frame[]) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await consume(current)(frames);
    };
    await startInbox(String(current.session.messagingSocketPath), late);
    const run = await runWorker(current);
    expect(run.sends).toHaveLength(0);
    expect(run.deliveries[0]).toMatchObject({ transport: "socket" });
    expect(run.channel?.status).toBe("working");
  });

  test("a message the idle parent never consumes falls back to typing and marks the channel broken", async () => {
    const current = await scene();
    await startInbox(String(current.session.messagingSocketPath));
    const before = Date.now();
    const run = await runWorker(current);
    expect(run.sends).toHaveLength(1);
    expect(run.outbox[0]?.status).toBe("sent");
    expect(run.deliveries[0]).toMatchObject({ transport: "typed" });
    expect(run.channel).toMatchObject({ status: "broken", failures: 1, agentVersion: "2.1.296" });
    expect(Date.parse(String(run.channel?.retryAfter))).toBeGreaterThan(before);
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
    expect(run.channel).toMatchObject({ status: "working", agentVersion: "2.1.296", failures: 0 });
  });

  test("a Claude without the peer protocol is typed to and recorded broken", async () => {
    const current = await scene("idle", { protocol: null });
    const run = await runWorker(current);
    expect(run.sends).toHaveLength(1);
    expect(run.channel).toMatchObject({ status: "broken", agentVersion: "2.1.296" });
  });

  test("a lost lease while waiting on the socket ends the worker without typing", async () => {
    const current = await scene("busy");
    const db = stateDatabase({ HOME: current.root, MEGABRAIN_STATE_DIR: current.root });
    if (db.kind !== "ok") throw new Error(db.error);
    const steal = () => { db.value.db.run("UPDATE outbox SET lease_holder = 'another-worker'"); };
    await startInbox(String(current.session.messagingSocketPath), steal);
    const run = await runWorker(current);
    expect(run.sends).toHaveLength(0);
    expect(run.channel).toBeUndefined();
  });

  test("a parent session that cannot be found says nothing about the channel", async () => {
    const current = await scene();
    await rm(join(current.root, ".claude", "sessions", "41414.json"));
    const run = await runWorker(current);
    expect(run.sends).toHaveLength(1);
    expect(run.channel).toBeUndefined();
  });
});
