// Internal chat daemon terminal mode operations.
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

export async function rename(daemon: ChatDaemon, id: string, title: string): Promise<Chat> {
    const chat = await daemon.requireChat(id);
    const named = title.trim().slice(0, 120);
    if (named === "") throw new Error("a chat title cannot be empty");
    chat.title = named;
    chat.titleSource = "person";
    await daemon.save(chat);
    await daemon.publish(chat, daemon.stateEvent(chat));
    return chat;
  }

export async function remove(daemon: ChatDaemon, id: string): Promise<{ removed: string }> {
    await daemon.requireChat(id);
    daemon.removed.add(id);
    const child = daemon.children.get(id);
    daemon.children.delete(id);
    daemon.clearStartTimer(id);
    if (child) child.kill("SIGTERM");
    await Promise.allSettled([daemon.eventChains.get(id), daemon.appendChains.get(id), daemon.queueWrites.get(id)]);
    daemon.stopArtifactWatch(id);
    for (const map of [daemon.queues, daemon.queued, daemon.queueWrites, daemon.drainChains, daemon.activeTurns, daemon.eventChains, daemon.appendChains, daemon.publishedState, daemon.turnStarted, daemon.currentMessage, daemon.claudeTokens, daemon.codexTokenBase, daemon.toolNames, daemon.subagents, daemon.subscribers]) map.delete(id);
    daemon.queueHeld.delete(id);
    daemon.interrupting.delete(id);
    daemon.interruptedEvents.delete(id);
    daemon.outputSeen.delete(id);
    await rm(daemon.store.dir(id), { recursive: true, force: true });
    daemon.store.forget(id);
    await daemon.dropConversation(id);
    return { removed: id };
  }

export async function mode(daemon: ChatDaemon, id: string, mode: string): Promise<{ chat: Chat; terminal: null; command: string[] | null }> {
    const chat = await daemon.requireChat(id);
    if (mode !== "chat" && mode !== "terminal") throw new Error("mode must be chat or terminal");
    if (mode === "terminal" && chat.mode === "terminal") {
      // Already the terminal's: reopening it after an app restart changes nothing, the app attaches to the TUI that runs.
    } else if (mode === "terminal") {
      const child = daemon.children.get(id);
      if (child) { daemon.children.delete(id); await stopChild(child); }
      // The app attaches to a TUI already on its own tmux server; one anywhere else would be a second writer.
      const elsewhere = (await daemon.foreignHolders(chat)).filter((holder) => holder.tmuxSession === null);
      if (elsewhere.length > 0) throw new Error(heldMessage(chat, elsewhere));
      daemon.clearStartTimer(id);
      for (const map of [daemon.queues, daemon.activeTurns]) map.delete(id);
      if (chat.state === "working" || chat.state === "waiting-approval") await daemon.publish(chat, event("system", "Interrupted"));
      chat.error = null;
      chat.mode = "terminal";
      chat.state = "idle";
      chat.terminalSince = new Date().toISOString();
      await daemon.save(chat);
    } else if (chat.mode === "terminal") {
      if (daemon.draining) throw new Error(DRAINING);
      // A TUI opened without a session writes its own; adopt it so the chat resumes where the terminal left off.
      if (chat.agentSessionId === null) chat.agentSessionId = await daemon.sessionOfTerminal(chat);
      // The chat's agent becomes the session's one process: every TUI the app still runs on it ends first.
      const ended = await daemon.endAppTerminals(chat);
      const elsewhere = (await daemon.foreignHolders(chat)).filter((holder) => !ended.has(holder.pid));
      if (elsewhere.length > 0) throw new Error(heldMessage(chat, elsewhere));
      await daemon.importTerminalTurns(chat);
      chat.mode = "chat";
      chat.state = "starting";
      await daemon.save(chat);
      // runAgent owns the record from here: saving daemon copy again could land after its idle and undo it.
      daemon.trackCallback(daemon.runAgent(chat, true).catch((error) => daemon.fail(id, error)));
    }
    // The terminal's command rides along, so opening it costs no second round trip.
    return { chat, terminal: null, command: chat.mode === "terminal" ? chatProtocolAdapters[chat.agent].terminalCommand(chat) : null };
  }

export async function importTerminalTurns(daemon: ChatDaemon, chat: Chat): Promise<void> {
    const known = new Set((await daemon.store.events(chat.id)).flatMap((line) => line.event?.sourceId === undefined ? [] : [line.event.sourceId]));
    const since = chat.terminalSince ?? "";
    const turns = await readSessionTurns(chat, daemon.environment.HOME ?? homedir());
    for (const turn of turns) {
      if (turn.at <= since || known.has(turn.sourceId)) continue;
      const { kind, text: value, at, tool, messageId, parentId, subagent, sourceId } = turn;
      await daemon.publish(chat, { id: randomUUID(), at, kind, text: value, ...(tool === undefined ? {} : { tool }), ...(messageId === undefined ? {} : { messageId }), ...(parentId === undefined ? {} : { parentId }), ...(subagent === undefined ? {} : { subagent }), sourceId });
    }
    // The TUIs are gone by now, so a turn the log leaves open was cut and nobody will finish it.
    const last = turns.filter((turn) => turn.at > since).at(-1);
    const marker = last === undefined ? "" : `${last.sourceId}:interrupted`;
    if (last === undefined || known.has(marker) || !await daemon.logTurnOpen(chat)) return;
    await daemon.publish(chat, { ...event("system", "Interrupted"), at: last.at, sourceId: marker });
  }

