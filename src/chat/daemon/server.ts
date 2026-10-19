// Internal chat daemon server operations.
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
import { CHAT_PROTOCOL_MIN_VERSION, type ChatDaemon } from "../daemon.js";
import { DRAINING, DEFAULT_TERMINAL_POLL_MS, DEFAULT_HANDOVER_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, timeoutsFor, heldMessage, SessionHeldError, unsentTerminalText, object, text, validateParts, firstText, event, withImages, withMessage, flattenContent, codexReasoning, count, instances, timeoutMs } from "../daemon.js";
import type { Part, Request, Response, Environment, Timeouts, ArtifactWatch } from "../daemon.js";

export async function start(daemon: ChatDaemon): Promise<void> {
    const dir = join(daemon.stateDir, "chatd");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    if (await socketAccepts(daemon.stateDir, DEFAULT_CONNECT_TIMEOUT_MS)) throw new Error("chatd is already running");
    await discardStaleState(daemon.stateDir, { pid: true });
    await daemon.store.initialize();
    // The one-time registry migration runs here, before anything is live, so it can never collect a chat chatd is using.
    try { readConversations(daemon.stateDir); } catch { /* a locked registry is retried by the next write */ }
    await daemon.pruneUnused();
    await daemon.suspendActive();
    for (const chat of await daemon.store.list()) {
      if (chat.owner !== undefined) continue;
      chat.owner = chat.mode === "terminal" ? "terminal" : "none";
      await daemon.store.put(chat);
    }
    await writeFile(chatPid(daemon.stateDir), `${process.pid}\n`, { mode: 0o600 });
    await chmod(chatPid(daemon.stateDir), 0o600);
    await daemon.resumeDrained();
    daemon.startKnowledge();
    await daemon.syncTerminalPolling();
  }

export async function handle(daemon: ChatDaemon, request: Request, socket?: Socket): Promise<unknown> {
    if (daemon.closed) throw new Error("chatd is closed");
    daemon.clients += 1;
    if (daemon.idleTimer !== undefined) clearTimeout(daemon.idleTimer);
    try {
      return await dispatchRequest(daemon, request, socket);
    } finally {
      daemon.clients -= 1;
      daemon.scheduleExit();
    }
  }

export async function startChat(daemon: ChatDaemon, request: Request): Promise<Chat> {
    if (daemon.draining) throw new Error(DRAINING);
    const agent = text(request.agent);
    if (agent !== "claude" && agent !== "codex" && agent !== "grok" && agent !== "agy") throw new Error("--agent must be claude, codex, grok, or agy");
    const cwd = text(request.cwd);
    if (!cwd || !cwd.startsWith("/")) throw new Error("--cwd must be an absolute path");
    const parts = request.parts === undefined ? [] : await daemon.normalizeParts(cwd, validateParts(request.parts));
    const now = new Date().toISOString();
    const chat: Chat = {
      id: randomUUID(), agent, capabilities: agent === "agy" ? { approvals: false, interrupt: false, liveModelSwitch: false, steer: false, structuredTools: true } : { approvals: true, interrupt: true, liveModelSwitch: agent === "grok", steer: agent === "codex", structuredTools: true }, cwd, model: text(request.model) || null, ...(text(request.effort) ? { effort: text(request.effort) } : {}), ...(request.approvals === true && agent !== "agy" ? { approvals: true } : {}),
      title: firstText(parts).slice(0, 120) || null, titleSource: "first-message", summary: null, state: agent === "agy" ? "idle" : "starting", mode: agent === "agy" ? "terminal" : "chat", owner: agent === "agy" ? "terminal" : "none",
      agentSessionId: null, createdAt: now, lastActivityAt: now, error: null,
    };
    await daemon.save(chat);
    await daemon.syncTerminalPolling();
    await daemon.publish(chat, event("system", `Started ${agent} chat`));
    const queue = daemon.queues.get(chat.id) ?? [];
    if (parts.length > 0) { queue.push(parts); daemon.queues.set(chat.id, queue); await daemon.publish(chat, event("user", firstText(parts), undefined, withImages(parts))); }
    if (agent !== "agy") daemon.trackCallback(daemon.runAgent(chat).catch((error: unknown) => daemon.fail(chat.id, error)));
    return chat;
  }

