// Internal chat daemon agent streams operations.
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
import { setContextTokens } from "./artifacts-summaries.js";
import { DRAINING, DEFAULT_TERMINAL_POLL_MS, DEFAULT_HANDOVER_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, timeoutsFor, heldMessage, SessionHeldError, unsentTerminalText, object, text, validateParts, firstText, event, withImages, withMessage, flattenContent, codexReasoning, count, instances, timeoutMs } from "../daemon.js";
import type { Part, Request, Response, Environment, Timeouts, ArtifactWatch } from "../daemon.js";
import { answeredCommand } from "./local-command.js";

export async function handleClaudeStream(daemon: ChatDaemon, id: string, streamEvent: Record<string, unknown>): Promise<void> {
    const kind = text(streamEvent.type);
    if (kind === "message_start") {
      const message = object(streamEvent.message);
      daemon.currentMessage.set(id, text(message.id));
      const chat = await daemon.requireChat(id);
      daemon.updateContext(chat, object(message.usage));
      await daemon.save(chat);
      daemon.countClaude(id, (tokens) => ({ ...tokens, thinking: 0, textChars: 0 }), false);
      return;
    }
    if (kind === "content_block_delta") {
      const delta = object(streamEvent.delta);
      const messageId = daemon.currentMessage.get(id) ?? "";
      if (delta.type === "text_delta") {
        daemon.publishLive(id, event("delta", text(delta.text), undefined, { stream: "assistant", ...withMessage(messageId) }));
        daemon.countClaude(id, (tokens) => ({ ...tokens, textChars: tokens.textChars + text(delta.text).length }));
      }
      // Without summarized display a chunk carries only a token estimate, which system/thinking_tokens reports too.
      else if (delta.type === "thinking_delta" && text(delta.thinking) !== "") daemon.publishLive(id, event("delta", text(delta.thinking), undefined, { stream: "thinking", ...withMessage(messageId) }));
      return;
    }
    if (kind === "message_delta") {
      const output = count(object(streamEvent.usage).output_tokens);
      if (output !== undefined) daemon.countClaude(id, (tokens) => ({ done: tokens.done + output, thinking: 0, textChars: 0 }));
      return;
    }
    const block = object(streamEvent.content_block);
    // An Agent call is published from the complete message, which carries the type and description its subagent shows.
    if (kind === "content_block_start" && block.type === "tool_use" && !isClaudeSubagentTool(text(block.name))) await daemon.publishToolCall(id, text(block.id), text(block.name), "");
  }

export async function publishToolCall(daemon: ChatDaemon, id: string, toolUseId: string, name: string, input: string, extra: Partial<ChatEvent> = {}): Promise<void> {
    const names = daemon.toolNames.get(id) ?? new Map<string, string>();
    daemon.toolNames.set(id, names);
    if (names.has(toolUseId)) return;
    names.set(toolUseId, name);
    const chat = await daemon.requireChat(id);
    await daemon.publish(chat, event("tool-call", name, { name, input }, extra));
  }

export async function startSubagent(daemon: ChatDaemon, chat: Chat, subagent: Subagent, name: string, input: string): Promise<void> {
    const known = daemon.subagents.get(chat.id) ?? new Map<string, { name: string; background: boolean; ended: boolean }>();
    daemon.subagents.set(chat.id, known);
    if (known.has(subagent.id)) return;
    known.set(subagent.id, { name, background: false, ended: false });
    await daemon.publish(chat, event("tool-call", name, { name, input }, { subagent }));
  }

export async function endSubagent(daemon: ChatDaemon, chat: Chat, end: SubagentEnd): Promise<void> {
    const known = daemon.subagents.get(chat.id)?.get(end.id);
    if (known === undefined || known.ended) return;
    known.ended = true;
    await daemon.publish(chat, event("tool-result", end.text, { name: known.name, status: end.status === "completed" ? "ok" : "error" }, { subagent: { id: end.id, status: end.status } }));
  }

