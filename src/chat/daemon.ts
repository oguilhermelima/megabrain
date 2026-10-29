import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProcessAdapter } from "../adapters/proc.js";
import type { Conversation } from "../core/conversations.js";
import type { SessionHolder } from "../core/session-holders.js";
import { statSync } from "node:fs";
import packageJson from "../../package.json" with { type: "json" };
import { ChatStore, type Chat, type ChatApproval, type ChatEvent, type ChatLine, type ChatProgress, type QueuedChatMessage } from "./store.js";
import { AcpPeer } from "./grok-acp.js";
import type { AgentTerminalCommand, MessagePart } from "./protocol.js";
import type { ChatArtifact } from "./artifacts.js";
import type { Subagent, SubagentEnd } from "./subagents.js";
import { KnowledgePipeline } from "../knowledge/pipeline.js";
import { ChatSummarizer } from "./summaries.js";
import { chatChildRecord, chatLock, chatPid, chatResumes, chatSocket, discardStaleState, filePid, pidAlive, socketAccepts, stopChild } from "./daemon/process-state.js";
import { dispatchRequest } from "./daemon/dispatch.js";
import { startKnowledge } from "./daemon/knowledge-wiring.js";
import { events as eventsImpl, permission as permissionImpl, createApproval as createApprovalImpl, approve as approveImpl, resolveApproval as resolveApprovalImpl, stateEvent as stateEventImpl, publishLive as publishLiveImpl, publishProgress as publishProgressImpl, countClaude as countClaudeImpl, broadcast as broadcastImpl, publish as publishImpl, publishInterrupted as publishInterruptedImpl, fail as failImpl } from "./daemon/events.js";
import { start as startImpl, handle as handleImpl, startChat as startChatImpl, suspendActive as suspendActiveImpl, handover as handoverImpl, busy as busyImpl, liveChats as liveChatsImpl, daemonStatus as daemonStatusImpl, drainDaemon as drainDaemonImpl, retireDaemon as retireDaemonImpl, scheduleExit as scheduleExitImpl, close as closeImpl, closeDaemon as closeDaemonImpl, listen as listenImpl } from "./daemon/server.js";
import { queueOperation as queueOperationImpl, loadQueue as loadQueueImpl, persistQueue as persistQueueImpl, enqueue as enqueueImpl, drain as drainImpl, drainOnce as drainOnceImpl } from "./daemon/queue.js";
import { resumeDrained as resumeDrainedImpl, send as sendImpl, resume as resumeImpl, deliver as deliverImpl, resumeFailed as resumeFailedImpl } from "./daemon/resume.js";
import { trackCallback as trackCallbackImpl, runAgent as runAgentImpl, runAgentInternal as runAgentInternalImpl, clearTerminalHoldersBeforeResume as clearTerminalHoldersBeforeResumeImpl, armStartTimer as armStartTimerImpl, clearStartTimer as clearStartTimerImpl, interrupt as interruptImpl, stop as stopImpl } from "./daemon/agent-process.js";
import { handleClaudeStream as handleClaudeStreamImpl, publishToolCall as publishToolCallImpl, startSubagent as startSubagentImpl, endSubagent as endSubagentImpl, publishClaudeStep as publishClaudeStepImpl, handleClaude as handleClaudeImpl, settleRpc as settleRpcImpl, handleCodex as handleCodexImpl, handleCodexSubagent as handleCodexSubagentImpl, codexRequest as codexRequestImpl, publishTurnCut as publishTurnCutImpl, publishBackgroundTask as publishBackgroundTaskImpl, handleGrok as handleGrokImpl, handleGrokRequest as handleGrokRequestImpl, finishGrokTurn as finishGrokTurnImpl } from "./daemon/agent-streams.js";
import { rename as renameImpl, remove as removeImpl, mode as modeImpl, takeOver as takeOverImpl, importTerminalTurns as importTerminalTurnsImpl, logTurnOpen as logTurnOpenImpl, foreignHolders as foreignHoldersImpl, panesOf as panesOfImpl, endAppTerminals as endAppTerminalsImpl, refreshTerminalChats as refreshTerminalChatsImpl, terminalCommand as terminalCommandImpl } from "./daemon/terminal-mode.js";
import { updateContext as updateContextImpl, setModel as setModelImpl, startArtifactWatch as startArtifactWatchImpl, stopArtifactWatch as stopArtifactWatchImpl, replaceArtifactSnapshot as replaceArtifactSnapshotImpl, refreshClaudeArtifacts as refreshClaudeArtifactsImpl, checkArtifactWatch as checkArtifactWatchImpl } from "./daemon/artifacts-summaries.js";
import { requireChat as requireChatImpl, normalizeParts as normalizePartsImpl, processes as processesImpl, entryOf as entryOfImpl, track as trackImpl, dropConversation as dropConversationImpl, pruneUnused as pruneUnusedImpl, sessionOfTerminal as sessionOfTerminalImpl, save as saveImpl } from "./daemon/chat-state.js";
import { fork as forkImpl } from "./daemon/chat-fork.js";
import { editLast as editLastImpl } from "./daemon/chat-edit-last.js";
import { AppControlBroker } from "./app-control.js";

