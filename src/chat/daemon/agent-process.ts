// Internal chat daemon agent process operations.
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
import { AcpPeer } from "../grok-acp.js";
import { discoverSessionId, latestClaudeContextTokens, readSessionTurns, sessionLogPath, sessionTurnOpen } from ".././session-log.js";
import { claudeHandBack, claudeNotified, claudeSubagent, codexEnded, codexSpawned, isClaudeSubagentTool, type Subagent, type SubagentEnd } from ".././subagents.js";
import { selfInvocation } from "../../core/self-invocation.js";
import { KnowledgePipeline } from "../../knowledge/pipeline.js";
import { ChatSummarizer } from ".././summaries.js";
import { chatArtifactFileFingerprint, chatArtifactSignature, chatArtifactStoreFingerprint, listChatArtifacts, listClaudeChatArtifacts, listMegabrainChatArtifacts, type ChatArtifact } from ".././artifacts.js";
import { chatChildRecord, chatLock, chatPid, chatResumes, chatSocket, discardStaleState, filePid, pidAlive, socketAccepts, stopChild } from "./process-state.js";
import type { ChatDaemon } from "../daemon.js";
import { scheduleAgentAutoUpdate } from "../../core/agent-update.js";
import { DRAINING, DEFAULT_TERMINAL_POLL_MS, DEFAULT_HANDOVER_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, timeoutsFor, heldMessage, SessionHeldError, unsentTerminalText, object, text, validateParts, firstText, event, withImages, withMessage, flattenContent, codexReasoning, count, instances, timeoutMs } from "../daemon.js";
import type { Part, Request, Response, Environment, Timeouts, ArtifactWatch } from "../daemon.js";

export function trackCallback(daemon: ChatDaemon, task: Promise<unknown>): void {
    daemon.callbacks.add(task);
    void task.then(() => daemon.callbacks.delete(task), () => daemon.callbacks.delete(task));
  }

export async function runAgent(daemon: ChatDaemon, chat: Chat, checked = false): Promise<void> {
    if (daemon.closed) return Promise.resolve();
    if (chat.agent === "claude" && (!Number.isSafeInteger(chat.contextTokens) || (chat.contextTokens ?? 0) <= 0) && chat.agentSessionId !== null) {
      const path = await sessionLogPath(chat, daemon.environment.HOME ?? homedir());
      if (path !== null) {
        try {
          const tokens = latestClaudeContextTokens(await readFile(path, "utf8"));
          if (tokens !== null && tokens > 0) { chat.contextTokens = tokens; await daemon.save(chat); }
        } catch { /* a missing or mid-write session log does not prevent resume */ }
      }
    }
    const run = daemon.runAgentInternal(chat, checked);
    daemon.agentRuns.add(run);
    void run.then(() => daemon.agentRuns.delete(run), () => daemon.agentRuns.delete(run));
    return run;
  }

