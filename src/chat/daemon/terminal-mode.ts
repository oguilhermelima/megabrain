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
import { existsSync, statSync, watch as watchFile } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ChatStore, type Chat, type ChatApproval, type ChatEvent, type ChatLine, type ChatProgress, type QueuedChatMessage } from ".././store.js";
import { chatProtocolAdapters, type MessagePart } from ".././protocol.js";
import { discoverSessionId, parseAgyLog, parseClaudeLog, parseCodexRollout, parseGrokLog, sessionLogPath, sessionTurnOpen } from ".././session-log.js";
import { claudeHandBack, claudeNotified, claudeSubagent, codexEnded, codexSpawned, isClaudeSubagentTool, type Subagent, type SubagentEnd } from ".././subagents.js";
import { selfInvocation } from "../../core/self-invocation.js";
import { KnowledgePipeline } from "../../knowledge/pipeline.js";
import { ChatSummarizer, updateSummaryTitle } from ".././summaries.js";
import { chatArtifactFileFingerprint, chatArtifactSignature, chatArtifactStoreFingerprint, listChatArtifacts, listClaudeChatArtifacts, listMegabrainChatArtifacts, type ChatArtifact } from ".././artifacts.js";
import { chatChildRecord, chatLock, chatPid, chatResumes, chatSocket, discardStaleState, filePid, pidAlive, socketAccepts, stopChild } from "./process-state.js";
import type { ChatDaemon } from "../daemon.js";
import { DRAINING, DEFAULT_TERMINAL_POLL_MS, DEFAULT_HANDOVER_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, timeoutsFor, heldMessage, SessionHeldError, ChatHandoffError, unsentTerminalText, object, text, validateParts, firstText, event, withImages, withMessage, flattenContent, codexReasoning, count, instances, timeoutMs } from "../daemon.js";
import type { Part, Request, Response, Environment, Timeouts, ArtifactWatch } from "../daemon.js";

export async function rename(daemon: ChatDaemon, id: string, title: string): Promise<Chat> {
    const chat = await daemon.requireChat(id);
    const named = title.trim().slice(0, 120);
    if (named === "") throw new Error("a chat title cannot be empty");
    chat.title = named;
    chat.titleSource = "person";
    await daemon.save(chat);
    updateSummaryTitle(daemon.stateDir, chat.id, chat.title);
    await daemon.publish(chat, daemon.stateEvent(chat));
    return chat;
  }

export async function remove(daemon: ChatDaemon, id: string): Promise<{ removed: string }> {
    await daemon.requireChat(id);
    daemon.removed.add(id);
    daemon.summarizer.removeChat(id);
    const child = daemon.children.get(id);
    daemon.children.delete(id);
    daemon.clearStartTimer(id);
    if (child) child.kill("SIGTERM");
    await Promise.allSettled([daemon.eventChains.get(id), daemon.appendChains.get(id), daemon.queueWrites.get(id), daemon.terminalImportChains.get(id)]);
    daemon.stopArtifactWatch(id);
    daemon.terminalFileWatches.get(id)?.close();
    daemon.terminalFileWatches.delete(id);
    for (const map of [daemon.queues, daemon.queued, daemon.queueWrites, daemon.drainChains, daemon.activeTurns, daemon.eventChains, daemon.appendChains, daemon.terminalImportChains, daemon.publishedState, daemon.turnStarted, daemon.currentMessage, daemon.claudeTokens, daemon.codexTokenBase, daemon.grokMessages, daemon.toolNames, daemon.backgroundTaskIds, daemon.backgroundTasks, daemon.subagents, daemon.subscribers]) map.delete(id);
    daemon.queueHeld.delete(id);
    daemon.interrupting.delete(id);
    daemon.interruptedEvents.delete(id);
    daemon.outputSeen.delete(id);
    await rm(daemon.store.dir(id), { recursive: true, force: true });
    daemon.store.forget(id);
    await daemon.dropConversation(id);
    await daemon.syncTerminalPolling();
    return { removed: id };
  }