type Part = MessagePart;
type Request = { operation: string; [key: string]: unknown };
type Response = { ok: true; value?: unknown } | { ok: false; error: string; code?: string; liveChats?: number };
type Environment = Readonly<Record<string, string | undefined>>;
const instances = new Map<string, ChatDaemon>();

// macOS limits Unix socket paths to a small fixed buffer; state directories under its long
// per-user temporary root need a short basename while remaining scoped to the state directory.
/** Increment when the socket wire changes; keep the minimum at the oldest protocol this server can serve. */
export const CHAT_PROTOCOL_VERSION = 3;
export const CHAT_PROTOCOL_MIN_VERSION = 1;
const DRAINING = "chatd is draining for an upgrade";
const DEFAULT_TERMINAL_POLL_MS = 500;

/**
 * Which build of megabrain this is: the modification time of the script or binary running it. A newer CLI
 * finding an older chatd asks it to drain, so an upgrade never stops a working agent.
 */
export function chatBuild(argv: readonly string[] = process.argv, execPath: string = process.execPath): number {
  for (const path of [argv[1], execPath]) {
    if (path === undefined || path.startsWith("/$bunfs/")) continue;
    try { return Math.floor(statSync(path).mtimeMs); } catch { /* not a file: the next candidate */ }
  }
  return 0;
}
const DEFAULT_HANDOVER_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
function timeoutMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
type Timeouts = { connect: number; request: number };
function timeoutsFor(environment: Environment): Timeouts {
  return { connect: timeoutMs(environment.MEGABRAIN_CHATD_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS), request: timeoutMs(environment.MEGABRAIN_CHATD_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS) };
}
function heldMessage(chat: Chat, holders: readonly SessionHolder[]): string {
  const where = holders.map((holder) => {
    const place = holder.tmuxSession === null ? "terminal process" : `tmux session ${holder.tmuxSession}`;
    return `${place}, pid ${holder.pid}${holder.cwd === null ? "" : `, cwd ${holder.cwd}`}`;
  }).join("; ");
  return `${chat.agent} session ${chat.agentSessionId ?? ""} is already open in another process (${where}); close it there and Retry, or start fresh`;
}
export class ChatHandoffError extends Error {
  constructor(readonly code: "terminal-busy" | "chat-busy", message: string) { super(message); }
}
class SessionHeldError extends Error {
  constructor(chat: Chat, holders: readonly SessionHolder[]) { super(heldMessage(chat, holders)); }
}
function unsentTerminalText(pane: string): string | null {
  const lines = pane.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
  const prompt = lines.map((line) => /^\s*[❯›>]\s?(.*)$/.exec(line)).filter((match) => match !== null).at(-1);
  const text = prompt?.[1] ?? "";
  return text.trim() === "" ? null : text;
}
function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function validateParts(value: unknown): Part[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("--parts must be a non-empty JSON array");
  return value.map((part, index) => {
    const item = object(part);
    if (item.type === "text" && typeof item.text === "string") return { type: "text", text: item.text };
    if (item.type === "image" && typeof item.path === "string" && item.path !== "") return { type: "image", path: item.path };
    throw new Error(`invalid message part at index ${index}`);
  });
}
function firstText(parts: readonly Part[]): string { return parts.filter((part): part is Extract<Part, { type: "text" }> => part.type === "text").map((part) => part.text).join("").trim(); }
function event(kind: ChatEvent["kind"], value: string, tool?: ChatEvent["tool"], extra: Partial<ChatEvent> = {}): ChatEvent {
  return { id: randomUUID(), at: new Date().toISOString(), kind, text: value, ...(tool === undefined ? {} : { tool }), ...extra };
}
/**
 * The images a message carried, for its user event, and its parts in order so a reader can show each image where it
 * was placed; images stays for readers that predate parts. A message of text alone carries neither field.
 */
