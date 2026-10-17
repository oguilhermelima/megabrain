// Internal chat daemon chat state operations.
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
import { DRAINING, DEFAULT_TERMINAL_POLL_MS, DEFAULT_HANDOVER_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, timeoutsFor, heldMessage, SessionHeldError, unsentTerminalText, object, text, validateParts, firstText, event, withImages, withMessage, flattenContent, codexReasoning, count, instances, timeoutMs } from "../daemon.js";
import type { Part, Request, Response, Environment, Timeouts, ArtifactWatch } from "../daemon.js";

export async function requireChat(daemon: ChatDaemon, id: string): Promise<Chat> {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error("invalid chat id");
    const chat = await daemon.store.get(id);
    if (!chat) throw new Error(`chat not found: ${id}`);
    return chat;
  }

export async function normalizeParts(daemon: ChatDaemon, cwd: string, parts: Part[]): Promise<Part[]> {
    return Promise.all(parts.map(async (part) => {
      if (part.type !== "image") return part;
      const path = isAbsolute(part.path) ? part.path : resolve(cwd, part.path);
      const file = await stat(path);
      if (!file.isFile()) throw new Error(`image is not a regular file: ${path}`);
      return { type: "image", path };
    }));
  }

export function processes(daemon: ChatDaemon): ProcessAdapter {
    const base = createProcessAdapter();
    const path = daemon.environment.PATH;
    return path === undefined ? base : { ...base, run: (command, args, options) => base.run(command, args, { ...options, env: { PATH: path, ...options?.env } }) };
  }

export function entryOf(daemon: ChatDaemon, chatId: string): [string, Conversation] | undefined {
    return Object.entries(readConversations(daemon.stateDir).conversations).find(([, entry]) => entry.aliases.chatId === chatId);
  }

export function track(daemon: ChatDaemon, chat: Chat): void {
    if (chat.title === null && chat.agentSessionId === null && chat.mode === "chat") return;
    try {
      const key = chat.agentSessionId === null ? chatKey(chat.id) : sessionKey(chat.agent, chat.agentSessionId);
      if (daemon.tracked.get(chat.id) === key) return;
      const current = daemon.entryOf(chat.id);
      if (current !== undefined && current[0] !== key) promoteConversation(daemon.stateDir, current[0], key);
      else if (current === undefined) upsertConversation(daemon.stateDir, key, { owner: "app-chat", cwd: chat.cwd, aliases: { chatId: chat.id, tmux: null, pid: null, dispatchId: null }, createdAt: chat.createdAt, hidden: false });
      daemon.tracked.set(chat.id, key);
    } catch { /* the registry is a listing aid: a locked file must not fail a turn */ }
  }

export async function dropConversation(daemon: ChatDaemon, chatId: string): Promise<void> {
    daemon.tracked.delete(chatId);
    const found = daemon.entryOf(chatId);
    if (found === undefined) return;
    const [key, entry] = found;
    const [server, session] = (entry.aliases.tmux ?? "").split(":");
    if (server === OWNED_TMUX_SERVER && session !== undefined && session !== "") await ownedTmuxProcess(daemon.processes()).run("tmux", ["kill-session", "-t", `=${session}`]);
    removeConversation(daemon.stateDir, key);
  }

export async function pruneUnused(daemon: ChatDaemon): Promise<void> {
    for (const chat of await daemon.store.list()) {
      if (chat.mode !== "chat" || chat.agentSessionId !== null || chat.title !== null) continue;
      if ((await daemon.store.events(chat.id)).some((line) => line.event?.kind === "user")) continue;
      await rm(daemon.store.dir(chat.id), { recursive: true, force: true });
      daemon.store.forget(chat.id);
    }
  }

export async function sessionOfTerminal(daemon: ChatDaemon, chat: Chat): Promise<string | null> {
    const alias = daemon.entryOf(chat.id)?.[1].aliases.tmux ?? null;
    const [server, session] = (alias ?? "").split(":");
    if (server !== OWNED_TMUX_SERVER || session === undefined || session === "") return null;
    const processes = daemon.processes();
    const panes = await ownedTmuxProcess(processes).run("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_pid}"]);
    const panePids = panes.kind === "ok" ? panes.value.stdout.split("\n").map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 1) : [];
    const found = await discoverSessionId(chat, daemon.environment.HOME ?? homedir(), panePids, processes);
    if (found !== null) try { promoteConversation(daemon.stateDir, daemon.entryOf(chat.id)?.[0] ?? chatKey(chat.id), sessionKey(chat.agent, found)); } catch { /* listing aid */ }
    return found;
  }

export async function save(daemon: ChatDaemon, chat: Chat): Promise<void> {
    if (daemon.removed.has(chat.id)) return;
    await daemon.store.put(chat);
    daemon.track(chat);
    if (daemon.publishedState.get(chat.id) === chat.state) return;
    daemon.publishedState.set(chat.id, chat.state);
    if (chat.state === "working") {
      if (!daemon.turnStarted.has(chat.id)) { daemon.turnStarted.set(chat.id, new Date().toISOString()); daemon.claudeTokens.delete(chat.id); daemon.codexTokenBase.delete(chat.id); }
    }
    else if (chat.state !== "waiting-approval") daemon.turnStarted.delete(chat.id);
    await daemon.publish(chat, daemon.stateEvent(chat));
    if (chat.state === "idle") daemon.trackCallback(daemon.summarizer.turnEnded(chat.id));
  }
