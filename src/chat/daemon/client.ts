// Chat daemon socket client and lifecycle entry points.
import { scrubAgentEnvironment } from "../../core/agent-env.js";
import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { chatKey, promoteConversation, readConversations, removeConversation, sessionKey, setConversationAlias, upsertConversation, type Conversation } from "../../core/conversations.js";
import { OWNED_TMUX_SERVER, ownedTmuxProcess, readOwnedSessions, writeOwnedSessions } from "../../core/session-ownership.js";
import { liveSessionHolders, type SessionHolder } from "../../core/session-holders.js";
import { APP_SESSION_PREFIX, forgetAppTerminal } from "../../core/app-terminals.js";
import { chmod, mkdir, open, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ChatStore, type Chat, type ChatApproval, type ChatEvent, type ChatLine, type ChatProgress, type QueuedChatMessage } from ".././store.js";
import { chatProtocolAdapters, type MessagePart } from ".././protocol.js";
import { discoverSessionId, readSessionTurns, sessionLogPath, sessionTurnOpen } from ".././session-log.js";
import { claudeHandBack, claudeNotified, claudeSubagent, codexEnded, codexSpawned, isClaudeSubagentTool, type Subagent, type SubagentEnd } from ".././subagents.js";
import { selfInvocation } from "../../core/self-invocation.js";
import { KnowledgePipeline } from "../../knowledge/pipeline.js";
import { ChatSummarizer } from ".././summaries.js";
import { chatArtifactFileFingerprint, chatArtifactSignature, chatArtifactStoreFingerprint, listChatArtifacts, listClaudeChatArtifacts, listMegabrainChatArtifacts, type ChatArtifact } from ".././artifacts.js";
import { chatChildRecord, chatLock, chatPid, chatResumes, chatSocket, discardStaleState, filePid, pidAlive, socketAccepts, stopChild } from "./process-state.js";
import { dispatchRequest } from "./dispatch.js";
import { startKnowledge } from "./knowledge-wiring.js";
import { ChatDaemon, CHAT_PROTOCOL_VERSION, DRAINING, DEFAULT_TERMINAL_POLL_MS, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, timeoutsFor, timeoutMs, object, text, instances, chatBuild } from "../daemon.js";
import type { Part, Request, Response, Environment, Timeouts } from "../daemon.js";

async function socketRequest(stateDir: string, request: Request, timeouts: Timeouts | { connect: number; request: undefined }, onLine?: (line: ChatLine) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(chatSocket(stateDir));
    let buffer = "";
    let responseSeen = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number | undefined, message: string, code?: string) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = ms === undefined ? undefined : setTimeout(() => { reject(Object.assign(new Error(message), code === undefined ? {} : { code })); socket.destroy(); }, ms);
    };
    arm(timeouts.connect, `chatd did not accept the connection within ${timeouts.connect / 1000} s`, "ETIMEDOUT");
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      arm(timeouts.request, `chatd did not answer within ${(timeouts.request ?? 0) / 1000} s`);
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      // A following call has no final reply; the first line proves the daemon answers, and its death ends the socket.
      if (request.follow === true) arm(undefined, "");
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const parsed = JSON.parse(line) as Response | ChatLine;
          if ("ok" in parsed) {
            responseSeen = true;
            arm(undefined, "");
            if (parsed.ok) resolve(parsed.value);
            else reject(Object.assign(new Error(parsed.error), { code: parsed.code }));
            if (!request.follow) socket.end();
          } else onLine?.(parsed);
        } catch (error) { reject(error); socket.destroy(); }
      }
    });
    socket.once("error", (error) => { arm(undefined, ""); reject(error); });
    socket.once("close", () => {
      arm(undefined, "");
      if (!responseSeen) reject(new Error(request.follow === true ? "chatd stopped while following events" : "chatd closed the connection"));
    });
  });
}

export async function runChatd(stateDir: string): Promise<void> {
  const daemon = new ChatDaemon(stateDir);
  await daemon.start();
  await daemon.listen();
  instances.set(stateDir, daemon);
  try { await unlink(chatLock(stateDir)); } catch { /* no client lock during direct starts */ }
}

/**
 * A running chatd of another protocol version is asked to hand over: it waits for working chats, suspends the rest and
 * leaves, so the caller's next request finds no socket and starts a current daemon. One that predates the handshake
 * cannot be asked, and is used as it is.
 */
