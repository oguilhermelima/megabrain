// Internal chat daemon events operations.
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
import { chatChildRecord, chatLock, chatPid, chatResumes, chatSocket, discardStaleState, filePid, pidAlive, socketAccepts, stopChild } from ".././daemon/process-state.js";
import type { ChatDaemon } from "../daemon.js";
import { DRAINING, DEFAULT_TERMINAL_POLL_MS, DEFAULT_HANDOVER_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, timeoutsFor, heldMessage, SessionHeldError, unsentTerminalText, object, text, validateParts, firstText, event, withImages, withMessage, flattenContent, codexReasoning, count, instances } from "../daemon.js";
import type { Part, Request, Response, Environment, Timeouts, ArtifactWatch } from "../daemon.js";

export async function events(daemon: ChatDaemon, id: string, since: number, follow: boolean, socket?: Socket): Promise<ChatLine[]> {
    const chat = await daemon.requireChat(id);
    const head: ChatLine = { cursor: String(since), chat, queue: [...await daemon.loadQueue(id)] };
    if (socket) {
      socket.write(`${JSON.stringify(head)}\n`);
      if (follow) {
        const listeners = daemon.subscribers.get(id) ?? new Set();
        let cursor = since;
        let replaying = true;
        const pending: ChatLine[] = [];
        const write = (line: ChatLine, live = false) => {
          if (live) { socket.write(`${JSON.stringify({ ...line, cursor: "" })}\n`); return; }
          const next = Number(line.cursor);
          if (!Number.isSafeInteger(next) || next <= cursor) return;
          socket.write(`${JSON.stringify(line)}\n`);
          cursor = next;
        };
        const pendingLive = new Set<ChatLine>();
        const listener = (line: ChatLine, live = false) => {
          if (replaying) { pending.push(line); if (live) pendingLive.add(line); } else write(line, live);
        };
        listeners.add(listener); daemon.subscribers.set(id, listeners);
        socket.once("close", () => { listeners.delete(listener); if (listeners.size === 0) daemon.stopArtifactWatch(id); });
        try {
          await daemon.startArtifactWatch(chat);
          for (const line of await daemon.store.events(id, since)) write(line);
          for (let index = 0; index < pending.length; index += 1) { const line = pending[index] as ChatLine; write(line, pendingLive.has(line)); }
          replaying = false;
          const current = await daemon.store.get(id);
          if (current) write({ cursor: "", event: daemon.stateEvent(current) }, true);
        } catch (error) {
          listeners.delete(listener);
          if (listeners.size === 0) daemon.stopArtifactWatch(id);
          throw error;
        }
        return [];
      }
      for (const line of await daemon.store.events(id, since)) socket.write(`${JSON.stringify(line)}\n`);
    }
    return [head, ...await daemon.store.events(id, since)];
  }

export async function permission(daemon: ChatDaemon, id: string, request: Record<string, unknown>): Promise<unknown> {
    const chat = await daemon.requireChat(id);
    const args = object(request.arguments);
    const approval = await daemon.createApproval(chat, text(args.tool_name), JSON.stringify(args.input ?? {}), text(args.tool_use_id));
    return new Promise((resolve) => {
      const timer = setTimeout(() => { daemon.pendingApprovals.delete(approval.id); resolve({ behavior: "deny" }); }, 10 * 60_000);
      daemon.pendingApprovals.set(approval.id, { approval, resolve: (decision) => { clearTimeout(timer); resolve({ behavior: decision === "allow" || decision === "allow-session" ? "allow" : "deny" }); } });
    });
  }

export async function createApproval(daemon: ChatDaemon, chat: Chat, tool: string, input: string, reason: string): Promise<ChatApproval> {
    const approval: ChatApproval = { id: randomUUID(), tool, input, reason: reason || null, decisions: ["allow", "allow-session", "deny"] };
    chat.state = "waiting-approval";
    await daemon.save(chat);
    await daemon.publish(chat, event("approval", `${tool} requires approval`), approval);
    return approval;
  }