function withImages(parts: readonly Part[]): Partial<ChatEvent> {
  const images = parts.flatMap((part) => part.type === "image" ? [{ path: part.path }] : []);
  return images.length === 0 ? {} : { images, parts: [...parts] };
}
function withMessage(messageId: string): Partial<ChatEvent> { return messageId === "" ? {} : { messageId }; }
/** The text of a tool result or a reasoning summary, given as a string or as parts. */
function flattenContent(value: unknown): string { return Array.isArray(value) ? value.map(flattenContent).join("") : typeof value === "object" && value !== null ? text((value as Record<string, unknown>).text) : text(value); }
/** A Codex reasoning item's text: its summary parts as paragraphs (each streamed as a part of its own), else its raw content. */
function codexReasoning(item: Record<string, unknown>): string {
  const parts = Array.isArray(item.summary) ? item.summary.map(flattenContent).filter((part) => part !== "") : [];
  return parts.join("\n\n") || flattenContent(item.content);
}
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
type ArtifactWatch = { timer: ReturnType<typeof setInterval>; artifacts: ChatArtifact[]; storeFingerprint: string; fileFingerprint: string; refreshing: boolean };

/** Owns every chat child. The CLI is a short-lived socket client; chatd keeps this object alive. */
export type { Part, Request, Response, Environment, Timeouts, ArtifactWatch };
export { DRAINING, DEFAULT_TERMINAL_POLL_MS, DEFAULT_HANDOVER_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, timeoutsFor, heldMessage, SessionHeldError, unsentTerminalText, object, text, validateParts, firstText, event, withImages, withMessage, flattenContent, codexReasoning, count, instances };
export { timeoutMs };