export async function publishClaudeStep(daemon: ChatDaemon, chat: Chat, parentId: string, item: Record<string, unknown>): Promise<void> {
    const blocks = Array.isArray(object(item.message).content) ? (object(item.message).content as unknown[]).map(object) : [];
    const identity = { parentId, ...withMessage(text(object(item.message).id)) };
    for (const block of blocks) {
      if (item.type === "assistant" && block.type === "thinking" && text(block.thinking) !== "") await daemon.publish(chat, event("thinking", text(block.thinking), undefined, identity));
      else if (item.type === "assistant" && block.type === "text" && text(block.text) !== "") await daemon.publish(chat, event("assistant", text(block.text), undefined, identity));
      else if (item.type === "assistant" && block.type === "tool_use") await daemon.publishToolCall(chat.id, text(block.id), text(block.name), JSON.stringify(block.input ?? {}), { parentId });
      else if (item.type === "user" && block.type === "tool_result") {
        const name = daemon.toolNames.get(chat.id)?.get(text(block.tool_use_id)) ?? "tool";
        await daemon.publish(chat, event("tool-result", flattenContent(block.content), { name, status: block.is_error === true ? "error" : "ok" }, { parentId }));
      }
    }
  }

export async function handleClaude(daemon: ChatDaemon, id: string, child: ChildProcessWithoutNullStreams, item: Record<string, unknown>): Promise<void> {
    // A subagent's output names the Agent call that runs it; its chunks are never the chat's own.
    const parentId = text(item.parent_tool_use_id);
    if (item.type === "stream_event") { if (parentId === "") await daemon.handleClaudeStream(id, object(item.event)); return; }
    const chat = await daemon.requireChat(id);
    if (parentId !== "" && (item.type === "assistant" || item.type === "user")) { await daemon.publishClaudeStep(chat, parentId, item); return; }
    if (item.type === "system" && item.subtype === "thinking_tokens") {
      const estimate = count(item.estimated_tokens);
      if (estimate !== undefined) daemon.countClaude(id, (tokens) => ({ ...tokens, thinking: estimate }));
      return;
    }
    if (item.type === "system" && item.subtype === "api_retry") {
      const retry = { attempt: count(item.attempt), maxAttempts: count(item.max_retries), delayMs: count(item.retry_delay_ms), reason: text(item.error) || undefined };
      daemon.publishProgress(id, { retry: Object.fromEntries(Object.entries(retry).filter(([, value]) => value !== undefined)) });
      return;
    }
    if (item.type === "system" && item.subtype === "status") { if (text(item.status) !== "") daemon.publishProgress(id, { status: text(item.status) }); return; }
    if (item.type === "system" && item.subtype === "task_notification") {
      // A foreground subagent ends on its hand-back, which carries the whole report; a background one only here.
      const end = claudeNotified(item);
      if (daemon.subagents.get(id)?.get(end.id)?.background === true) await daemon.endSubagent(chat, end);
      return;
    }
    if (item.type === "system" && item.subtype === "init") {
      if (typeof item.session_id === "string") chat.agentSessionId = item.session_id;
      if (Array.isArray(item.slash_commands)) chat.slashCommands = item.slash_commands.filter((name): name is string => typeof name === "string");
      if (chat.state === "starting") chat.state = "idle";
      await daemon.save(chat);
      await daemon.drain(id);
      return;
    }
    if (item.type === "assistant") {
      const message = object(item.message);
      if (message.model !== "<synthetic>") daemon.updateContext(chat, object(message.usage));
      await daemon.save(chat);
      const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
      const textValue = blocks.filter((block) => block.type === "text").map((block) => text(block.text)).join("");
      const thinking = blocks.filter((block) => block.type === "thinking").map((block) => text(block.thinking)).join("");
      const identity = withMessage(text(message.id));
      if (thinking) await daemon.publish(chat, event("thinking", thinking, undefined, identity));
      // A local command's output (/usage, /cost) comes as a message from the <synthetic> model.
      const command = textValue && message.model === "<synthetic>" ? await answeredCommand(daemon.store, id) : undefined;
      if (textValue) await daemon.publish(chat, event("assistant", textValue, undefined, command === undefined ? identity : { ...identity, command }));
      for (const block of blocks.filter((candidate) => candidate.type === "tool_use")) {
        const input = JSON.stringify(block.input ?? {});
        if (isClaudeSubagentTool(text(block.name))) await daemon.startSubagent(chat, claudeSubagent(text(block.id), block.input), text(block.name), input);
        else await daemon.publishToolCall(id, text(block.id), text(block.name), input);
      }
      return;
    }
    if (item.type === "user") {
      const blocks = Array.isArray(object(item.message).content) ? (object(item.message).content as unknown[]).map(object) : [];
      for (const block of blocks.filter((candidate) => candidate.type === "tool_result")) {
        const subagent = daemon.subagents.get(id)?.get(text(block.tool_use_id));
        if (subagent !== undefined) {
          const end = claudeHandBack(text(block.tool_use_id), block, item.tool_use_result);
          if (end === null) subagent.background = true;
          else await daemon.endSubagent(chat, end);
          continue;
        }
        const name = daemon.toolNames.get(id)?.get(text(block.tool_use_id)) ?? "tool";
        await daemon.publish(chat, event("tool-result", flattenContent(block.content), { name, status: block.is_error === true ? "error" : "ok" }));
      }
      return;
    }
    if (item.type === "result") {
      // The interrupted turn's own result, after a message sent now already started the next turn.
      if (item.is_error === true && daemon.interrupting.has(id) && chat.state === "working") { daemon.interrupting.delete(id); return; }
      if (typeof item.session_id === "string") chat.agentSessionId = item.session_id;
      const modelUsage = object(item.modelUsage);
      const modelUsageEntry = object(modelUsage[chat.model ?? ""] ?? Object.values(modelUsage)[0]);
      const window = modelUsageEntry.contextWindow;
      if (typeof window === "number" && Number.isSafeInteger(window) && window > 0) chat.contextWindow = window;
      chat.state = item.is_error === true ? "idle" : "idle";
      chat.error = null;
      chat.lastActivityAt = new Date().toISOString();
      await daemon.save(chat);
      if (item.is_error === true && daemon.interrupting.has(id)) daemon.interrupting.delete(id);
      // The turn ended: a foreground subagent that never handed back was stopped with it.
      for (const [subagentId, subagent] of daemon.subagents.get(id) ?? []) if (!subagent.background) await daemon.endSubagent(chat, { id: subagentId, status: "stopped", text: "" });
      await daemon.drain(id);
    }
    if (item.type === "control_request") {
      const request = object(item.request);
      if (request.subtype === "can_use_tool") await daemon.createApproval(chat, text(request.tool_name), JSON.stringify(request.input ?? {}), text(request.tool_use_id));
    }
  }