export async function logTurnOpen(daemon: ChatDaemon, chat: Chat): Promise<boolean> {
    const path = await sessionLogPath(chat, daemon.environment.HOME ?? homedir());
    if (path === null) return false;
    try { return sessionTurnOpen(chat.agent, await readFile(path, "utf8")); } catch { return false; }
  }

export async function foreignHolders(daemon: ChatDaemon, chat: Chat, panes?: ReadonlyMap<number, string>): Promise<SessionHolder[]> {
    if (chat.agentSessionId === null) return [];
    const own = new Set([...daemon.children.values()].flatMap((child) => child.pid === undefined ? [] : [child.pid]));
    return liveSessionHolders(chat.agent, chat.agentSessionId, { home: daemon.environment.HOME ?? homedir(), processes: daemon.processes(), exclude: own, cwd: chat.cwd, ...(panes === undefined ? {} : { panes }) });
  }

export async function panesOf(daemon: ChatDaemon, session: string): Promise<ReadonlyMap<number, string>> {
    const listed = await ownedTmuxProcess(daemon.processes()).run("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_pid}"]);
    const pids = listed.kind === "ok" ? listed.value.stdout.split("\n").map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 1) : [];
    return new Map(pids.map((pid) => [pid, session]));
  }

export async function endAppTerminals(daemon: ChatDaemon, chat: Chat): Promise<ReadonlySet<number>> {
    const alias = daemon.entryOf(chat.id)?.[1].aliases.tmux ?? null;
    const [server, aliased] = (alias ?? "").split(":");
    const own = server === OWNED_TMUX_SERVER && aliased !== undefined && aliased.startsWith(APP_SESSION_PREFIX) ? aliased : null;
    const panes = own === null ? undefined : await daemon.panesOf(own);
    const ended = (await daemon.foreignHolders(chat, panes)).filter((holder) => holder.tmuxSession?.startsWith(APP_SESSION_PREFIX) === true);
    const sessions = new Set(ended.flatMap((holder) => holder.tmuxSession === null ? [] : [holder.tmuxSession]));
    if (own !== null) sessions.add(own);
    const pids = new Set(ended.map((holder) => holder.pid));
    if (sessions.size === 0) return pids;
    const tmux = ownedTmuxProcess(daemon.processes());
    for (const session of sessions) {
      const capture = await tmux.run("tmux", ["capture-pane", "-p", "-S", "-30", "-t", `=${session}`]);
      if (capture.kind === "ok") {
        const draft = unsentTerminalText(capture.value.stdout);
        if (draft !== null) await daemon.publish(chat, event("system", `Unsent text from the terminal: ${draft}`));
      }
      await tmux.run("tmux", ["kill-session", "-t", `=${session}`]);
      try { if (session.startsWith(APP_SESSION_PREFIX)) forgetAppTerminal(daemon.stateDir, session); } catch { /* a listing aid */ }
    }
    try {
      const owned = readOwnedSessions(daemon.stateDir);
      const kept = Object.fromEntries(Object.entries(owned).filter(([, entry]) => !(entry.tmuxServer === OWNED_TMUX_SERVER && sessions.has(entry.tmuxSession))));
      if (Object.keys(kept).length !== Object.keys(owned).length) writeOwnedSessions(daemon.stateDir, kept);
      const key = daemon.entryOf(chat.id)?.[0];
      if (key !== undefined && aliased !== undefined && sessions.has(aliased)) setConversationAlias(daemon.stateDir, key, { tmux: null });
    } catch { /* a listing aid */ }
    // tmux returns before the pane's process has gone; the next holder check must not see it.
    for (let attempt = 0; attempt < 20 && (await daemon.foreignHolders(chat)).some((holder) => pids.has(holder.pid)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    return pids;
  }

export async function refreshTerminalChats(daemon: ChatDaemon): Promise<void> {
    for (const listed of await daemon.store.list()) {
      if (daemon.closed) return;
      if (listed.mode !== "terminal" || listed.agentSessionId === null) continue;
      const path = await sessionLogPath(listed, daemon.environment.HOME ?? homedir());
      let content: string;
      let key: string;
      try {
        const info = await stat(path ?? "");
        key = `${info.size}:${info.mtimeMs}`;
        if (key === daemon.terminalLogs.get(listed.id) && listed.state !== "working") continue;
        content = await readFile(path ?? "", "utf8");
      } catch { content = ""; key = ""; }
      daemon.terminalLogs.set(listed.id, key);
      const working = sessionTurnOpen(listed.agent, content) && (await daemon.foreignHolders(listed)).length > 0;
      const state: Chat["state"] = working ? "working" : "idle";
      // The record may have moved on while the log was read: only a chat still in the same terminal stint changes.
      const chat = await daemon.store.get(listed.id);
      if (daemon.closed) return;
      if (!chat || chat.mode !== "terminal" || chat.terminalSince !== listed.terminalSince || chat.state === state) continue;
      chat.state = state;
      if (!working) chat.lastActivityAt = new Date().toISOString();
      await daemon.save(chat);
    }
  }

export async function terminalCommand(daemon: ChatDaemon, id: string): Promise<string[]> {
    const chat = await daemon.requireChat(id);
    return chatProtocolAdapters[chat.agent].terminalCommand(chat);
  }