export class ChatDaemon {
  readonly store: ChatStore;
  readonly appControl: AppControlBroker;
  // These fields are internal to src/chat and are shared with its daemon collaborators.
  readonly summarizer: ChatSummarizer;
  readonly knowledge: KnowledgePipeline;
  scanning = false;
  readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  readonly agentRuns = new Set<Promise<void>>();
  readonly childExits = new Set<Promise<void>>();
  readonly callbacks = new Set<Promise<unknown>>();
  /** Messages already sent that wait for the agent to be ready: the first message of a start or a resume, or one sent now. */
  readonly queues = new Map<string, Part[][]>();
  /** The person's queue: messages sent during a turn, persisted, drained one per turn. Loaded once per chat. */
  readonly queued = new Map<string, QueuedChatMessage[]>();
  readonly queueWrites = new Map<string, Promise<unknown>>();
  /** An interrupt holds the queue until the person sends again, so stopping a turn never fires a queued message. */
  readonly queueHeld = new Set<string>();
  readonly drainChains = new Map<string, Promise<unknown>>();
  readonly activeTurns = new Map<string, string>();
  /** Prevent overlapping transcript mutations from racing a send or another fork/edit operation. */
  readonly chatMutations = new Set<string>();
  readonly interrupting = new Set<string>();
  readonly interruptedEvents = new Set<string>();
  readonly turnHasPartial = new Set<string>();
  readonly cutTurns = new Set<string>();
  readonly backgroundTasks = new Map<string, Map<string, import("./store.js").BackgroundTask>>();
  readonly pendingApprovals = new Map<string, { approval: ChatApproval; resolve: (decision: string) => void }>();
  readonly subscribers = new Map<string, Set<(line: ChatLine, live?: boolean) => void>>();
  readonly artifactWatches = new Map<string, ArtifactWatch>();
  readonly eventChains = new Map<string, Promise<void>>();
  readonly startTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly outputSeen = new Set<string>();
  readonly appendChains = new Map<string, Promise<unknown>>();
  /** Terminal log imports read then advance one cursor, so they must run one at a time per chat. */
  readonly terminalImportChains = new Map<string, Promise<void>>();
  readonly publishedState = new Map<string, Chat["state"]>();
  readonly turnStarted = new Map<string, string>();
  readonly currentMessage = new Map<string, string>();
  /**
   * A Claude turn's output tokens: the exact count of its finished messages, and the current message's estimate
   * from Claude's own thinking estimate plus its text so far at four characters a token.
   */
  readonly claudeTokens = new Map<string, { done: number; thinking: number; textChars: number }>();
  /** A Codex turn counts from the thread's output tokens before it, which a resumed thread carries from earlier turns. */
  readonly codexTokenBase = new Map<string, number>();
  readonly grokMessages = new Map<string, { id: string; text: string; thinking: string }>();
  readonly toolNames = new Map<string, Map<string, string>>();
  readonly backgroundTaskIds = new Map<string, Map<string, string>>();
  /** Each chat's subagents by id: the tool that started one, whether it runs in the background, whether it ended. */
  readonly subagents = new Map<string, Map<string, { name: string; background: boolean; ended: boolean }>>();
  /** Removed chats: late agent output must not write their record back. */
  readonly removed = new Set<string>();
  /** The registry key each chat was last written under, so a save only touches the file when the key changes. */
  readonly tracked = new Map<string, string>();
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set by a drain: running turns finish, no new one starts, and the queue waits for the next daemon. */
  draining = false;
  readonly resumeOnStart = new Set<string>();
  readonly knowledgeTimers: ReturnType<typeof setTimeout>[] = [];
  readonly knowledgeTasks = new Set<Promise<void>>();
  terminalTimer: ReturnType<typeof setInterval> | undefined;
  terminalRefresh: Promise<void> | undefined;
  terminalRefreshTask: Promise<void> | undefined;
  terminalRefreshError: string | null = null;
  /** Each terminal-mode chat's log as last read (size and mtime), so an unchanged idle log is not parsed again. */
  readonly terminalLogs = new Map<string, string>();
  readonly terminalHandoffs = new Set<string>();
  readonly terminalFileWatches = new Map<string, { path: string; close: () => void }>();
  clients = 0;
  closed = false;
  closing: Promise<void> | undefined;
  readonly sockets = new Set<Socket>();
  readonly version = packageJson.version;
  superseded = false;
  exitReason = "shutdown";
  constructor(readonly stateDir: string, readonly environment: Environment = process.env, readonly protocol: number = CHAT_PROTOCOL_VERSION, readonly build: number = chatBuild()) { this.appControl = new AppControlBroker(timeoutMs(environment.MEGABRAIN_APP_CONTROL_TIMEOUT_MS, 5000)); this.store = new ChatStore(stateDir); this.knowledge = new KnowledgePipeline({ stateDir, environment }); this.summarizer = new ChatSummarizer({ store: this.store, stateDir, environment, pipeline: this.knowledge, emit: (chat, value) => this.publish(chat, value), alive: (id) => !this.removed.has(id) }); }

async start(): Promise<void> { return await startImpl(this); }