export function settleRpc(daemon: ChatDaemon, id: string, item: Record<string, unknown>): boolean {
    if (typeof item.id !== "number" || !("result" in item || "error" in item)) return false;
    const waiter = daemon.rpcWaiters.get(id)?.get(item.id);
    if (waiter) { daemon.rpcWaiters.get(id)?.delete(item.id); item.error ? waiter.reject(new Error(text(object(item.error).message) || "Codex request failed")) : waiter.resolve(item.result); }
    return true;
  }

export async function handleCodex(daemon: ChatDaemon, id: string, child: ChildProcessWithoutNullStreams, item: Record<string, unknown>): Promise<void> {
    const method = text(item.method);
    const params = object(item.params);
    const chat = await daemon.requireChat(id);
    // A spawned thread reports through the same connection; only its steps are shown, under its subagent.
    const thread = text(params.threadId);
    if (thread !== "" && chat.agentSessionId !== null && thread !== chat.agentSessionId) { await daemon.handleCodexSubagent(chat, thread, method, params); return; }
    if (method === "thread/tokenUsage/updated") {
      const usage = object(params.tokenUsage);
      const last = object(usage.last);
      const input = count(last.inputTokens);
      const window = usage.modelContextWindow;
      if (input !== undefined) setContextTokens(chat, input);
      if (typeof window === "number" && Number.isSafeInteger(window) && window > 0) chat.contextWindow = window;
      await daemon.save(chat);
      const total = count(object(usage.total).outputTokens);
      const latest = count(object(usage.last).outputTokens) ?? 0;
      if (total !== undefined) {
        const base = daemon.codexTokenBase.get(id) ?? Math.max(0, total - latest);
        daemon.codexTokenBase.set(id, base);
        daemon.publishProgress(id, { tokens: total - base });
      }
    } else if (method === "error") {
      if (params.willRetry === true) daemon.publishProgress(id, { retry: { reason: text(object(params.error).message) || "error" } });
    } else if (method === "item/reasoning/summaryPartAdded") {
      // Each summary part is a paragraph of its own, as the stored reasoning shows it.
      const index = count(params.summaryIndex);
      if (index !== undefined && index > 0) daemon.publishLive(id, event("delta", "\n\n", undefined, { stream: "thinking", ...withMessage(text(params.itemId)) }));
    } else if (/delta$/i.test(method) && /reasoning|thinking|agentMessage|assistantMessage/.test(method)) {
      const stream = /reasoning|thinking/.test(method) ? "thinking" : "assistant";
      daemon.publishLive(id, event("delta", text(params.delta ?? params.text), undefined, { stream, ...withMessage(text(params.itemId)) }));
    } else if (method.includes("reasoning") || method.includes("thinking")) { if (text(params.delta ?? params.text) !== "") await daemon.publish(chat, event("thinking", text(params.delta ?? params.text))); }
    else if (method.includes("agentMessage") || method.includes("assistantMessage")) await daemon.publish(chat, event("assistant", text(params.delta ?? params.text)));
    else if (method === "item/started") {
      const itemData = object(params.item);
      if (text(itemData.type).toLowerCase().includes("command")) await daemon.publish(chat, event("tool-call", text(itemData.command), { name: "command", input: text(itemData.command) }));
    } else if (method === "item/completed") {
      const itemData = object(params.item);
      const type = text(itemData.type).toLowerCase();
      for (const subagent of codexSpawned(itemData)) await daemon.startSubagent(chat, subagent, text(itemData.tool), text(itemData.prompt));
      for (const end of codexEnded(itemData)) await daemon.endSubagent(chat, end);
      if (type === "agentmessage" && text(itemData.text)) await daemon.publish(chat, event("assistant", text(itemData.text), undefined, withMessage(text(itemData.id))));
      if (type === "reasoning" && codexReasoning(itemData)) await daemon.publish(chat, event("thinking", codexReasoning(itemData), undefined, withMessage(text(itemData.id))));
      if (type.includes("command")) await daemon.publish(chat, event("tool-result", text(itemData.aggregatedOutput ?? itemData.output), { name: "command", status: itemData.exitCode === 0 ? "ok" : "error" }));
      if (type.includes("approval") && typeof params.id === "number") await daemon.resolveApproval(id, params.id, { decision: "accept" });
    } else if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const approval = await daemon.createApproval(chat, method.includes("fileChange") ? "file change" : "command execution", JSON.stringify(params, null, 2), text(params.itemId));
      const requestId = Number(item.id);
      if (Number.isFinite(requestId)) daemon.pendingRpcApproval.set(`${id}:${requestId}`, approval.id);
    } else if (method === "turn/started") {
      const turn = text(params.turnId);
      daemon.activeTurns.set(id, turn);
      chat.state = "working";
      await daemon.save(chat);
    } else if (method === "turn/completed") {
      daemon.activeTurns.delete(id);
      chat.state = "idle";
      await daemon.save(chat);
      if (text(object(params.turn).status) === "interrupted" && daemon.interrupting.has(id)) {
        daemon.interrupting.delete(id);
        await daemon.publishInterrupted(chat);
      }
      await daemon.drain(id);
    }
  }