export async function runAgentInternal(daemon: ChatDaemon, chat: Chat, checked = false): Promise<void> {
    if (daemon.closed) return;
    // One agent per chat: one daemon daemon still runs for it goes before the next starts, never left behind unowned.
    const previous = daemon.children.get(chat.id);
    if (previous) { daemon.children.delete(chat.id); await stopChild(previous); }
    if (!checked && chat.agentSessionId !== null) await daemon.clearTerminalHoldersBeforeResume(chat);
    void scheduleAgentAutoUpdate(chat.agent, daemon.environment, daemon.processes()).catch(() => undefined);
    const invocation = await chatProtocolAdapters[chat.agent].prepare(chat, daemon.stateDir);
    if (daemon.closed) return;
    const childEnvironment = scrubAgentEnvironment({ ...process.env, ...daemon.environment });
    // GROK_HOME is configuration and session storage, not a nested-agent marker; keep the isolated home selected by the host.
    if (chat.agent === "grok" && daemon.environment.GROK_HOME !== undefined) childEnvironment.GROK_HOME = daemon.environment.GROK_HOME;
    const child = spawn(invocation.command, invocation.args, { cwd: chat.cwd, env: { ...childEnvironment, MEGABRAIN_CHAT_ID: chat.id }, stdio: ["pipe", "pipe", "pipe"] });
    daemon.children.set(chat.id, child);
    await daemon.save(chat);
    const childRecord = chatChildRecord(daemon.stateDir, chat.id);
    await mkdir(join(daemon.stateDir, "chatd", "children"), { recursive: true, mode: 0o700 });
    await writeFile(childRecord, `${JSON.stringify({ pid: child.pid })}\n`, { mode: 0o600 });
    if (daemon.closed) return;
    daemon.outputSeen.delete(chat.id);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (daemon.closed) return;
      daemon.outputSeen.add(chat.id);
      daemon.clearStartTimer(chat.id);
      stdout += chunk;
      let end: number;
      while ((end = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
        if (line.trim() === "") continue;
        try {
          if (chat.agent === "grok") { daemon.acpPeers.get(chat.id)?.receive(line); continue; }
          const parsed = JSON.parse(line) as Record<string, unknown>;
          // A Codex answer settles its request at once: the event being handled may itself wait for it (a turn that ends starts the next).
          if (chat.agent === "codex" && daemon.settleRpc(chat.id, parsed)) continue;
          const previous = daemon.eventChains.get(chat.id) ?? Promise.resolve();
          const next = previous.then(() => chat.agent === "claude" ? daemon.handleClaude(chat.id, child, parsed) : daemon.handleCodex(chat.id, child, parsed)).catch((error: unknown) => daemon.fail(chat.id, error));
          daemon.eventChains.set(chat.id, next);
        } catch { daemon.trackCallback(daemon.fail(chat.id, new Error(`invalid ${chat.agent} protocol output`))); }
      }
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.once("error", (error) => { daemon.trackCallback(daemon.fail(chat.id, error)); });
    child.once("close", (code, signal) => {
      const settled = (async () => {
      await readFile(childRecord, "utf8").then(async (raw) => {
        if (Number(object(JSON.parse(raw)).pid) === child.pid) await unlink(childRecord);
      }).catch(() => undefined);
      daemon.acpPeers.get(chat.id)?.close(new Error(stderr.trim() || `${signal ?? "agent exited"}`));
      daemon.acpPeers.delete(chat.id);
      for (const waiter of daemon.rpcWaiters.get(chat.id)?.values() ?? []) waiter.reject(new Error(stderr.trim() || `${signal ?? "agent exited"}`));
      daemon.rpcWaiters.delete(chat.id);
      if (!daemon.closed) {
        await (daemon.eventChains.get(chat.id) ?? Promise.resolve());
        const tasks = daemon.backgroundTasks.get(chat.id);
        if (tasks) for (const task of tasks.values()) if (task.state === "running") await daemon.publishBackgroundTask(await daemon.requireChat(chat.id), { ...task, state: "killed", endedAt: new Date().toISOString(), summary: "agent process ended" });
      }
      if (daemon.closed || daemon.children.get(chat.id) !== child) return;
      daemon.clearStartTimer(chat.id);
      daemon.children.delete(chat.id);
      await daemon.store.get(chat.id).then(async (stored) => {
        if (!stored) return;
        const current = await daemon.requireChat(chat.id);
        if (current.state === "suspended" || current.state === "stopped" || current.mode === "terminal") { await daemon.save(current); return; }
        if (daemon.interrupting.has(chat.id)) {
          daemon.interrupting.delete(chat.id);
          await daemon.publishTurnCut(current, "interrupted");
          current.state = "idle";
          current.error = null;
          await daemon.save(current);
          await daemon.publishInterrupted(current);
          return;
        }
        // A turn the agent died in is over: its end says so, so no view keeps showing it run.
        const cut = current.state === "working" || current.state === "waiting-approval";
        current.state = code === 0 ? "idle" : "suspended";
        current.error = code === 0 ? null : `${signal ?? "agent exited"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
        if (code !== 0) daemon.queues.delete(chat.id);
        if (cut) await daemon.publishTurnCut(current, "process-exited", current.error ?? undefined);
        await daemon.save(current);
        if (cut) await daemon.publishInterrupted(current);
        else await daemon.publish(current, event("system", current.error ?? "Agent process stopped"));
      });
      })();
      daemon.childExits.add(settled);
      void settled.then(() => daemon.childExits.delete(settled), () => daemon.childExits.delete(settled));
    });
    if (chat.agent === "codex") {
      await daemon.codexRequest(child, "initialize", { clientInfo: { name: "megabrain", title: "Megabrain", version: "0.2.4" }, capabilities: { experimentalApi: true } });
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      const resumed = chat.agentSessionId !== null;
      const thread = await daemon.codexRequest(child, resumed ? "thread/resume" : "thread/start", { ...(resumed ? { threadId: chat.agentSessionId } : {}), cwd: chat.cwd, ...(chat.approvals === true ? { approvalPolicy: "on-request", sandbox: "workspace-write" } : { approvalPolicy: "never", sandbox: "danger-full-access" }) });
      const current = await daemon.requireChat(chat.id);
      current.agentSessionId = text(object(thread).thread && object(object(thread).thread).id) || text(object(thread).threadId) || current.agentSessionId;
      current.state = "idle";
      await daemon.save(current);
      await daemon.drain(chat.id);
    } else if (chat.agent === "grok") {
      const peer = new AcpPeer((frame) => child.stdin.write(frame));
      daemon.acpPeers.set(chat.id, peer);
      peer.onNotification = (frame) => {
        const previous = daemon.eventChains.get(chat.id) ?? Promise.resolve();
        const next = previous.then(() => daemon.handleGrok(chat.id, frame)).catch((error: unknown) => daemon.fail(chat.id, error));
        daemon.eventChains.set(chat.id, next);
      };
      peer.onRequest = (frame) => {
        const previous = daemon.eventChains.get(chat.id) ?? Promise.resolve();
        const next = previous.then(() => daemon.handleGrokRequest(chat.id, frame, peer)).catch((error: unknown) => {
          if (frame.id !== undefined) peer.respond(frame.id, { outcome: "cancelled" });
          return daemon.fail(chat.id, error);
        });
        daemon.eventChains.set(chat.id, next);
      };
      peer.onResponse = (method, result, error) => {
        if (method !== "session/prompt") return;
        const previous = daemon.eventChains.get(chat.id) ?? Promise.resolve();
        const next = previous.then(() => daemon.finishGrokTurn(chat.id, result, error)).catch((reason: unknown) => daemon.fail(chat.id, reason));
        daemon.eventChains.set(chat.id, next);
      };
      await peer.request("initialize", { protocolVersion: 1, clientInfo: { name: "megabrain", version: "0.2.4" }, clientCapabilities: {} });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
      const sessionParams = { cwd: chat.cwd, mcpServers: [] };
      const session = await peer.request(chat.agentSessionId ? "session/load" : "session/new", chat.agentSessionId ? { ...sessionParams, sessionId: chat.agentSessionId } : sessionParams);
      const sessionId = text(object(session).sessionId);
      if (sessionId) chat.agentSessionId = sessionId;
      if (chat.model) await peer.request("session/set_config_option", { sessionId: chat.agentSessionId, configId: "model", value: { value: chat.model } });
      if (chat.effort) await peer.request("session/set_config_option", { sessionId: chat.agentSessionId, configId: "reasoning_effort", value: { value: chat.effort } });
      chat.state = "idle";
      await daemon.save(chat);
      await daemon.drain(chat.id);
    } else {
      // Claude prints system/init only after its first user line, so queued input goes out now.
      // With nothing queued the process is up with stdin open, which is idle: the first send writes to it.
      const current = await daemon.requireChat(chat.id);
      if (current.state === "starting" && (daemon.queues.get(chat.id)?.length ?? 0) === 0) { current.state = "idle"; await daemon.save(current); }
      await daemon.drain(chat.id);
    }
  }

export async function clearTerminalHoldersBeforeResume(daemon: ChatDaemon, chat: Chat): Promise<void> {
    const appHolder = (holder: SessionHolder) => holder.tmuxSession?.startsWith(APP_SESSION_PREFIX) === true;
    let holders = await daemon.foreignHolders(chat);
    let recordedPid = 0;
    try { recordedPid = Number(object(JSON.parse(await readFile(chatChildRecord(daemon.stateDir, chat.id), "utf8"))).pid); } catch { /* no child record from the previous daemon */ }
    const cwd = await realpath(chat.cwd).catch(() => chat.cwd);
    const recorded = holders.find((holder) => holder.pid === recordedPid && holder.cwd === cwd);
    if (recorded !== undefined) {
      try { process.kill(recorded.pid, "SIGTERM"); } catch { /* it exited between discovery and signal */ }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        holders = await daemon.foreignHolders(chat);
        if (!holders.some((holder) => holder.pid === recorded.pid)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (holders.some((holder) => holder.pid === recorded.pid)) {
        try { process.kill(recorded.pid, "SIGKILL"); } catch { /* it exited between checks */ }
        for (let attempt = 0; attempt < 40; attempt += 1) {
          holders = await daemon.foreignHolders(chat);
          if (!holders.some((holder) => holder.pid === recorded.pid)) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      holders = await daemon.foreignHolders(chat);
    }
    const foreign = holders.filter((holder) => !appHolder(holder));
    if (foreign.length > 0) throw new SessionHeldError(chat, foreign);
    if (!holders.some(appHolder)) return;

    while (await daemon.logTurnOpen(chat)) {
      holders = await daemon.foreignHolders(chat);
      const activeAppHolders = holders.filter(appHolder);
      const activeForeign = holders.filter((holder) => !appHolder(holder));
      if (activeForeign.length > 0) throw new SessionHeldError(chat, activeForeign);
      if (activeAppHolders.length === 0) break;
      if (chat.state !== "working") { chat.state = "working"; await daemon.save(chat); }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const ended = await daemon.endAppTerminals(chat);
    const remaining = (await daemon.foreignHolders(chat)).filter((holder) => !ended.has(holder.pid));
    if (remaining.length > 0) throw new SessionHeldError(chat, remaining);
    await daemon.importTerminalTurns(chat);
    if (chat.state !== "starting") { chat.state = "starting"; await daemon.save(chat); }
  }

export function armStartTimer(daemon: ChatDaemon, id: string, child: ChildProcessWithoutNullStreams): void {
    const configured = Number(daemon.environment.MEGABRAIN_CHAT_START_TIMEOUT_MS);
    const ms = Number.isFinite(configured) && configured > 0 ? configured : 60_000;
    const timer = setTimeout(() => {
      daemon.startTimers.delete(id);
      if (daemon.children.get(id) !== child || daemon.outputSeen.has(id)) return;
      daemon.children.delete(id);
      child.kill("SIGTERM");
      void daemon.fail(id, new Error(`Claude did not answer within ${ms / 1000} s of the first message`));
    }, ms);
    timer.unref?.();
    daemon.startTimers.set(id, timer);
  }

export function clearStartTimer(daemon: ChatDaemon, id: string): void {
    const timer = daemon.startTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    daemon.startTimers.delete(id);
  }

export async function interrupt(daemon: ChatDaemon, id: string): Promise<void> {
    const chat = await daemon.requireChat(id);
    const child = daemon.children.get(id);
    const wasWorking = chat.state === "working" || chat.state === "waiting-approval";
    daemon.queueHeld.add(id);
    if (chat.agent === "claude") {
      daemon.interrupting.add(id);
      if (wasWorking) await daemon.publishTurnCut(chat, "interrupted");
      chat.state = "idle";
      await daemon.save(chat);
      await daemon.publishInterrupted(chat);
      await chatProtocolAdapters[chat.agent].interrupt(chat, child, daemon.activeTurns.get(id), (method, params) => child ? daemon.codexRequest(child, method, params) : Promise.resolve(undefined));
    }
    else {
      const turnId = daemon.activeTurns.get(id);
      if (turnId && child) {
        daemon.interrupting.add(id);
        await chatProtocolAdapters[chat.agent].interrupt(chat, child, turnId, (method, params) => chat.agent === "grok" ? daemon.acpPeers.get(id)?.request(method, params) ?? Promise.reject(new Error("Grok ACP process is not ready")) : daemon.codexRequest(child, method, params));
      } else {
        if (wasWorking) await daemon.publishTurnCut(chat, "interrupted");
        chat.state = "idle";
        await daemon.save(chat);
        await daemon.publishInterrupted(chat);
      }
    }
  }

export async function stop(daemon: ChatDaemon, id: string): Promise<void> {
    const chat = await daemon.requireChat(id);
    const child = daemon.children.get(id);
    if (chat.state === "working" || chat.state === "waiting-approval") await daemon.publishTurnCut(chat, "interrupted", "chat stopped");
    if (child) { child.kill("SIGTERM"); daemon.children.delete(id); }
    daemon.clearStartTimer(id);
    for (const map of [daemon.queues, daemon.activeTurns]) map.delete(id);
    chat.state = "suspended";
    chat.error = null;
    chat.lastActivityAt = new Date().toISOString();
    await daemon.save(chat);
    await daemon.publish(chat, event("system", "Stopped"));
  }