export async function approve(daemon: ChatDaemon, id: string, approvalId: string, decision: string): Promise<void> {
    if (!(["allow", "allow-session", "deny"] as string[]).includes(decision)) throw new Error("decision must be allow, allow-session, or deny");
    const pending = daemon.pendingApprovals.get(approvalId);
    if (pending) { pending.resolve(decision); daemon.pendingApprovals.delete(approvalId); }
    for (const [key, candidate] of daemon.pendingRpcApproval) {
      if (!key.startsWith(`${id}:`) || candidate !== approvalId) continue;
      const [, requestId] = key.split(":");
      const child = daemon.children.get(id);
      if (child) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: Number(requestId), result: { decision: decision === "deny" ? "decline" : decision === "allow-session" ? "acceptForSession" : "accept" } })}\n`);
      daemon.pendingRpcApproval.delete(key);
    }
    const chat = await daemon.requireChat(id);
    if (chat.state === "waiting-approval") chat.state = "working";
    await daemon.save(chat);
  }

export async function resolveApproval(daemon: ChatDaemon, id: string, requestId: number, response: unknown): Promise<void> {
    const child = daemon.children.get(id);
    if (child) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, result: response })}\n`);
  }

export function stateEvent(daemon: ChatDaemon, chat: Chat): ChatEvent {
    const startedAt = daemon.turnStarted.get(chat.id);
    return event("state", chat.state, undefined, chat.state === "working" && startedAt !== undefined ? { turnStartedAt: startedAt } : {});
  }

export function publishLive(daemon: ChatDaemon, id: string, value: ChatEvent): void { daemon.broadcast(id, { cursor: "", event: value }); }

export function publishProgress(daemon: ChatDaemon, id: string, progress: ChatProgress): void { daemon.publishLive(id, event("progress", "", undefined, { progress })); }

export function countClaude(daemon: ChatDaemon, id: string, change: (tokens: { done: number; thinking: number; textChars: number }) => { done: number; thinking: number; textChars: number }, publish = true): void {
    const tokens = change(daemon.claudeTokens.get(id) ?? { done: 0, thinking: 0, textChars: 0 });
    daemon.claudeTokens.set(id, tokens);
    if (publish) daemon.publishProgress(id, { tokens: tokens.done + tokens.thinking + Math.ceil(tokens.textChars / 4) });
  }

export function broadcast(daemon: ChatDaemon, id: string, line: ChatLine): void {
    for (const listener of daemon.subscribers.get(id) ?? []) listener(line, true);
  }

export async function publish(daemon: ChatDaemon, chat: Chat, value: ChatEvent, approval?: ChatApproval): Promise<void> {
    const turnId = daemon.activeTurns.get(chat.id);
    if (turnId !== undefined && value.turnId === undefined && value.kind !== "user") value = { ...value, turnId };
    if (value.kind === "user") { daemon.turnHasPartial.delete(chat.id); daemon.cutTurns.delete(chat.id); }
    if (value.kind === "assistant" && value.text !== "") daemon.turnHasPartial.add(chat.id);
    const previous = daemon.appendChains.get(chat.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (daemon.removed.has(chat.id)) return;
      const line = await daemon.store.append(chat.id, value, approval);
      for (const listener of daemon.subscribers.get(chat.id) ?? []) listener(line);
      if (value.kind === "tool-result") daemon.trackCallback(daemon.refreshClaudeArtifacts(chat));
    });
    daemon.appendChains.set(chat.id, next);
    await next;
  }

export async function publishInterrupted(daemon: ChatDaemon, chat: Chat): Promise<void> {
    if (daemon.interruptedEvents.has(chat.id)) return;
    daemon.interruptedEvents.add(chat.id);
    await daemon.publish(chat, event("system", "Interrupted"));
  }

export async function fail(daemon: ChatDaemon, id: string, error: unknown): Promise<void> {
    if (daemon.closed) return;
    const chat = await daemon.store.get(id);
    if (daemon.closed) return;
    if (!chat) return;
    chat.state = "error"; chat.error = error instanceof Error ? error.message : String(error);
    await daemon.save(chat);
    await daemon.publish(chat, event("system", chat.error));
  }