export async function suspendActive(daemon: ChatDaemon): Promise<string[]> {
    const interrupted: string[] = [];
    for (const chat of await daemon.store.list()) {
      if (chat.state === "error" || chat.mode === "terminal") continue;
      const child = daemon.children.get(chat.id);
      if (child) {
        daemon.children.delete(chat.id);
        await stopChild(child);
        try { await unlink(chatChildRecord(daemon.stateDir, chat.id)); } catch { /* process exited before its record was written */ }
      }
      daemon.clearStartTimer(chat.id);
      for (const map of [daemon.queues, daemon.activeTurns]) map.delete(chat.id);
      if (chat.state === "working" || chat.state === "waiting-approval") {
        interrupted.push(chat.id);
        await daemon.publishTurnCut(chat, "process-exited", "chat daemon restarted while the turn was active");
        await daemon.publish(chat, event("system", "Interrupted"));
      }
      const latestTasks = new Map<string, import("../store.js").BackgroundTask>();
      for (const line of await daemon.store.events(chat.id)) {
        const task = line.event?.backgroundTask;
        if (task) latestTasks.set(task.id, task);
      }
      for (const task of latestTasks.values()) if (task.state === "running") await daemon.publishBackgroundTask(chat, { ...task, state: "lost", endedAt: new Date().toISOString(), summary: "Chat daemon restarted before the task reported completion" });
      if (chat.state === "suspended") continue;
      chat.state = "suspended";
      chat.owner = "none";
      chat.error = null;
      await daemon.save(chat);
    }
    return interrupted;
  }

export async function handover(daemon: ChatDaemon): Promise<{ handedOver: true; waitedMs: number; interrupted: string[] }> {
    const bound = timeoutMs(daemon.environment.MEGABRAIN_CHATD_HANDOVER_TIMEOUT_MS, DEFAULT_HANDOVER_TIMEOUT_MS);
    const started = Date.now();
    while (await daemon.busy() && Date.now() - started < bound) await new Promise((resolve) => setTimeout(resolve, 50));
    const interrupted = await daemon.suspendActive();
    await Promise.all([...daemon.eventChains.values(), ...daemon.appendChains.values()]);
    daemon.exitReason = "protocol-handover";
    await daemon.close();
    return { handedOver: true, waitedMs: Date.now() - started, interrupted };
  }

export async function busy(daemon: ChatDaemon): Promise<boolean> {
    return (await daemon.store.list()).some((chat) => chat.mode === "chat" && (chat.state === "working" || chat.state === "waiting-approval"));
  }

export async function liveChats(daemon: ChatDaemon): Promise<number> {
    let live = 0;
    for (const chat of await daemon.store.list()) if (chat.mode === "chat" && (chat.state === "working" || chat.state === "waiting-approval" || (await daemon.loadQueue(chat.id)).length > 0)) live += 1;
    return live;
  }

export async function daemonStatus(daemon: ChatDaemon): Promise<{ pid: number; protocol: { version: number; min: number; max: number }; daemonVersion: string; superseded: boolean; liveChats: number; build: number; draining: boolean; working: string[]; terminalRefreshError?: string }> {
    const working = (await daemon.store.list()).filter((chat) => chat.mode === "chat" && (chat.state === "working" || chat.state === "waiting-approval")).map((chat) => chat.id);
    let liveChats = 0;
    for (const chat of await daemon.store.list()) if (chat.mode === "chat" && (chat.state === "working" || chat.state === "waiting-approval" || (await daemon.loadQueue(chat.id)).length > 0)) liveChats += 1;
    return { pid: process.pid, protocol: { version: daemon.protocol, min: CHAT_PROTOCOL_MIN_VERSION, max: daemon.protocol }, daemonVersion: daemon.version, superseded: daemon.superseded, liveChats, build: daemon.build, draining: daemon.draining, working, ...(daemon.terminalRefreshError === null ? {} : { terminalRefreshError: daemon.terminalRefreshError }) };
  }

export async function drainDaemon(daemon: ChatDaemon): Promise<{ drained: true; waitedMs: number; resumes: string[] }> {
    daemon.draining = true;
    const started = Date.now();
    while (await daemon.busy()) await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all([...daemon.eventChains.values(), ...daemon.appendChains.values(), ...daemon.queueWrites.values()]);
    for (const chat of await daemon.store.list()) if (chat.mode === "chat" && (await daemon.loadQueue(chat.id)).length > 0) daemon.resumeOnStart.add(chat.id);
    const resumes = [...daemon.resumeOnStart];
    if (resumes.length > 0) await writeFile(chatResumes(daemon.stateDir), `${JSON.stringify(resumes)}\n`, { mode: 0o600 });
    await daemon.suspendActive();
    await Promise.all([...daemon.eventChains.values(), ...daemon.appendChains.values()]);
    daemon.exitReason = "drained";
    await daemon.close();
    return { drained: true, waitedMs: Date.now() - started, resumes };
  }

export async function retireDaemon(daemon: ChatDaemon): Promise<{ retired: true; waitedMs: number }> {
    daemon.superseded = true;
    const started = Date.now();
    while (await liveChats(daemon) > 0) await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all([...daemon.eventChains.values(), ...daemon.appendChains.values(), ...daemon.queueWrites.values()]);
    await daemon.suspendActive();
    await Promise.all([...daemon.eventChains.values(), ...daemon.appendChains.values()]);
    daemon.exitReason = "retired";
    await daemon.close();
    return { retired: true, waitedMs: Date.now() - started };
  }