export async function mode(daemon: ChatDaemon, id: string, mode: string): Promise<{ chat: Chat; terminal: null; command: string[] | null }> {
    const chat = await daemon.requireChat(id);
    if (mode !== "chat" && mode !== "terminal") throw new Error("mode must be chat or terminal");
    if (mode === "terminal") {
      if (chat.mode !== "terminal") {
        const holders = await daemon.foreignHolders(chat);
        const appOwner = holders.some((holder) => holder.tmuxSession?.startsWith(APP_SESSION_PREFIX) === true);
        const elsewhere = holders.filter((holder) => !holder.tmuxSession?.startsWith(APP_SESSION_PREFIX));
        if (elsewhere.length > 0) throw new ChatHandoffError("chat-busy", heldMessage(chat, elsewhere));
        if (appOwner) {
          chat.mode = "terminal";
          chat.owner = "terminal";
        } else {
          const child = daemon.children.get(id);
          if (child) { daemon.children.delete(id); await stopChild(child); }
          daemon.clearStartTimer(id);
          chat.owner = "none";
          chat.error = null;
          chat.mode = "terminal";
          chat.state = "idle";
          chat.terminalSince = new Date().toISOString();
        }
        await daemon.save(chat);
      }
    } else if (chat.mode !== "chat") {
      if (chat.agentSessionId === null) chat.agentSessionId = await daemon.sessionOfTerminal(chat);
      const holders = await daemon.foreignHolders(chat);
      const appOwner = holders.some((holder) => holder.tmuxSession?.startsWith(APP_SESSION_PREFIX) === true);
      const foreignOwner = holders.filter((holder) => !holder.tmuxSession?.startsWith(APP_SESSION_PREFIX));
      if (foreignOwner.length > 0) throw new ChatHandoffError("chat-busy", heldMessage(chat, foreignOwner));
      if (appOwner) {
        if (await daemon.logTurnOpen(chat)) throw new ChatHandoffError("terminal-busy", "the terminal is still working; wait or interrupt it before switching to chat");
        await captureTerminalDraft(daemon, chat, holders);
        // Selecting the chat view does not take ownership away from the TUI.
        chat.mode = "chat";
        chat.owner = "terminal";
        await daemon.save(chat);
      } else {
        // Old records may have terminal turns without a running app pane. Import those once, then resume through chatd.
        if (daemon.draining) throw new Error(DRAINING);
        if (chat.agentSessionId === null) chat.agentSessionId = await daemon.sessionOfTerminal(chat);
        const ended = await daemon.endAppTerminals(chat);
        const elsewhere = (await daemon.foreignHolders(chat, undefined, ended)).filter((holder) => !holder.tmuxSession?.startsWith(APP_SESSION_PREFIX));
        if (elsewhere.length > 0) throw new ChatHandoffError("chat-busy", heldMessage(chat, elsewhere));
        await daemon.importTerminalTurns(chat);
        // A first message no TUI took yet goes to the chat instead.
        if (chat.pendingPrompt !== undefined) {
          daemon.queues.set(id, [...(daemon.queues.get(id) ?? []), [{ type: "text", text: chat.pendingPrompt }]]);
          delete chat.pendingPrompt;
        }
        chat.mode = "chat";
        chat.owner = "none";
        chat.state = "starting";
        await daemon.save(chat);
        daemon.trackCallback(daemon.runAgent(chat, true).catch((error) => daemon.fail(id, error)));
      }
    }
    await daemon.syncTerminalPolling();
    // The terminal's command rides along, so opening it costs no second round trip.
    return { chat, terminal: null, command: chat.mode === "terminal" ? chatProtocolAdapters[chat.agent].terminalCommand(chat) : null };
  }

