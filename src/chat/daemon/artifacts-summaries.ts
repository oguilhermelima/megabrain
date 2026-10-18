// Internal chat daemon artifacts summaries operations.
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

export function updateContext(daemon: ChatDaemon, chat: Chat, usage: Record<string, unknown>): void {
    const input = usage.input_tokens;
    const cacheCreation = usage.cache_creation_input_tokens;
    const cacheRead = usage.cache_read_input_tokens;
    const fields = [input, cacheCreation, cacheRead];
    if (fields.some((value) => value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0))) return;
    if (fields.some((value) => typeof value === "number")) setContextTokens(chat, fields.reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0));
    const output = usage.output_tokens;
    if ([input, output, cacheRead, cacheCreation].every((value) => value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) && typeof input === "number" && typeof output === "number") {
      chat.usageTokens = { input, output, ...(typeof cacheRead === "number" ? { cacheRead } : {}), ...(typeof cacheCreation === "number" ? { cacheWrite: cacheCreation } : {}) };
    }
  }

export function setContextTokens(chat: Chat, tokens: number): void {
    if (Number.isSafeInteger(tokens) && tokens >= 0) chat.contextTokens = tokens;
  }

export async function setModel(daemon: ChatDaemon, id: string, model: string, effort: string | null): Promise<Chat> {
    if (!model || model.length > 200) throw new Error("model must be a non-empty id no longer than 200 characters");
    const chat = await daemon.requireChat(id);
    if ((chat.state !== "idle" && chat.state !== "suspended") || chat.mode !== "chat") throw new Error(`cannot change the model while chat is ${chat.state}; wait until it is idle`);
    const previous = { model: chat.model, effort: chat.effort };
    chat.model = model;
    if (effort !== null) chat.effort = effort;
    if (chat.agent === "grok" && chat.state === "idle" && chat.agentSessionId) {
      const peer = daemon.acpPeers.get(id);
      if (peer) {
        try {
          await peer.request("session/set_config_option", { sessionId: chat.agentSessionId, configId: "model", value: { value: model } });
          if (effort !== null) await peer.request("session/set_config_option", { sessionId: chat.agentSessionId, configId: "reasoning_effort", value: { value: effort } });
        } catch (error) { chat.model = previous.model; chat.effort = previous.effort; throw error; }
      }
    }
    chat.lastActivityAt = new Date().toISOString();
    if (chat.agent === "claude" && chat.state === "idle") {
      const child = daemon.children.get(id);
      if (child) { daemon.children.delete(id); child.kill("SIGTERM"); }
      chat.state = "starting";
      await daemon.save(chat);
      daemon.trackCallback(daemon.runAgent(chat).catch((error) => daemon.fail(id, error)));
    } else await daemon.save(chat);
    daemon.publishLive(id, daemon.stateEvent(chat));
    return chat;
  }

export async function startArtifactWatch(daemon: ChatDaemon, chat: Chat): Promise<void> {
    if (daemon.artifactWatches.has(chat.id)) return;
    const artifacts = await listChatArtifacts(daemon.stateDir, chat, daemon.environment.HOME ?? homedir());
    const watch: ArtifactWatch = { timer: setInterval(() => { void daemon.checkArtifactWatch(chat); }, 1000), artifacts, storeFingerprint: "", fileFingerprint: "", refreshing: false };
    watch.storeFingerprint = chatArtifactStoreFingerprint(daemon.stateDir, artifacts);
    watch.fileFingerprint = chatArtifactFileFingerprint(artifacts);
    watch.timer.unref?.();
    daemon.artifactWatches.set(chat.id, watch);
  }

export function stopArtifactWatch(daemon: ChatDaemon, id: string): void {
    const watch = daemon.artifactWatches.get(id);
    if (watch !== undefined) clearInterval(watch.timer);
    daemon.artifactWatches.delete(id);
  }

export async function replaceArtifactSnapshot(daemon: ChatDaemon, chat: Chat, watch: ArtifactWatch, artifacts: ChatArtifact[]): Promise<void> {
    artifacts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    const changed = chatArtifactSignature(watch.artifacts) !== chatArtifactSignature(artifacts);
    watch.artifacts = artifacts;
    watch.storeFingerprint = chatArtifactStoreFingerprint(daemon.stateDir, artifacts);
    watch.fileFingerprint = chatArtifactFileFingerprint(artifacts);
    if (changed) daemon.publishLive(chat.id, event("artifacts", ""));
  }

export async function refreshClaudeArtifacts(daemon: ChatDaemon, chat: Chat): Promise<void> {
    const watch = daemon.artifactWatches.get(chat.id);
    if (watch === undefined || watch.refreshing) return;
    watch.refreshing = true;
    try {
      const claude = await listClaudeChatArtifacts(chat, daemon.environment.HOME ?? homedir());
      const artifacts = [...watch.artifacts.filter((artifact) => artifact.source !== "claude-artifact" && artifact.source !== "claude-design"), ...claude.map((item) => item.artifact)];
      await daemon.replaceArtifactSnapshot(chat, watch, artifacts);
    } catch { /* a session log can be mid-write; the next tool result or local mtime check will retry */ }
    finally { watch.refreshing = false; }
  }

export async function checkArtifactWatch(daemon: ChatDaemon, chat: Chat): Promise<void> {
    const watch = daemon.artifactWatches.get(chat.id);
    if (watch === undefined || watch.refreshing || daemon.subscribers.get(chat.id)?.size === 0) return;
    const storeFingerprint = chatArtifactStoreFingerprint(daemon.stateDir, watch.artifacts);
    const fileFingerprint = chatArtifactFileFingerprint(watch.artifacts);
    if (storeFingerprint === watch.storeFingerprint && fileFingerprint === watch.fileFingerprint) return;
    watch.refreshing = true;
    try {
      let artifacts = watch.artifacts;
      if (storeFingerprint !== watch.storeFingerprint) {
        const megabrain = await listMegabrainChatArtifacts(daemon.stateDir, chat);
        artifacts = [...artifacts.filter((artifact) => artifact.source !== "megabrain"), ...megabrain.map((item) => item.artifact)];
      }
      if (fileFingerprint !== watch.fileFingerprint) {
        artifacts = artifacts.map((artifact) => {
          if (artifact.path === undefined) return artifact;
          try { return { ...artifact, updatedAt: statSync(artifact.path).mtime.toISOString() }; }
          catch { return artifact; }
        });
      }
      await daemon.replaceArtifactSnapshot(chat, watch, artifacts);
    } catch { /* files can disappear during a check; keep the last complete snapshot */ }
    finally { watch.refreshing = false; }
  }
