// Internal chat daemon resume operations.
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

export async function resumeDrained(daemon: ChatDaemon): Promise<void> {
    let ids: unknown;
    try { ids = JSON.parse(await readFile(chatResumes(daemon.stateDir), "utf8")); } catch { return; }
    try { await unlink(chatResumes(daemon.stateDir)); } catch { /* already taken */ }
    for (const id of Array.isArray(ids) ? ids.filter((value): value is string => typeof value === "string") : []) {
      const chat = await daemon.store.get(id);
      if (!chat || chat.mode !== "chat") continue;
      const items = await daemon.loadQueue(id);
      const item = items.shift();
      if (item === undefined) continue;
      await daemon.persistQueue(id);
      await daemon.deliver(chat, item.parts);
    }
  }

export async function send(daemon: ChatDaemon, id: string, inputParts: Part[], fresh = false): Promise<{ queued: QueuedChatMessage | null }> {
    let chat = await daemon.requireChat(id);
    if (chat.mode !== "chat") throw new Error("chat is in terminal mode");
    const parts = await daemon.normalizeParts(chat.cwd, inputParts);
    if (daemon.draining) { daemon.resumeOnStart.add(id); return { queued: await daemon.enqueue(chat, parts) }; }
    const holders = await daemon.foreignHolders(chat);
    const terminalOwns = holders.some((holder) => holder.tmuxSession?.startsWith(APP_SESSION_PREFIX) === true);
    if (terminalOwns && await daemon.logTurnOpen(chat)) {
      const turns = await readSessionTurns(chat, daemon.environment.HOME ?? process.env.HOME ?? "");
      let lastUser = -1;
      for (let index = 0; index < turns.length; index += 1) if (turns[index]?.kind === "user") lastUser = index;
      const toolIsRunning = turns.slice(lastUser + 1).some((turn) => turn.kind === "tool-call") || turns.slice(lastUser + 1).some((turn) => turn.kind === "tool-result");
      if (!toolIsRunning) {
        const queued = await daemon.enqueue(chat, parts);
        chat.state = "working";
        chat.owner = "terminal";
        await daemon.save(chat);
        return { queued };
      }
    }
    await daemon.takeOver(id);
    chat = await daemon.requireChat(id);
    if (chat.state === "error" && chat.error?.includes("already open in another process")) {
      const queued = await daemon.enqueue(chat, parts);
      await daemon.resume(id);
      return { queued };
    }
    if (chat.state === "working" || chat.state === "waiting-approval") return { queued: await daemon.enqueue(chat, parts) };
    await daemon.deliver(chat, parts, { fresh });
    return { queued: null };
  }

export async function resume(daemon: ChatDaemon, id: string): Promise<Chat> {
    if (daemon.draining) throw new Error(DRAINING);
    const chat = await daemon.requireChat(id);
    if (chat.mode !== "chat" || (chat.state !== "suspended" && chat.state !== "stopped" && !(chat.state === "error" && chat.error?.includes("already open in another process"))) || chat.agentSessionId === null) throw new Error("chat is not resumable");
    chat.state = "starting";
    chat.error = null;
    await daemon.save(chat);
    daemon.trackCallback(daemon.runAgent(chat).catch((error) => daemon.resumeFailed(id, error)));
    return chat;
  }

export async function deliver(daemon: ChatDaemon, chat: Chat, parts: Part[], options: { fresh?: boolean; keepInterrupt?: boolean } = {}): Promise<void> {
    const id = chat.id;
    const resuming = chat.state === "suspended" || chat.state === "stopped";
    const textValue = firstText(parts);
    if (chat.title === null && textValue !== "") chat.title = textValue.slice(0, 120);
    chat.lastActivityAt = new Date().toISOString();
    await daemon.save(chat);
    await daemon.publish(chat, event("user", textValue, undefined, withImages(parts)));
    if (await handleLocalInfoCommand(daemon, chat, parts)) return;
    if (options.keepInterrupt !== true) daemon.interrupting.delete(id);
    daemon.interruptedEvents.delete(id);
    if (resuming) {
      // The first send is the trigger: opening a chat spawns nothing, so a person browsing history costs no agent process.
      if (options.fresh === true) chat.agentSessionId = null;
      chat.state = "starting";
      chat.error = null;
      daemon.queues.set(id, [parts]);
      await daemon.save(chat);
      daemon.trackCallback(daemon.runAgent(chat).catch((error) => daemon.resumeFailed(id, error)));
      return;
    }
    const queue = daemon.queues.get(id) ?? [];
    queue.push(parts);
    daemon.queues.set(id, queue);
    if (!daemon.children.has(id) && chat.state === "idle") {
      chat.state = "starting";
      await daemon.save(chat);
      daemon.trackCallback(daemon.runAgent(chat).catch((error) => daemon.fail(id, error)));
      return;
    }
    await daemon.drain(id);
  }

export async function resumeFailed(daemon: ChatDaemon, id: string, error: unknown): Promise<void> {
    if (daemon.closed) return;
    const child = daemon.children.get(id);
    if (child) { daemon.children.delete(id); child.kill("SIGTERM"); }
    daemon.clearStartTimer(id);
    if (!(error instanceof SessionHeldError)) daemon.queues.delete(id);
    const chat = await daemon.store.get(id);
    if (daemon.closed) return;
    if (!chat || chat.state === "suspended" && chat.error !== null) return;
    chat.state = error instanceof SessionHeldError ? "error" : "suspended";
    chat.error = error instanceof Error ? error.message : String(error);
    await daemon.save(chat);
    await daemon.publish(chat, event("system", chat.error));
  }