export async function takeOver(daemon: ChatDaemon, id: string): Promise<Chat> {
    const chat = await daemon.requireChat(id);
    if (daemon.draining) throw new Error(DRAINING);
    if (chat.agentSessionId === null && chat.mode === "terminal") chat.agentSessionId = await daemon.sessionOfTerminal(chat);
    const holders = await daemon.foreignHolders(chat);
    const appOwner = holders.some((holder) => holder.tmuxSession?.startsWith(APP_SESSION_PREFIX) === true);
    if (chat.owner !== "terminal" && chat.mode !== "terminal" && !appOwner) return chat;
    const otherOwner = holders.filter((holder) => !holder.tmuxSession?.startsWith(APP_SESSION_PREFIX));
    if (otherOwner.length > 0) throw new ChatHandoffError("terminal-busy", heldMessage(chat, otherOwner));
    if (await daemon.logTurnOpen(chat)) throw new ChatHandoffError("terminal-busy", "the terminal is still working; wait or interrupt it before sending from chat");
    const ended = await daemon.endAppTerminals(chat);
    const elsewhere = (await daemon.foreignHolders(chat, undefined, ended)).filter((holder) => !holder.tmuxSession?.startsWith(APP_SESSION_PREFIX));
    if (elsewhere.length > 0) throw new ChatHandoffError("terminal-busy", heldMessage(chat, elsewhere));
    await daemon.importTerminalTurns(chat);
    chat.owner = "none";
    chat.mode = "chat";
    chat.state = "starting";
    chat.error = null;
    await daemon.save(chat);
    await daemon.syncTerminalPolling();
    await daemon.runAgent(chat, true).catch((error) => daemon.resumeFailed(id, error));
    return await daemon.requireChat(id);
  }

async function captureTerminalDraft(daemon: ChatDaemon, chat: Chat, holders: readonly SessionHolder[]): Promise<void> {
    const sessions = new Set(holders.flatMap((holder) => holder.tmuxSession?.startsWith(APP_SESSION_PREFIX) ? [holder.tmuxSession] : []));
    const alias = daemon.entryOf(chat.id)?.[1].aliases.tmux ?? null;
    const [server, session] = (alias ?? "").split(":");
    if (server === OWNED_TMUX_SERVER && session?.startsWith(APP_SESSION_PREFIX)) sessions.add(session);
    const tmux = ownedTmuxProcess(daemon.processes());
    for (const name of sessions) {
      const capture = await tmux.run("tmux", ["capture-pane", "-p", "-S", "-30", "-t", `=${name}`]);
      if (capture.kind !== "ok") continue;
      const draft = unsentTerminalText(capture.value.stdout);
      if (draft !== null) await daemon.publish(chat, event("system", `Unsent text from the terminal: ${draft}`));
    }
  }