  /** Polls chats with an active or opening terminal link. */
  async syncTerminalPolling(): Promise<void> {
    const needsPolling = (await this.store.list()).some((chat) => chat.terminalSince !== undefined || this.entryOf(chat.id)?.[1].aliases.tmux != null);
    if (needsPolling && this.terminalTimer === undefined && !this.closed) {
      const poll = timeoutMs(this.environment.MEGABRAIN_CHAT_TERMINAL_POLL_MS, DEFAULT_TERMINAL_POLL_MS);
      let refreshing = false;
      let refreshPending = false;
      const refresh = () => {
        if (this.closed) return;
        if (refreshing) { refreshPending = true; return; }
        refreshing = true;
        const task = this.refreshTerminalChats().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (this.terminalRefreshError !== message) process.stderr.write(`chat terminal refresh failed: ${message}\n`);
          this.terminalRefreshError = message;
        }).finally(() => {
          refreshing = false;
          if (refreshPending && !this.closed) { refreshPending = false; refresh(); }
        });
        this.terminalRefresh = task;
      };
      this.terminalTimer = setInterval(refresh, poll);
      this.terminalTimer.unref?.();
    } else if (!needsPolling && this.terminalTimer !== undefined) {
      clearInterval(this.terminalTimer);
      this.terminalTimer = undefined;
    }
  }

  /**
   * The knowledge base reads sessions from outside the app too. A minute after start the summaries already on disk are curated once
   * (a rerun skips what is done), then new sessions are scanned every ten minutes. Both are read-only on the agents' logs and
   * skip any project whose toggles are off. MEGABRAIN_KNOWLEDGE_SCANNER=off disables the loop.
   */
  startKnowledge(): void {
    startKnowledge(this);
  }

  /** The messages a drained predecessor took but left unsent go out now, one per chat, as that chat's next turn. */
async resumeDrained(): Promise<void> { return await resumeDrainedImpl(this); }

async handle(request: Request, socket?: Socket): Promise<unknown> { return await handleImpl(this, request, socket); }

async startChat(request: Request): Promise<Chat> { return await startChatImpl(this, request); }

  /**
   * Every chat whose agent process is gone becomes suspended: the record, its session id and its transcript stay,
   * and the next send respawns the agent with resume. A turn that was cut is marked interrupted. Also kills the
   * children this daemon still owns, which is how a handover leaves nothing running.
   */
async suspendActive(): Promise<string[]> { return await suspendActiveImpl(this); }

  /** Waits (bounded) for working chats to finish, suspends the rest, then leaves so a newer chatd can take the socket. */
async handover(): Promise<{ handedOver: true; waitedMs: number; interrupted: string[] }> { return await handoverImpl(this); }

  /** Whether one of this daemon's agents is in a turn; a terminal's TUI does not depend on chatd. */
async busy(): Promise<boolean> { return await busyImpl(this); }

async liveChats(): Promise<number> { return await liveChatsImpl(this); }

async daemonStatus(): Promise<{ pid: number; protocol: { version: number; min: number; max: number }; daemonVersion: string; superseded: boolean; liveChats: number; build: number; draining: boolean; working: string[]; terminalRefreshError?: string }> { return await daemonStatusImpl(this); }

  /**
   * Gets out of the way of a newer chatd without stopping anyone's turn: every running turn finishes (however long
   * it takes), no new turn starts, the queued messages are left for the successor, and then the daemon exits.
   */
async drainDaemon(): Promise<{ drained: true; waitedMs: number; resumes: string[] }> { return await drainDaemonImpl(this); }

async retireDaemon(): Promise<{ retired: true; waitedMs: number }> { return await retireDaemonImpl(this); }

  /** A send while a turn runs waits in the queue; otherwise it goes out at once. While draining every send waits, for the next daemon. */
async send(id: string, inputParts: Part[], fresh = false): Promise<{ queued: QueuedChatMessage | null }> {
  if (this.chatMutations.has(id)) throw new ChatHandoffError("chat-busy", "chat is being edited or forked");
  return await sendImpl(this, id, inputParts, fresh);
}

  /** Retries a refused resume after the holder is gone, without replaying the message already shown in the transcript. */
async resume(id: string): Promise<Chat> { return await resumeImpl(this, id); }

  /** Shows the message and makes it the next turn: resuming the agent, starting it, or writing to it once it is free. */
async deliver(chat: Chat, parts: Part[], options: { fresh?: boolean; keepInterrupt?: boolean } = {}): Promise<void> { return await deliverImpl(this, chat, parts, options); }

async queueOperation(request: Request): Promise<unknown> { return await queueOperationImpl(this, request); }

async loadQueue(id: string): Promise<QueuedChatMessage[]> { return await loadQueueImpl(this, id); }

  /** Tells followers the queue as it is now, then writes it; writes go in order, so the file ends as the last change left it. */