export async function handleCodexSubagent(daemon: ChatDaemon, chat: Chat, thread: string, method: string, params: Record<string, unknown>): Promise<void> {
    if (daemon.subagents.get(chat.id)?.has(thread) !== true) return;
    const itemData = object(params.item);
    const type = text(itemData.type).toLowerCase();
    const parent = { parentId: thread };
    if (method === "item/started" && type.includes("command")) await daemon.publish(chat, event("tool-call", text(itemData.command), { name: "command", input: text(itemData.command) }, parent));
    if (method !== "item/completed") return;
    if (type === "agentmessage" && text(itemData.text)) await daemon.publish(chat, event("assistant", text(itemData.text), undefined, { ...parent, ...withMessage(text(itemData.id)) }));
    const reasoning = codexReasoning(itemData);
    if (type === "reasoning" && reasoning) await daemon.publish(chat, event("thinking", reasoning, undefined, { ...parent, ...withMessage(text(itemData.id)) }));
    if (type.includes("command")) await daemon.publish(chat, event("tool-result", text(itemData.aggregatedOutput ?? itemData.output), { name: "command", status: itemData.exitCode === 0 ? "ok" : "error" }, parent));
  }

export async function codexRequest(daemon: ChatDaemon, child: ChildProcessWithoutNullStreams, method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = daemon.rpcSequence++;
    // The current child is keyed by its owning chat; it is set before initialize is requested.
    const chatId = [...daemon.children.entries()].find(([, process]) => process === child)?.[0];
    if (!chatId) throw new Error("Codex child is no longer active");
    const waiters = daemon.rpcWaiters.get(chatId) ?? new Map(); daemon.rpcWaiters.set(chatId, waiters);
    const result = new Promise<unknown>((resolve, reject) => waiters.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  }