export async function importTerminalTurns(daemon: ChatDaemon, chat: Chat, markInterrupted = true): Promise<void> {
    const existing = (await daemon.store.events(chat.id)).flatMap((line) => line.event === undefined ? [] : [line.event]);
    const known = new Set(existing.flatMap((item) => item.sourceId === undefined ? [] : [item.sourceId]));
    const shownMessageIds = new Set(existing.flatMap((item) => item.messageId === undefined ? [] : [item.messageId]));
    const since = chat.terminalSince ?? "";
    const path = await sessionLogPath(chat, daemon.environment.HOME ?? homedir(), daemon.environment.GROK_HOME);
    let turns: import(".././session-log.js").LoggedTurn[] = [];
    let byteOffset = chat.terminalLogCursor?.byteOffset ?? 0;
    let turnOpen = chat.terminalTurnOpen ?? false;
    let readSucceeded = false;
    if (path !== null) {
      try {
        const tail = await readTerminalTail(path, byteOffset);
        turns = parseTerminalTurns(chat.agent, tail.content);
        byteOffset = tail.byteOffset;
        turnOpen = sessionTurnOpen(chat.agent, tail.content, turnOpen);
        readSucceeded = true;
      } catch { /* a missing or mid-write session file is retried on the next watch or poll */ }
    }
    let lastMessageId = chat.terminalLogCursor?.lastMessageId ?? (existing.at(-1)?.messageId ?? null);
    let lastShownIndex = -1;
    if (chat.terminalLogCursor === undefined && shownMessageIds.size > 0) {
      for (let index = 0; index < turns.length; index += 1) if (turns[index]?.messageId !== undefined && shownMessageIds.has(turns[index]?.messageId as string)) lastShownIndex = index;
    }
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index] as import(".././session-log.js").LoggedTurn;
      if (turn.messageId !== undefined && turn.at > since) lastMessageId = turn.messageId;
      if (turn.at <= since || known.has(turn.sourceId) || index <= lastShownIndex) continue;
      const { kind, text: value, at, tool, messageId, parentId, subagent, backgroundTask, reason, detail, partial, sourceId } = turn;
      await daemon.publish(chat, { id: randomUUID(), at, kind, text: value, ...(tool === undefined ? {} : { tool }), ...(messageId === undefined ? {} : { messageId }), ...(parentId === undefined ? {} : { parentId }), ...(subagent === undefined ? {} : { subagent }), ...(backgroundTask === undefined ? {} : { backgroundTask }), ...(reason === undefined ? {} : { reason }), ...(detail === undefined ? {} : { detail }), ...(partial === undefined ? {} : { partial }), sourceId });
    }
    if (path !== null && readSucceeded) {
      const current = await daemon.store.get(chat.id);
      if (current !== null) {
        current.terminalLogCursor = { byteOffset, lastMessageId };
        current.terminalTurnOpen = turnOpen;
        await daemon.save(current);
      }
    }
    // The TUIs are gone by now, so a turn the log leaves open was cut and nobody will finish it.
    const last = turns.filter((turn) => turn.at > since).at(-1);
    const marker = last === undefined ? "" : `${last.sourceId}:interrupted`;
    if (!markInterrupted || last === undefined || known.has(marker) || !await daemon.logTurnOpen(chat)) return;
    let providerStarted = false;
    for (const turn of turns) {
      if (turn.at <= since) continue;
      if (turn.kind === "user") providerStarted = false;
      else if (turn.kind === "assistant" || turn.kind === "thinking" || turn.kind === "tool-call") providerStarted = true;
    }
    if (!providerStarted) return;
    await daemon.publish(chat, { ...event("turn-cut", "", undefined, { reason: "process-exited", partial: turns.some((turn) => turn.at > since && turn.kind === "assistant") }), at: last.at, sourceId: marker });
    await daemon.publishInterrupted(chat);
  }

export async function logTurnOpen(daemon: ChatDaemon, chat: Chat): Promise<boolean> {
    const path = await sessionLogPath(chat, daemon.environment.HOME ?? homedir(), daemon.environment.GROK_HOME);
    if (path === null) return false;
    try { return sessionTurnOpen(chat.agent, await readFile(path, "utf8")); } catch { return false; }
  }

type TerminalTail = { content: string; byteOffset: number };

function parseTerminalTurns(agent: Chat["agent"], content: string): import(".././session-log.js").LoggedTurn[] {
  return agent === "claude" ? parseClaudeLog(content) : agent === "grok" ? parseGrokLog(content) : agent === "agy" ? parseAgyLog(content) : parseCodexRollout(content);
}