async persistQueue(id: string): Promise<QueuedChatMessage[]> { return await persistQueueImpl(this, id); }

async enqueue(chat: Chat, parts: Part[]): Promise<QueuedChatMessage> { return await enqueueImpl(this, chat, parts); }

  /** A holder refusal keeps the pending message for Retry; other failed resumes drop it as before. */
async resumeFailed(id: string, error: unknown): Promise<void> { return await resumeFailedImpl(this, id, error); }

trackCallback(task: Promise<unknown>): void { return trackCallbackImpl(this, task); }

  /** `checked`: the caller already made sure nothing else holds the session (a switch back from the terminal ends the TUIs itself). */
runAgent(chat: Chat, checked = false): Promise<void> { return runAgentImpl(this, chat, checked); }

async runAgentInternal(chat: Chat, checked = false): Promise<void> { return await runAgentInternalImpl(this, chat, checked); }

  /** Closes every app TUI for this chat before resume; a live turn gets to finish first. */
async clearTerminalHoldersBeforeResume(chat: Chat): Promise<void> { return await clearTerminalHoldersBeforeResumeImpl(this, chat); }

async handleClaudeStream(id: string, streamEvent: Record<string, unknown>): Promise<void> { return await handleClaudeStreamImpl(this, id, streamEvent); }
async publishTurnCut(chat: Chat, reason: NonNullable<ChatEvent["reason"]>, detail?: string): Promise<void> { return await publishTurnCutImpl(this, chat, reason, detail); }
async publishBackgroundTask(chat: Chat, task: import("./store.js").BackgroundTask): Promise<void> { return await publishBackgroundTaskImpl(this, chat, task); }

async publishToolCall(id: string, toolUseId: string, name: string, input: string, extra: Partial<ChatEvent> = {}): Promise<void> { return await publishToolCallImpl(this, id, toolUseId, name, input, extra); }

  /** A subagent's start is the call that started it, carrying who it is; its steps then carry its id as parentId. */
async startSubagent(chat: Chat, subagent: Subagent, name: string, input: string): Promise<void> { return await startSubagentImpl(this, chat, subagent, name, input); }

  /** Ends a subagent once, whichever of the agent's reports of it arrives first. */
async endSubagent(chat: Chat, end: SubagentEnd): Promise<void> { return await endSubagentImpl(this, chat, end); }

  /** A step a Claude subagent took: its message, or the results of its tool calls, never the prompt it was given. */
async publishClaudeStep(chat: Chat, parentId: string, item: Record<string, unknown>): Promise<void> { return await publishClaudeStepImpl(this, chat, parentId, item); }

async handleClaude(id: string, child: ChildProcessWithoutNullStreams, item: Record<string, unknown>): Promise<void> { return await handleClaudeImpl(this, id, child, item); }

settleRpc(id: string, item: Record<string, unknown>): boolean { return settleRpcImpl(this, id, item); }

async handleCodex(id: string, child: ChildProcessWithoutNullStreams, item: Record<string, unknown>): Promise<void> { return await handleCodexImpl(this, id, child, item); }

async handleCodexSubagent(chat: Chat, thread: string, method: string, params: Record<string, unknown>): Promise<void> { return await handleCodexSubagentImpl(this, chat, thread, method, params); }

async handleGrok(id: string, frame: import("./grok-acp.js").Frame): Promise<void> { return await handleGrokImpl(this, id, frame); }
async handleGrokRequest(id: string, frame: import("./grok-acp.js").Frame, peer: AcpPeer): Promise<void> { return await handleGrokRequestImpl(this, id, frame, peer); }
async finishGrokTurn(id: string, result: unknown, error?: Error): Promise<void> { return await finishGrokTurnImpl(this, id, result, error); }

  readonly rpcWaiters = new Map<string, Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>>();
  readonly acpPeers = new Map<string, AcpPeer>();
  readonly pendingRpcApproval = new Map<string, string>();
  rpcSequence = 1;
