// Internal chat daemon queue operations.
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
import type { ChatDaemon } from "../daemon.js";
import { handleLocalInfoCommand } from "./local-command.js";
import { DRAINING, DEFAULT_TERMINAL_POLL_MS, DEFAULT_HANDOVER_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, timeoutsFor, heldMessage, SessionHeldError, unsentTerminalText, object, text, validateParts, firstText, event, withImages, withMessage, flattenContent, codexReasoning, count, instances, timeoutMs } from "../daemon.js";
import type { Part, Request, Response, Environment, Timeouts, ArtifactWatch } from "../daemon.js";

export async function queueOperation(daemon: ChatDaemon, request: Request): Promise<unknown> {
    const id = text(request.id);
    let chat = await daemon.requireChat(id);
    const action = text(request.action);
    const items = await daemon.loadQueue(id);
    const take = (): QueuedChatMessage => {
      const index = items.findIndex((item) => item.id === text(request.itemId));
      if (index === -1) throw new Error(`message ${text(request.itemId) || "(none)"} is not in the queue`);
      return items.splice(index, 1)[0] as QueuedChatMessage;
    };
    switch (action) {
      case "list": return [...items];
      case "add":
        await daemon.enqueue(chat, await daemon.normalizeParts(chat.cwd, validateParts(request.parts)));
        await daemon.drain(id);
        return [...await daemon.loadQueue(id)];
      case "edit": {
        // The person's rule: an edited message goes to the end of the queue.
        const parts = await daemon.normalizeParts(chat.cwd, validateParts(request.parts));
        const item = take();
        items.push({ ...item, parts, updatedAt: new Date().toISOString() });
        return await daemon.persistQueue(id);
      }
      case "move": {
        const to = request.to;
        if (typeof to !== "number" || !Number.isSafeInteger(to) || to < 0) throw new Error("--to must be a non-negative index");
        const item = take();
        items.splice(Math.min(to, items.length), 0, item);
        return await daemon.persistQueue(id);
      }
      case "remove":
        take();
        return await daemon.persistQueue(id);
      case "clear":
        items.splice(0);
        return await daemon.persistQueue(id);
      case "send-now": {
        if (chat.mode !== "chat") throw new Error("chat is in terminal mode");
        if (daemon.draining) throw new Error(DRAINING);
        await daemon.takeOver(id);
        chat = await daemon.requireChat(id);
        const item = take();
        await daemon.persistQueue(id);
        if (chat.state === "working" || chat.state === "waiting-approval") await daemon.interrupt(id);
        await daemon.deliver(await daemon.requireChat(id), item.parts, { keepInterrupt: true });
        return [...await daemon.loadQueue(id)];
      }
      case "steer": {
        const child = daemon.children.get(id);
        const turnId = daemon.activeTurns.get(id);
        if (chat.agent !== "codex" || chat.state !== "working" || child === undefined || turnId === undefined) throw new Error("steer needs a running Codex turn");
        const index = items.findIndex((item) => item.id === text(request.itemId));
        const item = items[index];
        if (item === undefined) throw new Error(`message ${text(request.itemId) || "(none)"} is not in the queue`);
        await chatProtocolAdapters.codex.steer(chat, child, turnId, item.parts, (method, params) => daemon.codexRequest(child, method, params));
        const at = items.indexOf(item);
        if (at !== -1) items.splice(at, 1);
        await daemon.persistQueue(id);
        await daemon.publish(chat, event("user", firstText(item.parts), undefined, withImages(item.parts)));
        return [...items];
      }
      default: throw new Error("queue action must be list, add, edit, move, remove, clear, send-now or steer");
    }
  }

export async function loadQueue(daemon: ChatDaemon, id: string): Promise<QueuedChatMessage[]> {
    const cached = daemon.queued.get(id);
    if (cached !== undefined) return cached;
    const items = await daemon.store.queue(id);
    const raced = daemon.queued.get(id);
    if (raced !== undefined) return raced;
    daemon.queued.set(id, items);
    return items;
  }

export async function persistQueue(daemon: ChatDaemon, id: string): Promise<QueuedChatMessage[]> {
    const items = [...daemon.queued.get(id) ?? []];
    daemon.broadcast(id, { cursor: "", queue: items });
    const next = (daemon.queueWrites.get(id) ?? Promise.resolve()).then(() => daemon.removed.has(id) ? undefined : daemon.store.putQueue(id, items));
    daemon.queueWrites.set(id, next.catch(() => undefined));
    await next;
    return items;
  }

export async function enqueue(daemon: ChatDaemon, chat: Chat, parts: Part[]): Promise<QueuedChatMessage> {
    const items = await daemon.loadQueue(chat.id);
    const now = new Date().toISOString();
    const item: QueuedChatMessage = { id: randomUUID(), parts: [...parts], createdAt: now, updatedAt: now };
    items.push(item);
    await daemon.persistQueue(chat.id);
    return item;
  }

export function drain(daemon: ChatDaemon, id: string): Promise<void> {
    const next = (daemon.drainChains.get(id) ?? Promise.resolve()).then(() => daemon.drainOnce(id));
    daemon.drainChains.set(id, next.catch(() => undefined));
    return next;
  }

export async function drainOnce(daemon: ChatDaemon, id: string): Promise<void> {
    const child = daemon.children.get(id);
    const chat = await daemon.requireChat(id);
    if (!child || chat.mode !== "chat" || chat.state === "working" || chat.state === "waiting-approval") return;
    let parts: Part[];
    const outbox = daemon.queues.get(id);
    if (outbox !== undefined && outbox.length > 0) {
      parts = outbox.shift() as Part[];
      if (outbox.length === 0) daemon.queues.delete(id);
      daemon.queueHeld.delete(id);
    } else {
      if (chat.state !== "idle" || chat.mode !== "chat" || daemon.queueHeld.has(id) || daemon.draining) return;
      const items = await daemon.loadQueue(id);
      const item = items.shift();
      if (item === undefined) return;
      parts = item.parts;
      await daemon.persistQueue(id);
      chat.lastActivityAt = new Date().toISOString();
      await daemon.publish(chat, event("user", firstText(parts), undefined, withImages(parts)));
    }
    if (await handleLocalInfoCommand(daemon, chat, parts)) return;
    chat.state = "working";
    await daemon.save(chat);
    const adapter = chatProtocolAdapters[chat.agent];
    if (chat.agent === "grok" && chat.agentSessionId) {
      daemon.activeTurns.set(id, chat.agentSessionId);
      daemon.grokMessages.set(id, { id: randomUUID(), text: "", thinking: "" });
    }
    const turnId = await adapter.send(chat, child, parts, (method, params) => chat.agent === "grok" ? daemon.acpPeers.get(id)?.request(method, params) ?? Promise.reject(new Error("Grok ACP process is not ready")) : daemon.codexRequest(child, method, params));
    if (turnId) daemon.activeTurns.set(id, turnId);
    if (turnId && chat.agent === "codex") await daemon.store.annotateLastUserTurn(id, turnId);
    if (chat.agent === "claude" && !daemon.outputSeen.has(id) && !daemon.startTimers.has(id)) daemon.armStartTimer(id, child);
  }
