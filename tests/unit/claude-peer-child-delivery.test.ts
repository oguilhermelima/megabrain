import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { appendMessage, createDelivery, createDispatch, getDeliveryChannel, listDeliveries, listOutbox, stateDatabase } from "../../src/adapters/state-db.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { claudeSessionPermissionClass } from "../../src/agents/claude-peer.js";
import { executeDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";
import { failed, ok } from "../../src/core/result.js";

// A reply from the parent to a Claude child goes through the child's peer socket, the same channel
// a parent notice uses. The sender is the parent here, so the attested permission class is the
// parent's own, read from the mode its transcript last recorded; megabrain never claims one it
// cannot read.

const fixture = (name: string) => readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const cleanup: Array<() => Promise<void>> = [];
const PARENT_SESSION = "parent-session-0001";

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
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

type Scene = { root: string; session: Record<string, unknown>; transcript: string; parentTranscript: string };

const userEntry = (mode: string) => JSON.stringify({ type: "user", permissionMode: mode, message: { role: "user", content: "go" } });

// The child is a live Claude session with a peer socket; the parent only needs its transcript.
async function scene(status: "idle" | "busy", parentModes: readonly string[] | undefined, childMode?: string): Promise<Scene> {
  const root = await mkdtemp("/tmp/mbpeerchild-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const session = JSON.parse(await fixture("claude-session-peer.json")) as Record<string, unknown>;
  session.status = status;
  session.messagingSocketPath = join(root, "inbox.sock");
  const sessions = join(root, ".claude", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, "41414.json"), JSON.stringify(session));
  await writeFile(join(sessions, "41414.a1b2c3d4.key"), await fixture("claude-session-peer.key.json"), { mode: 0o600 });
  const project = join(root, ".claude", "projects", "-Users-example-Workspaces-project");
  await mkdir(project, { recursive: true });
  const transcript = join(project, `${String(session.sessionId)}.jsonl`);
  await writeFile(transcript, `${childMode === undefined ? JSON.stringify({ type: "user", message: { role: "user", content: "brief" } }) : userEntry(childMode)}\n`);
  const parentTranscript = join(project, `${PARENT_SESSION}.jsonl`);
  if (parentModes !== undefined) await writeFile(parentTranscript, parentModes.map((mode) => mode === "" ? JSON.stringify({ type: "assistant" }) : userEntry(mode)).join("\n") + "\n");
  return { root, session, transcript, parentTranscript };
}

const consume = (current: Scene) => async (frames: Frame[]) => {
  const message = frames.find((frame) => frame.type === "user");
  if (message === undefined) return;
  await appendFile(current.transcript, `${JSON.stringify({ type: "user", origin: { kind: "peer", msg_id: message.msg_id } })}\n`);
};

async function runReply(current: Scene, parentAgent = "claude", deadlineMs = 5000) {
  const db = stateDatabase({ HOME: current.root, MEGABRAIN_STATE_DIR: current.root });
  if (db.kind !== "ok") throw new Error(db.error);
  const meta = {
    agent: "claude", agentPid: 41414, agentSessionId: current.session.sessionId, runtime: "host", childHost: "orca", workspaceId: "workspace", terminalId: "child-terminal",
    parentAgent, parentAgentPid: 52525, parentAgentSessionId: PARENT_SESSION, parentHost: "orca", parentTerminalId: "parent-terminal",
  };
  createDispatch(db.value, { dispatchId: "d-child", state: "running", ...meta });
  appendMessage(db.value, "d-child", { from: "parent", type: "reply", text: "use the second option" }, {
    outbox: { id: "ob-child", targetKind: "child-delivery", target: "orca:child-terminal", payload: { dispatchId: "d-child", sequence: 1, meta, targetKind: "child-delivery", fullMessage: "↩ reply: use the second option" } },
  });
  createDelivery(db.value, { id: "dl-child", dispatchId: "d-child", messageSeqs: [1], status: "outstanding" });
  const screen = JSON.parse(await fixture("orca-terminal-screen-claude-idle.json")) as unknown;
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
  await executeDeliveryWorker(["ob-child", "holder", "delivery-target:orca:child-terminal", String(Date.now() + deadlineMs)], { HOME: current.root, MEGABRAIN_STATE_DIR: current.root, MEGABRAIN_PEER_IDLE_DROP_MS: "300" }, process);
  const outbox = listOutbox(db.value);
  const deliveries = listDeliveries(db.value, "d-child");
  const channel = getDeliveryChannel(db.value, "claude", "peer-socket");
  return {
    sends,
    outbox: outbox.kind === "ok" ? outbox.value : [],
    deliveries: deliveries.kind === "ok" ? deliveries.value : [],
    channel: channel.kind === "ok" ? channel.value : undefined,
  };
}

describe("parent permission class", () => {
  test("is bypass when the parent's transcript last recorded bypassPermissions", async () => {
    const current = await scene("idle", ["default", "bypassPermissions", ""]);
    expect(await claudeSessionPermissionClass(current.root, PARENT_SESSION)).toBe("bypass");
  });

  test("follows the latest recorded mode, so a parent that left bypass is prompting", async () => {
    const current = await scene("idle", ["bypassPermissions", "acceptEdits"]);
    expect(await claudeSessionPermissionClass(current.root, PARENT_SESSION)).toBe("prompting");
  });

  test("is unknown when no transcript or no recorded mode exists", async () => {
    expect(await claudeSessionPermissionClass((await scene("idle", undefined)).root, PARENT_SESSION)).toBeUndefined();
    expect(await claudeSessionPermissionClass((await scene("idle", [""])).root, PARENT_SESSION)).toBeUndefined();
  });
});

describe("reply to a Claude child", () => {
  test("goes through the child's peer socket attesting the bypass parent, and never types", async () => {
    const current = await scene("idle", ["bypassPermissions"]);
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runReply(current);
    expect(inbox.connections).toBe(1);
    const content = String(((inbox.frames[0]?.[1])?.message as Frame).content);
    expect(content).toStartWith('<cross-session-message from-name="megabrain" from-mode="bypass">');
    expect(content).toContain("use the second option");
    expect(run.sends).toHaveLength(0);
    expect(run.outbox[0]?.status).toBe("sent");
    expect(run.deliveries[0]).toMatchObject({ transport: "socket" });
    expect(run.channel).toMatchObject({ status: "working", failures: 0 });
  });

  test("reaches a busy child without waiting for it to go idle", async () => {
    const current = await scene("busy", ["bypassPermissions"]);
    const late = async (frames: Frame[]) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await consume(current)(frames);
    };
    await startInbox(String(current.session.messagingSocketPath), late);
    const run = await runReply(current);
    expect(run.sends).toHaveLength(0);
    expect(run.deliveries[0]).toMatchObject({ transport: "socket" });
  });

  test("a parent outside bypass is never attested: the socket is skipped and the reply is typed", async () => {
    const current = await scene("idle", ["bypassPermissions", "default"]);
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runReply(current);
    expect(inbox.connections).toBe(0);
    expect(run.sends).toHaveLength(1);
    expect(run.channel).toBeUndefined();
  });

  test("a parent whose mode cannot be read is never attested either", async () => {
    const current = await scene("idle", undefined);
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runReply(current);
    expect(inbox.connections).toBe(0);
    expect(run.sends).toHaveLength(1);
  });

  test("a parent that is not Claude keeps the typed path", async () => {
    const current = await scene("idle", ["bypassPermissions"]);
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runReply(current, "codex");
    expect(inbox.connections).toBe(0);
    expect(run.sends).toHaveLength(1);
  });

  test("a child still in bypass, read from its own transcript, takes a bypass parent's reply through the socket", async () => {
    const current = await scene("idle", ["bypassPermissions"], "bypassPermissions");
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runReply(current);
    expect(String(((inbox.frames[0]?.[1])?.message as Frame).content)).toStartWith('<cross-session-message from-name="megabrain" from-mode="bypass">');
    expect(run.sends).toHaveLength(0);
  });

  test("a child that left bypass takes a reply from a parent that also prompts, attesting prompting", async () => {
    const current = await scene("idle", ["default"], "acceptEdits");
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runReply(current);
    expect(inbox.connections).toBe(1);
    expect(String(((inbox.frames[0]?.[1])?.message as Frame).content)).toStartWith('<cross-session-message from-name="megabrain" from-mode="prompting">');
    expect(run.sends).toHaveLength(0);
    expect(run.deliveries[0]).toMatchObject({ transport: "socket" });
  });

  test("a child that left bypass is typed to from a bypass parent without trying the socket", async () => {
    const current = await scene("idle", ["bypassPermissions"], "default");
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runReply(current);
    expect(inbox.connections).toBe(0);
    expect(run.sends).toHaveLength(1);
    expect(run.channel).toBeUndefined();
  });

  test("a child that prompts takes a reply from a parent that is not Claude with no class attested", async () => {
    const current = await scene("idle", undefined, "default");
    const inbox = await startInbox(String(current.session.messagingSocketPath), consume(current));
    const run = await runReply(current, "codex");
    expect(inbox.connections).toBe(1);
    expect(String(((inbox.frames[0]?.[1])?.message as Frame).content)).toStartWith('<cross-session-message from-name="megabrain">\n');
    expect(run.sends).toHaveLength(0);
  });

  test("a child that drops the message falls back to typing and marks the channel broken", async () => {
    const current = await scene("idle", ["bypassPermissions"]);
    await startInbox(String(current.session.messagingSocketPath));
    const run = await runReply(current);
    expect(run.sends).toHaveLength(1);
    expect(run.deliveries[0]).toMatchObject({ transport: "typed" });
    expect(run.channel).toMatchObject({ status: "broken", failures: 1 });
  });
});