async codexRequest(child: ChildProcessWithoutNullStreams, method: string, params: Record<string, unknown>): Promise<unknown> { return await codexRequestImpl(this, child, method, params); }

  /** Starts the next turn when the agent is free; drains run one at a time per chat, so two callers never send twice. */
drain(id: string): Promise<void> { return drainImpl(this, id); }

async drainOnce(id: string): Promise<void> { return await drainOnceImpl(this, id); }

  // Claude prints nothing until it reads input; if it still says nothing after the first write, the chat is stuck.
armStartTimer(id: string, child: ChildProcessWithoutNullStreams): void { return armStartTimerImpl(this, id, child); }

clearStartTimer(id: string): void { return clearStartTimerImpl(this, id); }

async interrupt(id: string): Promise<void> { return await interruptImpl(this, id); }

async stop(id: string): Promise<void> { return await stopImpl(this, id); }

  /** A person's rename: the title is theirs from now on and automatic titles stop for this chat. */
async rename(id: string, title: string): Promise<Chat> { return await renameImpl(this, id, title); }

  /** Stops the agent and deletes the chat's record and events; the agent's own session log stays resumable. */
async remove(id: string): Promise<{ removed: string }> { return await removeImpl(this, id); }

async mode(id: string, mode: string): Promise<{ chat: Chat; terminal: null; command: string[] | null; env: Record<string, string> }> { return await modeImpl(this, id, mode); }

async takeOver(id: string): Promise<Chat> { return await takeOverImpl(this, id); }

  /** Turns typed in the terminal live only in the agent's log; they join the chat, once each, before the agent respawns. */
async importTerminalTurns(chat: Chat, markInterrupted = true): Promise<void> {
  const previous = this.terminalImportChains.get(chat.id) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => importTerminalTurnsImpl(this, chat, markInterrupted));
  this.terminalImportChains.set(chat.id, task);
  try { await task; } finally { if (this.terminalImportChains.get(chat.id) === task) this.terminalImportChains.delete(chat.id); }
}

async logTurnOpen(chat: Chat): Promise<boolean> { return await logTurnOpenImpl(this, chat); }

  /** Every process holding the chat's session other than this daemon's own agents. */
  async foreignHolders(chat: Chat, panes?: ReadonlyMap<number, string>, exclude?: ReadonlySet<number>): Promise<SessionHolder[]> { return await foreignHoldersImpl(this, chat, panes, exclude); }

  /** The pane processes of one session on the app's tmux server, as pane pid to session name. */
async panesOf(session: string): Promise<ReadonlyMap<number, string>> { return await panesOfImpl(this, session); }

  /**
   * Ends the chat's own terminal and any other session megabrain runs on the app's tmux server that resumes the chat's
   * session. Returns the pids of the holders it ended, which may take a moment more to exit.
   */
async endAppTerminals(chat: Chat): Promise<ReadonlySet<number>> { return await endAppTerminalsImpl(this, chat); }

  /** A terminal-mode chat shows its TUI's state: working while the session log holds an unfinished turn and a process still runs it. */
async refreshTerminalChats(): Promise<void> {
  if (this.terminalRefreshTask !== undefined) return await this.terminalRefreshTask;
  const task = refreshTerminalChatsImpl(this);
  this.terminalRefreshTask = task;
  try { await task; } finally { if (this.terminalRefreshTask === task) this.terminalRefreshTask = undefined; }
}

async terminalCommand(id: string): Promise<AgentTerminalCommand> { return await terminalCommandImpl(this, id); }

async fork(id: string, eventId: string): Promise<Chat> { return await forkImpl(this, id, eventId); }

async editLast(id: string, parts: unknown): Promise<Chat> { return await editLastImpl(this, id, parts); }

updateContext(chat: Chat, usage: Record<string, unknown>): void { return updateContextImpl(this, chat, usage); }

async setModel(id: string, model: string, effort: string | null): Promise<Chat> { return await setModelImpl(this, id, model, effort); }

async startArtifactWatch(chat: Chat): Promise<void> { return await startArtifactWatchImpl(this, chat); }

stopArtifactWatch(id: string): void { return stopArtifactWatchImpl(this, id); }