async function ensureProtocol(stateDir: string, timeouts: Timeouts): Promise<void> {
  let hello: Record<string, unknown> = {};
  try { hello = object(await socketRequest(stateDir, { operation: "hello" }, timeouts)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOENT") throw error;
  }
  const protocol = hello.protocol;
  // Same protocol, older build: it drains in the background, still answering, and this call goes on with it.
  if (protocol === CHAT_PROTOCOL_VERSION && typeof hello.build === "number" && chatBuild() > hello.build) {
    try { await socketRequest(stateDir, { operation: "drain", wait: false }, timeouts); } catch { /* a chatd without drain keeps serving */ }
    return;
  }
  if (protocol === CHAT_PROTOCOL_VERSION || protocol === undefined) return;
  await socketRequest(stateDir, { operation: "handover" }, { connect: timeouts.connect, request: undefined });
  for (let attempt = 0; attempt < 100 && await socketAccepts(stateDir, 200); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
}

type Starter = { startDetached(command: string, args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<{ kind: string; error?: string }> };

/**
 * A request a draining chatd refuses (a new turn it cannot start) waits until that chatd has gone, then goes to
 * the next one, which this call starts.
 */
export async function callChatd(stateDir: string, request: Request, environment: Environment, processAdapter: Starter, onLine?: (line: ChatLine) => void): Promise<unknown> {
  try { return await callChatdOnce(stateDir, request, environment, processAdapter, onLine); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes(DRAINING)) throw error;
    await untilChatdGone(stateDir);
    return callChatdOnce(stateDir, request, environment, processAdapter, onLine);
  }
}

async function untilChatdGone(stateDir: string): Promise<void> {
  for (;;) {
    const local = instances.get(stateDir);
    if (local === undefined && !await socketAccepts(stateDir, 200)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export type ChatdStatus = Readonly<{ running: false } | { running: true; pid: number; protocol: number; build: number; draining: boolean; working: string[] }>;

/** The running chatd as it reports itself; never starts one. */
export async function chatdStatus(stateDir: string): Promise<ChatdStatus> {
  const local = instances.get(stateDir);
  if (local !== undefined) return { running: true, ...await local.handle({ operation: "daemon-status" }) as Omit<Extract<ChatdStatus, { running: true }>, "running"> };
  if (!existsSync(chatSocket(stateDir)) || !await socketAccepts(stateDir, DEFAULT_CONNECT_TIMEOUT_MS)) return { running: false };
  const status = object(await socketRequest(stateDir, { operation: "daemon-status" }, { connect: DEFAULT_CONNECT_TIMEOUT_MS, request: DEFAULT_REQUEST_TIMEOUT_MS }));
  return { running: true, pid: Number(status.pid), protocol: Number(status.protocol), build: Number(status.build), draining: status.draining === true, working: Array.isArray(status.working) ? status.working.filter((id): id is string => typeof id === "string") : [] };
}

/** Drains the running chatd and waits until it has exited: every turn finished, queued messages left for the next one. */
export async function drainChatd(stateDir: string): Promise<Readonly<{ running: false } | { running: true; drained: true; waitedMs: number; resumes: string[] }>> {
  const local = instances.get(stateDir);
  if (local === undefined && (!existsSync(chatSocket(stateDir)) || !await socketAccepts(stateDir, DEFAULT_CONNECT_TIMEOUT_MS))) return { running: false };
  const result = object(local === undefined
    ? await socketRequest(stateDir, { operation: "drain" }, { connect: DEFAULT_CONNECT_TIMEOUT_MS, request: undefined })
    : await local.handle({ operation: "drain" }));
  await untilChatdGone(stateDir);
  return { running: true, drained: true, waitedMs: Number(result.waitedMs), resumes: Array.isArray(result.resumes) ? result.resumes.filter((id): id is string => typeof id === "string") : [] };
}

async function callChatdOnce(stateDir: string, request: Request, environment: Environment, processAdapter: Starter, onLine?: (line: ChatLine) => void): Promise<unknown> {
  const local = instances.get(stateDir);
  if (local) return local.handle(request);
  const timeouts = timeoutsFor(environment);
  const dir = join(stateDir, "chatd");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const transportFailure = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ECONNREFUSED" || code === "ENOENT";
  };
  const requestWhenReady = async (): Promise<unknown> => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      try { return await socketRequest(stateDir, request, timeouts, onLine); }
      catch (error) {
        if (!transportFailure(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const ownerAlive = pidAlive(await filePid(chatLock(stateDir)));
    if (!ownerAlive) {
      try { await unlink(chatLock(stateDir)); } catch { /* another client cleaned it */ }
      await discardStaleState(stateDir, { pid: true });
      return callChatdOnce(stateDir, request, environment, processAdapter, onLine);
    }
    throw new Error("chatd did not become ready in time");
  };
  if (existsSync(chatSocket(stateDir))) {
    try {
      await ensureProtocol(stateDir, timeouts);
      return await socketRequest(stateDir, request, timeouts, onLine);
    }
    catch (error) {
      if (!transportFailure(error)) throw error;
      // The socket belongs to a dead chatd unless a starter holds a live lock; clean up and start one fresh daemon.
      if (!pidAlive(await filePid(chatLock(stateDir)))) {
        try { await unlink(chatLock(stateDir)); } catch { /* no lock */ }
        await discardStaleState(stateDir, { pid: true });
      }
    }
  }
  let lock;
  try {
    lock = await open(chatLock(stateDir), "wx", 0o600);
    await lock.writeFile(`${process.pid}\n`);
    await lock.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return requestWhenReady();
  }
  try {
    const invocation = selfInvocation(process.execPath, process.argv, ["__chatd"]);
    const launched = await processAdapter.startDetached(invocation.command, invocation.args, { env: { ...scrubAgentEnvironment({ ...process.env, ...environment }), MEGABRAIN_CHATD_STATE_DIR: stateDir } });
    if (launched.kind === "ok") return await requestWhenReady();
    // Embedded callers such as the test router share a process; production launches a detached owner.
    const daemon = new ChatDaemon(stateDir, environment);
    await daemon.start();
    await daemon.listen();
    instances.set(stateDir, daemon);
    try { await unlink(chatLock(stateDir)); } catch { /* already removed */ }
    return daemon.handle(request);
  } catch (error) {
    try { await unlink(chatLock(stateDir)); } catch { /* stale lock cleanup */ }
    throw error;
  }
}

export async function callPermissionServer(stateDir: string, chatId: string, request: Record<string, unknown>): Promise<unknown> {
  return socketRequest(stateDir, { operation: "permission", id: chatId, request }, { connect: DEFAULT_CONNECT_TIMEOUT_MS, request: undefined });
}