export function scheduleExit(daemon: ChatDaemon): void {
    if (daemon.closed || daemon.clients > 0 || [...daemon.children.values()].some((child) => child.exitCode === null)) return;
    if (daemon.idleTimer !== undefined) clearTimeout(daemon.idleTimer);
    daemon.idleTimer = setTimeout(() => { void daemon.close(); }, 10 * 60_000);
    daemon.idleTimer.unref?.();
  }

export function close(daemon: ChatDaemon): Promise<void> {
    if (daemon.closing !== undefined) return daemon.closing;
    daemon.closing = daemon.closeDaemon();
    return daemon.closing;
  }

export async function closeDaemon(daemon: ChatDaemon): Promise<void> {
    daemon.closed = true;
    daemon.appControl.close();
    daemon.summarizer.close();
    daemon.idleTimer && clearTimeout(daemon.idleTimer);
    for (const timer of daemon.knowledgeTimers) clearTimeout(timer);
    daemon.knowledgeTimers.length = 0;
    for (const id of daemon.startTimers.keys()) daemon.clearStartTimer(id);
    for (const pending of daemon.pendingApprovals.values()) pending.resolve("deny");
    daemon.pendingApprovals.clear();
    for (const id of daemon.artifactWatches.keys()) daemon.stopArtifactWatch(id);
    if (daemon.terminalTimer !== undefined) clearInterval(daemon.terminalTimer);
    for (const watcher of daemon.terminalFileWatches.values()) watcher.close();
    daemon.terminalFileWatches.clear();
    await daemon.terminalRefresh;
    daemon.server?.close();
    daemon.server = undefined;
    // An agent left running here would outlive the daemon, reparented to init with nobody to stop it; the next
    // daemon must not find it still holding its session either.
    const children = [...daemon.children.entries()];
    daemon.children.clear();
    await Promise.all(children.map(([, child]) => stopChild(child)));
    await Promise.all([...daemon.agentRuns, ...daemon.childExits, ...daemon.callbacks]);
    await Promise.all(daemon.knowledgeTasks);
    await Promise.all([...daemon.eventChains.values(), ...daemon.appendChains.values(), ...daemon.queueWrites.values()]);
    await Promise.all([...daemon.agentRuns, ...daemon.childExits, ...daemon.callbacks, ...daemon.knowledgeTasks]);
    await writeFile(join(daemon.stateDir, "chatd", "exit.json"), `${JSON.stringify({ pid: process.pid, daemonVersion: daemon.version, reason: daemon.exitReason, exitedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    await Promise.all(children.map(async ([id, child]) => {
      const record = chatChildRecord(daemon.stateDir, id);
      await readFile(record, "utf8").then(async (raw) => {
        if (Number(object(JSON.parse(raw)).pid) === child.pid) await unlink(record);
      }).catch(() => undefined);
    }));
    // The caller of a handover still has its answer in flight; everything else is dropped shortly after so the process can leave.
    const open = [...daemon.sockets];
    setTimeout(() => { for (const socket of open) socket.destroy(); }, 100).unref?.();
    try { await (await import("node:fs/promises")).unlink(chatSocket(daemon.stateDir)); } catch { /* already closed */ }
    try { await (await import("node:fs/promises")).unlink(chatPid(daemon.stateDir)); } catch { /* already closed */ }
    instances.delete(daemon.stateDir);
  }

export async function listen(daemon: ChatDaemon): Promise<void> {
    if (await socketAccepts(daemon.stateDir, DEFAULT_CONNECT_TIMEOUT_MS)) throw new Error("chatd is already running");
    await discardStaleState(daemon.stateDir, { pid: false });
    return new Promise((resolve, reject) => {
      const socketPath = chatSocket(daemon.stateDir);
      daemon.server = createServer((socket) => {
        daemon.sockets.add(socket);
        socket.once("close", () => daemon.sockets.delete(socket));
        daemon.clients += 1;
        if (daemon.idleTimer !== undefined) clearTimeout(daemon.idleTimer);
        socket.once("close", () => { daemon.clients -= 1; daemon.scheduleExit(); });
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const end = buffer.indexOf("\n");
            if (end === -1) break;
            const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            let request: Request;
            try { request = JSON.parse(raw) as Request; }
            catch { socket.end(`${JSON.stringify({ ok: false, error: "invalid request" })}\n`); return; }
            void daemon.handle(request, socket).then((value) => {
              if (socket.destroyed || request.operation === "events" && request.follow === true) return;
              const response = `${JSON.stringify({ ok: true, value })}\n`;
              if (request.operation === "app-connect" || request.operation === "app-reply") socket.write(response);
              else socket.end(response);
            }).catch((error: unknown) => {
              if (socket.destroyed) return;
              const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
              const liveChats = typeof error === "object" && error !== null && "liveChats" in error ? Number((error as { liveChats?: unknown }).liveChats) : undefined;
              socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), ...(typeof code === "string" ? { code } : {}), ...(liveChats === undefined ? {} : { liveChats }) })}\n`);
            });
          }
        });
      });
      daemon.server.once("error", reject);
      daemon.server.listen(socketPath, () => { void chmod(socketPath, 0o600).then(resolve, reject); });
    });
  }