async replaceArtifactSnapshot(chat: Chat, watch: ArtifactWatch, artifacts: ChatArtifact[]): Promise<void> { return await replaceArtifactSnapshotImpl(this, chat, watch, artifacts); }

async refreshClaudeArtifacts(chat: Chat): Promise<void> { return await refreshClaudeArtifactsImpl(this, chat); }

async checkArtifactWatch(chat: Chat): Promise<void> { return await checkArtifactWatchImpl(this, chat); }

async events(id: string, since: number, follow: boolean, socket?: Socket): Promise<ChatLine[]> { return await eventsImpl(this, id, since, follow, socket); }

async permission(id: string, request: Record<string, unknown>): Promise<unknown> { return await permissionImpl(this, id, request); }

async createApproval(chat: Chat, tool: string, input: string, reason: string): Promise<ChatApproval> { return await createApprovalImpl(this, chat, tool, input, reason); }

async approve(id: string, approvalId: string, decision: string): Promise<void> { return await approveImpl(this, id, approvalId, decision); }

async resolveApproval(id: string, requestId: number, response: unknown): Promise<void> { return await resolveApprovalImpl(this, id, requestId, response); }

async requireChat(id: string): Promise<Chat> { return await requireChatImpl(this, id); }
async normalizeParts(cwd: string, parts: Part[]): Promise<Part[]> { return await normalizePartsImpl(this, cwd, parts); }

processes(): ProcessAdapter { return processesImpl(this); }

  /** The conversation entry that belongs to this chat, wherever it is keyed. */
entryOf(chatId: string): [string, Conversation] | undefined { return entryOfImpl(this, chatId); }

  /** A chat with a turn is one conversation in the registry: keyed by its chat until the agent reports its session, then by the session. */
track(chat: Chat): void { return trackImpl(this, chat); }

  /** Removing a chat also ends the app terminal its terminal mode left on the app's tmux server, and drops its entry. */
async dropConversation(chatId: string): Promise<void> { return await dropConversationImpl(this, chatId); }

  /** Chats that never had a turn are placeholders: nothing the person made, so a restart collects them. */
async pruneUnused(): Promise<void> { return await pruneUnusedImpl(this); }

  /** The session of the TUI running in this chat's own pane; no pane, no answer. */
async sessionOfTerminal(chat: Chat): Promise<string | null> { return await sessionOfTerminalImpl(this, chat); }
  /** Persists the chat and, when its state moved, publishes the new state to followers and history. */
async save(chat: Chat): Promise<void> { return await saveImpl(this, chat); }
stateEvent(chat: Chat): ChatEvent { return stateEventImpl(this, chat); }
  /** Sends an event to current followers only; the cursor is the last stored one, so a resume never skips history. */
publishLive(id: string, value: ChatEvent): void { return publishLiveImpl(this, id, value); }
publishProgress(id: string, progress: ChatProgress): void { return publishProgressImpl(this, id, progress); }
  /** Moves a Claude turn's token count and, unless told not to, tells followers the new total. */
countClaude(id: string, change: (tokens: { done: number; thinking: number; textChars: number }) => { done: number; thinking: number; textChars: number }, publish = true): void { return countClaudeImpl(this, id, change, publish); }
broadcast(id: string, line: ChatLine): void { return broadcastImpl(this, id, line); }
async publish(chat: Chat, value: ChatEvent, approval?: ChatApproval): Promise<void> { return await publishImpl(this, chat, value, approval); }
async publishInterrupted(chat: Chat): Promise<void> { return await publishInterruptedImpl(this, chat); }
async fail(id: string, error: unknown): Promise<void> { return await failImpl(this, id, error); }
scheduleExit(): void { return scheduleExitImpl(this); }
close(): Promise<void> { return closeImpl(this); }
async closeDaemon(): Promise<void> { return await closeDaemonImpl(this); }
  server: ReturnType<typeof createServer> | undefined;
async listen(): Promise<void> { return await listenImpl(this); }
}

export { runChatd, callChatd, chatdStatus, drainChatd, retireChatd, callPermissionServer } from "./daemon/client.js";
export type { ChatdStatus } from "./daemon/client.js";