async function readTerminalTail(path: string, cursor: number, knownSize?: number): Promise<TerminalTail> {
  const file = await open(path, "r");
  try {
    const size = knownSize ?? (await file.stat()).size;
    const offset = cursor <= size ? cursor : 0;
    const remaining = size - offset;
    const bytes = Buffer.alloc(remaining);
    let bytesRead = 0;
    while (bytesRead < remaining) {
      const result = await file.read(bytes, bytesRead, remaining - bytesRead, offset + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const completeEnd = bytes.subarray(0, bytesRead).lastIndexOf(10) + 1;
    return { content: bytes.subarray(0, completeEnd).toString("utf8"), byteOffset: offset + completeEnd };
  } finally { await file.close(); }
}

export async function foreignHolders(daemon: ChatDaemon, chat: Chat, panes?: ReadonlyMap<number, string>, exclude: ReadonlySet<number> = new Set()): Promise<SessionHolder[]> {
    if (chat.agentSessionId === null) return [];
    if (panes === undefined) {
      const alias = daemon.entryOf(chat.id)?.[1].aliases.tmux ?? null;
      const [server, session] = (alias ?? "").split(":");
      if (server === OWNED_TMUX_SERVER && session?.startsWith(APP_SESSION_PREFIX)) panes = await daemon.panesOf(session);
    }
    const own = new Set([...daemon.children.values()].flatMap((child) => child.pid === undefined ? [] : [child.pid]));
    for (const pid of exclude) own.add(pid);
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
    const holders = await daemon.foreignHolders(chat, panes);
    const ended = holders.filter((holder) => holder.tmuxSession?.startsWith(APP_SESSION_PREFIX) === true);
    const elsewhere = holders.filter((holder) => !ended.includes(holder));
    if (elsewhere.length > 0) throw new ChatHandoffError("terminal-busy", heldMessage(chat, elsewhere));
    if (ended.length > 0 && await daemon.logTurnOpen(chat)) {
      throw new ChatHandoffError("terminal-busy", "the terminal is still working; wait or interrupt it before switching to chat");
    }
    const sessions = new Set(ended.flatMap((holder) => holder.tmuxSession === null ? [] : [holder.tmuxSession]));
    if (own !== null) sessions.add(own);
    const tmux = ownedTmuxProcess(daemon.processes());
    for (const session of sessions) {
      const capture = await tmux.run("tmux", ["capture-pane", "-p", "-S", "-30", "-t", `=${session}`]);
      if (capture.kind === "ok") {
        const draft = unsentTerminalText(capture.value.stdout);
        if (draft !== null) await daemon.publish(chat, event("system", `Unsent text from the terminal: ${draft}`));
      }
    }

    // The pane can outlive kill-session, and Claude may keep its session registration while it flushes.
    // Retire the process tree first; the bounded wait handles slow shutdowns without racing resume.
    const pids = new Set(ended.map((holder) => holder.pid));
    for (const pid of pids) try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const active = await daemon.foreignHolders(chat, panes, pids);
      const ownActive = active.filter((holder) => holder.tmuxSession?.startsWith(APP_SESSION_PREFIX) === true);
      for (const holder of ownActive) {
        if (pids.has(holder.pid)) continue;
        pids.add(holder.pid);
        try { process.kill(holder.pid, "SIGTERM"); } catch { /* already gone */ }
      }
      const foreign = active.filter((holder) => !holder.tmuxSession?.startsWith(APP_SESSION_PREFIX));
      if (foreign.length > 0) throw new ChatHandoffError("terminal-busy", heldMessage(chat, foreign));
      if (ownActive.length === 0 && [...pids].every((pid) => !pidAlive(pid))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if ([...pids].some(pidAlive)) {
      if (await daemon.logTurnOpen(chat)) throw new ChatHandoffError("terminal-busy", "the terminal is still working; wait or interrupt it before switching to chat");
      for (const pid of pids) if (pidAlive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* exited between check and signal */ }
      const killedBy = Date.now() + 2_000;
      while (Date.now() < killedBy && [...pids].some(pidAlive)) await new Promise((resolve) => setTimeout(resolve, 25));
      if ([...pids].some(pidAlive)) throw new ChatHandoffError("terminal-busy", "the terminal process did not exit; retry the switch after it closes");
    }

    for (const session of sessions) {
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
    return pids;
  }

export async function refreshTerminalChats(daemon: ChatDaemon): Promise<void> {
    for (const listed of await daemon.store.list()) {
      if (daemon.closed) return;
      if (listed.agentSessionId === null && listed.mode === "terminal") {
        const found = await daemon.sessionOfTerminal(listed);
        if (found !== null) { listed.agentSessionId = found; await daemon.save(listed); }
      }
      const terminalSelected = listed.mode === "terminal";
      const terminalOwns = listed.owner === "terminal" || (listed.owner === undefined && terminalSelected);
      if (!terminalSelected && !terminalOwns || listed.agentSessionId === null) continue;
      const path = await sessionLogPath(listed, daemon.environment.HOME ?? homedir(), daemon.environment.GROK_HOME);
      let content: string;
      let key: string;
      let logExists = false;
      let turnOpen = listed.terminalTurnOpen ?? false;
      try {
        const info = await stat(path ?? "");
        key = `${info.size}:${info.mtimeMs}`;
        logExists = true;
        const tail = await readTerminalTail(path ?? "", listed.terminalLogCursor?.byteOffset ?? 0, info.size);
        content = tail.content;
        turnOpen = sessionTurnOpen(listed.agent, content, turnOpen);
      } catch { content = ""; key = ""; }
      const hadRead = daemon.terminalLogs.has(listed.id);
      const previousKey = daemon.terminalLogs.get(listed.id);
      daemon.terminalLogs.set(listed.id, key);
      const holders = await daemon.foreignHolders(listed);
      const active = holders.length > 0;
      const owner: Chat["owner"] = active || (terminalSelected && (listed.owner === undefined || listed.owner === "terminal")) ? "terminal" : "none";
      if (owner === "terminal" && logExists && (!hadRead || previousKey !== key)) await daemon.importTerminalTurns(listed, false);
      if (owner === "terminal" && logExists && path !== null) {
        const currentWatch = daemon.terminalFileWatches.get(listed.id);
        if (currentWatch?.path !== path) {
          currentWatch?.close();
          try {
            const watcher = watchFile(path, () => { void daemon.refreshTerminalChats().catch(() => undefined); });
            watcher.on("error", () => { watcher.close(); daemon.terminalFileWatches.delete(listed.id); });
            daemon.terminalFileWatches.set(listed.id, { path, close: () => watcher.close() });
          } catch { /* the polling refresh is the fallback for missing or inaccessible logs */ }
        }
      } else {
        daemon.terminalFileWatches.get(listed.id)?.close();
        daemon.terminalFileWatches.delete(listed.id);
      }
      const working = owner === "terminal" && turnOpen && active;
      const state: Chat["state"] = working ? "working" : "idle";
      // The record may have moved on while the log was read: only the same session/view snapshot is refreshed.
      const chat = await daemon.store.get(listed.id);
      if (daemon.closed) return;
      if (!chat || chat.terminalSince !== listed.terminalSince || chat.mode !== listed.mode || chat.owner !== listed.owner) continue;
      if (!working && owner === "terminal" && (await daemon.loadQueue(chat.id)).length > 0) {
        if (daemon.terminalHandoffs.has(chat.id)) continue;
        daemon.terminalHandoffs.add(chat.id);
        try { await daemon.takeOver(chat.id); }
        catch (error) { await daemon.fail(chat.id, error); }
        finally { daemon.terminalHandoffs.delete(chat.id); }
        continue;
      }
      let changed = false;
      if (chat.owner !== owner) { chat.owner = owner; changed = true; }
      if (chat.state !== state) { chat.state = state; changed = true; if (!working) chat.lastActivityAt = new Date().toISOString(); }
      if (changed) await daemon.save(chat);
    }
  }

export async function terminalCommand(daemon: ChatDaemon, id: string): Promise<string[]> {
    const chat = await daemon.requireChat(id);
    // The first message rides on the first TUI only; a later one resumes without it.
    const prompt = chat.pendingPrompt;
    if (prompt !== undefined) {
      delete chat.pendingPrompt;
      await daemon.save(chat);
    }
    return chatProtocolAdapters[chat.agent].terminalCommand(chat, prompt);
  }
