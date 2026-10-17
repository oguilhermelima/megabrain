import { scrubAgentEnvironment } from "../core/agent-env.js";
import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createProcessAdapter, type ProcessAdapter } from "../adapters/proc.js";
import { chatKey, promoteConversation, readConversations, removeConversation, sessionKey, setConversationAlias, upsertConversation, type Conversation } from "../core/conversations.js";
import { OWNED_TMUX_SERVER, ownedTmuxProcess, readOwnedSessions, writeOwnedSessions } from "../core/session-ownership.js";
import { liveSessionHolders, type SessionHolder } from "../core/session-holders.js";
import { APP_SESSION_PREFIX, forgetAppTerminal } from "../core/app-terminals.js";
import { chmod, mkdir, open, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ChatStore, type Chat, type ChatApproval, type ChatEvent, type ChatLine, type ChatProgress, type QueuedChatMessage } from "./store.js";
import { chatProtocolAdapters, type MessagePart } from "./protocol.js";
import { discoverSessionId, readSessionTurns, sessionLogPath, sessionTurnOpen } from "./session-log.js";
import { claudeHandBack, claudeNotified, claudeSubagent, codexEnded, codexSpawned, isClaudeSubagentTool, type Subagent, type SubagentEnd } from "./subagents.js";
import { selfInvocation } from "../core/self-invocation.js";
import { backfillSummaries } from "../knowledge/backfill.js";
import { repairKnowledgeRefs } from "../knowledge/repair-refs.js";
import { KnowledgePipeline } from "../knowledge/pipeline.js";
import { scanProjects } from "../knowledge/scanner.js";
import { ChatSummarizer } from "./summaries.js";
import { chatArtifactFileFingerprint, chatArtifactSignature, chatArtifactStoreFingerprint, listChatArtifacts, listClaudeChatArtifacts, listMegabrainChatArtifacts, type ChatArtifact } from "./artifacts.js";

type Part = MessagePart;
type Request = { operation: string; [key: string]: unknown };
type Response = { ok: true; value?: unknown } | { ok: false; error: string; code?: number };
type Environment = Readonly<Record<string, string | undefined>>;
const instances = new Map<string, ChatDaemon>();

// macOS limits Unix socket paths to a small fixed buffer; state directories under its long
// per-user temporary root need a short basename while remaining scoped to the state directory.
function chatSocket(stateDir: string): string { return join(stateDir, "chatd", "s"); }
function chatPid(stateDir: string): string { return join(stateDir, "chatd", "chatd.pid"); }
function chatLock(stateDir: string): string { return join(stateDir, "chatd", "start.lock"); }
/** Chats whose queued messages a drained chatd left for its successor to send. */
function chatResumes(stateDir: string): string { return join(stateDir, "chatd", "resume.json"); }
/** Bumped whenever the socket contract changes in a way an older chatd cannot serve; a client that finds another number asks that chatd to hand over. */
export const CHAT_PROTOCOL_VERSION = 2;
const DRAINING = "chatd is draining for an upgrade";
const DEFAULT_TERMINAL_POLL_MS = 1500;

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
function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
async function filePid(path: string): Promise<number> {
  try { return Number((await readFile(path, "utf8")).trim()); } catch { return 0; }
}
/** A dead chatd leaves its socket file behind; only a refused or missing socket counts as stale, a slow one is alive. */
async function socketAccepts(stateDir: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(chatSocket(stateDir));
    const timer = setTimeout(() => { socket.destroy(); resolve(true); }, timeout);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code !== "ECONNREFUSED" && error.code !== "ENOENT" && error.code !== "ENOTSOCK"); });
  });
}
async function discardStaleState(stateDir: string, options: { pid: boolean }): Promise<void> {
  try { await unlink(chatSocket(stateDir)); } catch { /* no stale socket */ }
  if (options.pid) { try { await unlink(chatPid(stateDir)); } catch { /* no stale pid */ } }
}
function heldMessage(chat: Chat, holders: readonly SessionHolder[]): string {
  const where = holders.map((holder) => holder.tmuxSession === null ? `pid ${holder.pid}` : `tmux session ${holder.tmuxSession}, pid ${holder.pid}`).join("; ");
  return `${chat.agent} session ${chat.agentSessionId ?? ""} is already open in another process (${where}); close it there, or start fresh`;
}
/** Stops an agent this daemon ran and waits (bounded) until it is gone, so nothing checks for holders while it still runs. */
async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
  child.kill("SIGTERM");
  await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 2000).unref?.())]);
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
export class ChatDaemon {
  readonly store: ChatStore;
  private readonly summarizer: ChatSummarizer;
  private readonly knowledge: KnowledgePipeline;
  private scanning = false;
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  /** Messages already sent that wait for the agent to be ready: the first message of a start or a resume, or one sent now. */
  private readonly queues = new Map<string, Part[][]>();
  /** The person's queue: messages sent during a turn, persisted, drained one per turn. Loaded once per chat. */
  private readonly queued = new Map<string, QueuedChatMessage[]>();
  private readonly queueWrites = new Map<string, Promise<unknown>>();
  /** An interrupt holds the queue until the person sends again, so stopping a turn never fires a queued message. */
  private readonly queueHeld = new Set<string>();
  private readonly drainChains = new Map<string, Promise<unknown>>();
  private readonly activeTurns = new Map<string, string>();
  private readonly interrupting = new Set<string>();
  private readonly interruptedEvents = new Set<string>();
  private readonly pendingApprovals = new Map<string, { approval: ChatApproval; resolve: (decision: string) => void }>();
  private readonly subscribers = new Map<string, Set<(line: ChatLine, live?: boolean) => void>>();
  private readonly artifactWatches = new Map<string, ArtifactWatch>();
  private readonly eventChains = new Map<string, Promise<void>>();
  private readonly startTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly outputSeen = new Set<string>();
  private readonly appendChains = new Map<string, Promise<unknown>>();
  private readonly publishedState = new Map<string, Chat["state"]>();
  private readonly turnStarted = new Map<string, string>();
  private readonly currentMessage = new Map<string, string>();
  /**
   * A Claude turn's output tokens: the exact count of its finished messages, and the current message's estimate
   * from Claude's own thinking estimate plus its text so far at four characters a token.
   */
  private readonly claudeTokens = new Map<string, { done: number; thinking: number; textChars: number }>();
  /** A Codex turn counts from the thread's output tokens before it, which a resumed thread carries from earlier turns. */
  private readonly codexTokenBase = new Map<string, number>();
  private readonly toolNames = new Map<string, Map<string, string>>();
  /** Each chat's subagents by id: the tool that started one, whether it runs in the background, whether it ended. */
  private readonly subagents = new Map<string, Map<string, { name: string; background: boolean; ended: boolean }>>();
  /** Removed chats: late agent output must not write their record back. */
  private readonly removed = new Set<string>();
  /** The registry key each chat was last written under, so a save only touches the file when the key changes. */
  private readonly tracked = new Map<string, string>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set by a drain: running turns finish, no new one starts, and the queue waits for the next daemon. */
  private draining = false;
  private readonly resumeOnStart = new Set<string>();
  private terminalTimer: ReturnType<typeof setInterval> | undefined;
  /** Each terminal-mode chat's log as last read (size and mtime), so an unchanged idle log is not parsed again. */
  private readonly terminalLogs = new Map<string, string>();
  private clients = 0;
  private closed = false;
  private readonly sockets = new Set<Socket>();
  constructor(readonly stateDir: string, readonly environment: Environment = process.env, readonly protocol: number = CHAT_PROTOCOL_VERSION, readonly build: number = chatBuild()) { this.store = new ChatStore(stateDir); this.knowledge = new KnowledgePipeline({ stateDir, environment }); this.summarizer = new ChatSummarizer({ store: this.store, stateDir, environment, pipeline: this.knowledge, emit: (chat, value) => this.publish(chat, value), alive: (id) => !this.removed.has(id) }); }

  async start(): Promise<void> {
    const dir = join(this.stateDir, "chatd");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    if (await socketAccepts(this.stateDir, DEFAULT_CONNECT_TIMEOUT_MS)) throw new Error("chatd is already running");
    await discardStaleState(this.stateDir, { pid: true });
    await this.store.initialize();
    // The one-time registry migration runs here, before anything is live, so it can never collect a chat chatd is using.
    try { readConversations(this.stateDir); } catch { /* a locked registry is retried by the next write */ }
    await this.pruneUnused();
    await this.suspendActive();
    await writeFile(chatPid(this.stateDir), `${process.pid}\n`, { mode: 0o600 });
    await chmod(chatPid(this.stateDir), 0o600);
    await this.resumeDrained();
    this.startKnowledge();
  }

  /**
   * The knowledge base reads sessions from outside the app too. A minute after start the summaries already on disk are curated once
   * (a rerun skips what is done), then new sessions are scanned every ten minutes. Both are read-only on the agents' logs and
   * skip any project whose toggles are off. MEGABRAIN_KNOWLEDGE_SCANNER=off disables the loop.
   */
  private startKnowledge(): void {
    if (this.environment.MEGABRAIN_KNOWLEDGE_SCANNER === "off") return;
    const pass = async (backfill: boolean): Promise<void> => {
      if (this.scanning || this.draining) return;
      this.scanning = true;
      try {
        if (backfill) {
          await repairKnowledgeRefs({ stateDir: this.stateDir, once: true });
          await backfillSummaries({ stateDir: this.stateDir, pipeline: this.knowledge });
        }
        await scanProjects({ stateDir: this.stateDir, home: this.environment.HOME ?? process.env.HOME ?? "", environment: this.environment, pipeline: this.knowledge });
      } catch (error) { process.stderr.write(`knowledge scan failed: ${error instanceof Error ? error.message : String(error)}\n`); }
      finally { this.scanning = false; }
    };
    setTimeout(() => { void pass(true); }, 60_000).unref();
    setInterval(() => { void pass(false); }, 10 * 60_000).unref();
  }

  /** The messages a drained predecessor took but left unsent go out now, one per chat, as that chat's next turn. */
  private async resumeDrained(): Promise<void> {
    let ids: unknown;
    try { ids = JSON.parse(await readFile(chatResumes(this.stateDir), "utf8")); } catch { return; }
    try { await unlink(chatResumes(this.stateDir)); } catch { /* already taken */ }
    for (const id of Array.isArray(ids) ? ids.filter((value): value is string => typeof value === "string") : []) {
      const chat = await this.store.get(id);
      if (!chat || chat.mode !== "chat") continue;
      const items = await this.loadQueue(id);
      const item = items.shift();
      if (item === undefined) continue;
      await this.persistQueue(id);
      await this.deliver(chat, item.parts);
    }
  }

  async handle(request: Request, socket?: Socket): Promise<unknown> {
    this.clients += 1;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    try {
      switch (request.operation) {
        case "list":
          await Promise.all([...this.eventChains.values(), ...this.appendChains.values()]);
          return await this.store.list();
        case "hello": return { protocol: this.protocol, pid: process.pid, build: this.build };
        case "daemon-status": return await this.daemonStatus();
        case "drain": return request.wait === false ? (void this.drainDaemon().catch(() => undefined), await this.daemonStatus()) : await this.drainDaemon();
        case "handover": return await this.handover();
        case "start": return await this.startChat(request);
        case "send": return await this.send(text(request.id), validateParts(request.parts), request.fresh === true);
        case "queue": return await this.queueOperation(request);
        case "interrupt": return await this.interrupt(text(request.id));
        case "stop": return await this.stop(text(request.id));
        case "remove": return await this.remove(text(request.id));
        case "approve": return await this.approve(text(request.id), text(request.approvalId), text(request.decision));
        case "events": return await this.events(text(request.id), Number(request.since ?? 0), request.follow === true, socket);
        case "mode": return await this.mode(text(request.id), text(request.mode));
        case "model": return await this.setModel(text(request.id), text(request.model), text(request.effort) || null);
        case "rename": return await this.rename(text(request.id), text(request.title));
        case "summarize": return await this.summarizer.summarize(text(request.id));
        case "terminal-command": return await this.terminalCommand(text(request.id));
        case "permission": return await this.permission(text(request.id), object(request.request));
        default: throw new Error("unknown chat operation");
      }
    } finally {
      this.clients -= 1;
      this.scheduleExit();
    }
  }

  private async startChat(request: Request): Promise<Chat> {
    if (this.draining) throw new Error(DRAINING);
    const agent = text(request.agent);
    if (agent !== "claude" && agent !== "codex") throw new Error("--agent must be claude or codex");
    const cwd = text(request.cwd);
    if (!cwd || !cwd.startsWith("/")) throw new Error("--cwd must be an absolute path");
    const parts = request.parts === undefined ? [] : await this.normalizeParts(cwd, validateParts(request.parts));
    const now = new Date().toISOString();
    const chat: Chat = {
      id: randomUUID(), agent, cwd, model: text(request.model) || null, ...(text(request.effort) ? { effort: text(request.effort) } : {}), ...(request.approvals === true ? { approvals: true } : {}),
      title: firstText(parts).slice(0, 120) || null, titleSource: "first-message", summary: null, state: "starting", mode: "chat",
      agentSessionId: null, createdAt: now, lastActivityAt: now, error: null,
    };
    await this.save(chat);
    await this.publish(chat, event("system", `Started ${agent} chat`));
    const queue = this.queues.get(chat.id) ?? [];
    if (parts.length > 0) { queue.push(parts); this.queues.set(chat.id, queue); await this.publish(chat, event("user", firstText(parts), undefined, withImages(parts))); }
    void this.runAgent(chat).catch((error: unknown) => this.fail(chat.id, error));
    return chat;
  }

  /**
   * Every chat whose agent process is gone becomes suspended: the record, its session id and its transcript stay,
   * and the next send respawns the agent with resume. A turn that was cut is marked interrupted. Also kills the
   * children this daemon still owns, which is how a handover leaves nothing running.
   */
  private async suspendActive(): Promise<string[]> {
    const interrupted: string[] = [];
    for (const chat of await this.store.list()) {
      if (chat.state === "suspended" || chat.state === "error" || chat.mode === "terminal") continue;
      const child = this.children.get(chat.id);
      if (child) { this.children.delete(chat.id); child.kill("SIGTERM"); }
      this.clearStartTimer(chat.id);
      for (const map of [this.queues, this.activeTurns]) map.delete(chat.id);
      if (chat.state === "working" || chat.state === "waiting-approval") {
        interrupted.push(chat.id);
        await this.publish(chat, event("system", "Interrupted"));
      }
      chat.state = "suspended";
      chat.error = null;
      await this.save(chat);
    }
    return interrupted;
  }

  /** Waits (bounded) for working chats to finish, suspends the rest, then leaves so a newer chatd can take the socket. */
  private async handover(): Promise<{ handedOver: true; waitedMs: number; interrupted: string[] }> {
    const bound = timeoutMs(this.environment.MEGABRAIN_CHATD_HANDOVER_TIMEOUT_MS, DEFAULT_HANDOVER_TIMEOUT_MS);
    const started = Date.now();
    while (await this.busy() && Date.now() - started < bound) await new Promise((resolve) => setTimeout(resolve, 50));
    const interrupted = await this.suspendActive();
    await Promise.all([...this.eventChains.values(), ...this.appendChains.values()]);
    await this.close();
    return { handedOver: true, waitedMs: Date.now() - started, interrupted };
  }

  /** Whether one of this daemon's agents is in a turn; a terminal's TUI does not depend on chatd. */
  private async busy(): Promise<boolean> {
    return (await this.store.list()).some((chat) => chat.mode === "chat" && (chat.state === "working" || chat.state === "waiting-approval"));
  }

  private async daemonStatus(): Promise<{ pid: number; protocol: number; build: number; draining: boolean; working: string[] }> {
    const working = (await this.store.list()).filter((chat) => chat.mode === "chat" && (chat.state === "working" || chat.state === "waiting-approval")).map((chat) => chat.id);
    return { pid: process.pid, protocol: this.protocol, build: this.build, draining: this.draining, working };
  }

  /**
   * Gets out of the way of a newer chatd without stopping anyone's turn: every running turn finishes (however long
   * it takes), no new turn starts, the queued messages are left for the successor, and then the daemon exits.
   */
  private async drainDaemon(): Promise<{ drained: true; waitedMs: number; resumes: string[] }> {
    this.draining = true;
    const started = Date.now();
    while (await this.busy()) await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all([...this.eventChains.values(), ...this.appendChains.values(), ...this.queueWrites.values()]);
    for (const chat of await this.store.list()) if (chat.mode === "chat" && (await this.loadQueue(chat.id)).length > 0) this.resumeOnStart.add(chat.id);
    const resumes = [...this.resumeOnStart];
    if (resumes.length > 0) await writeFile(chatResumes(this.stateDir), `${JSON.stringify(resumes)}\n`, { mode: 0o600 });
    await this.suspendActive();
    await Promise.all([...this.eventChains.values(), ...this.appendChains.values()]);
    await this.close();
    return { drained: true, waitedMs: Date.now() - started, resumes };
  }

  /** A send while a turn runs waits in the queue; otherwise it goes out at once. While draining every send waits, for the next daemon. */
  private async send(id: string, inputParts: Part[], fresh = false): Promise<{ queued: QueuedChatMessage | null }> {
    const chat = await this.requireChat(id);
    const parts = await this.normalizeParts(chat.cwd, inputParts);
    if (chat.mode !== "chat") throw new Error("chat is in terminal mode");
    if (this.draining) { this.resumeOnStart.add(id); return { queued: await this.enqueue(chat, parts) }; }
    if (chat.state === "working" || chat.state === "waiting-approval") return { queued: await this.enqueue(chat, parts) };
    await this.deliver(chat, parts, { fresh });
    return { queued: null };
  }

  /** Shows the message and makes it the next turn: resuming the agent, starting it, or writing to it once it is free. */
  private async deliver(chat: Chat, parts: Part[], options: { fresh?: boolean; keepInterrupt?: boolean } = {}): Promise<void> {
    const id = chat.id;
    const resuming = chat.state === "suspended" || chat.state === "stopped";
    const textValue = firstText(parts);
    if (chat.title === null && textValue !== "") chat.title = textValue.slice(0, 120);
    chat.lastActivityAt = new Date().toISOString();
    await this.save(chat);
    await this.publish(chat, event("user", textValue, undefined, withImages(parts)));
    if (options.keepInterrupt !== true) this.interrupting.delete(id);
    this.interruptedEvents.delete(id);
    if (resuming) {
      // The first send is the trigger: opening a chat spawns nothing, so a person browsing history costs no agent process.
      if (options.fresh === true) chat.agentSessionId = null;
      chat.state = "starting";
      chat.error = null;
      this.queues.set(id, [parts]);
      await this.save(chat);
      void this.runAgent(chat).catch((error) => this.resumeFailed(id, error));
      return;
    }
    const queue = this.queues.get(id) ?? [];
    queue.push(parts);
    this.queues.set(id, queue);
    if (!this.children.has(id) && chat.state === "idle") {
      chat.state = "starting";
      await this.save(chat);
      void this.runAgent(chat).catch((error) => this.fail(id, error));
      return;
    }
    await this.drain(id);
  }

  private async queueOperation(request: Request): Promise<unknown> {
    const id = text(request.id);
    const chat = await this.requireChat(id);
    const action = text(request.action);
    const items = await this.loadQueue(id);
    const take = (): QueuedChatMessage => {
      const index = items.findIndex((item) => item.id === text(request.itemId));
      if (index === -1) throw new Error(`message ${text(request.itemId) || "(none)"} is not in the queue`);
      return items.splice(index, 1)[0] as QueuedChatMessage;
    };
    switch (action) {
      case "list": return [...items];
      case "add":
        await this.enqueue(chat, await this.normalizeParts(chat.cwd, validateParts(request.parts)));
        await this.drain(id);
        return [...await this.loadQueue(id)];
      case "edit": {
        // The person's rule: an edited message goes to the end of the queue.
        const parts = await this.normalizeParts(chat.cwd, validateParts(request.parts));
        const item = take();
        items.push({ ...item, parts, updatedAt: new Date().toISOString() });
        return await this.persistQueue(id);
      }
      case "move": {
        const to = request.to;
        if (typeof to !== "number" || !Number.isSafeInteger(to) || to < 0) throw new Error("--to must be a non-negative index");
        const item = take();
        items.splice(Math.min(to, items.length), 0, item);
        return await this.persistQueue(id);
      }
      case "remove":
        take();
        return await this.persistQueue(id);
      case "clear":
        items.splice(0);
        return await this.persistQueue(id);
      case "send-now": {
        if (chat.mode !== "chat") throw new Error("chat is in terminal mode");
        if (this.draining) throw new Error(DRAINING);
        const item = take();
        await this.persistQueue(id);
        if (chat.state === "working" || chat.state === "waiting-approval") await this.interrupt(id);
        await this.deliver(await this.requireChat(id), item.parts, { keepInterrupt: true });
        return [...await this.loadQueue(id)];
      }
      case "steer": {
        const child = this.children.get(id);
        const turnId = this.activeTurns.get(id);
        if (chat.agent !== "codex" || chat.state !== "working" || child === undefined || turnId === undefined) throw new Error("steer needs a running Codex turn");
        const index = items.findIndex((item) => item.id === text(request.itemId));
        const item = items[index];
        if (item === undefined) throw new Error(`message ${text(request.itemId) || "(none)"} is not in the queue`);
        await chatProtocolAdapters.codex.steer(chat, child, turnId, item.parts, (method, params) => this.codexRequest(child, method, params));
        const at = items.indexOf(item);
        if (at !== -1) items.splice(at, 1);
        await this.persistQueue(id);
        await this.publish(chat, event("user", firstText(item.parts), undefined, withImages(item.parts)));
        return [...items];
      }
      default: throw new Error("queue action must be list, add, edit, move, remove, clear, send-now or steer");
    }
  }

  private async loadQueue(id: string): Promise<QueuedChatMessage[]> {
    const cached = this.queued.get(id);
    if (cached !== undefined) return cached;
    const items = await this.store.queue(id);
    const raced = this.queued.get(id);
    if (raced !== undefined) return raced;
    this.queued.set(id, items);
    return items;
  }

  /** Tells followers the queue as it is now, then writes it; writes go in order, so the file ends as the last change left it. */
  private async persistQueue(id: string): Promise<QueuedChatMessage[]> {
    const items = [...this.queued.get(id) ?? []];
    this.broadcast(id, { cursor: "", queue: items });
    const next = (this.queueWrites.get(id) ?? Promise.resolve()).then(() => this.removed.has(id) ? undefined : this.store.putQueue(id, items));
    this.queueWrites.set(id, next.catch(() => undefined));
    await next;
    return items;
  }

  private async enqueue(chat: Chat, parts: Part[]): Promise<QueuedChatMessage> {
    const items = await this.loadQueue(chat.id);
    const now = new Date().toISOString();
    const item: QueuedChatMessage = { id: randomUUID(), parts: [...parts], createdAt: now, updatedAt: now };
    items.push(item);
    await this.persistQueue(chat.id);
    return item;
  }

  /** A resume that cannot start leaves the chat suspended with the reason, and drops the message it carried. */
  private async resumeFailed(id: string, error: unknown): Promise<void> {
    const child = this.children.get(id);
    if (child) { this.children.delete(id); child.kill("SIGTERM"); }
    this.clearStartTimer(id);
    this.queues.delete(id);
    const chat = await this.store.get(id);
    if (!chat || chat.state === "suspended" && chat.error !== null) return;
    chat.state = "suspended";
    chat.error = error instanceof Error ? error.message : String(error);
    await this.save(chat);
    await this.publish(chat, event("system", chat.error));
  }

  /** `checked`: the caller already made sure nothing else holds the session (a switch back from the terminal ends the TUIs itself). */
  private async runAgent(chat: Chat, checked = false): Promise<void> {
    // One agent per chat: one this daemon still runs for it goes before the next starts, never left behind unowned.
    const previous = this.children.get(chat.id);
    if (previous) { this.children.delete(chat.id); await stopChild(previous); }
    // Resuming next to another live process would give the session two writers answering different turns.
    const holders = checked ? [] : await this.foreignHolders(chat);
    if (holders.length > 0) throw new Error(heldMessage(chat, holders));
    const invocation = await chatProtocolAdapters[chat.agent].prepare(chat, this.stateDir);
    const child = spawn(invocation.command, invocation.args, { cwd: chat.cwd, env: { ...scrubAgentEnvironment({ ...process.env, ...this.environment }), MEGABRAIN_CHAT_ID: chat.id }, stdio: ["pipe", "pipe", "pipe"] });
    this.children.set(chat.id, child);
    this.outputSeen.delete(chat.id);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.outputSeen.add(chat.id);
      this.clearStartTimer(chat.id);
      stdout += chunk;
      let end: number;
      while ((end = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
        if (line.trim() === "") continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          // A Codex answer settles its request at once: the event being handled may itself wait for it (a turn that ends starts the next).
          if (chat.agent === "codex" && this.settleRpc(chat.id, parsed)) continue;
          const previous = this.eventChains.get(chat.id) ?? Promise.resolve();
          const next = previous.then(() => chat.agent === "claude" ? this.handleClaude(chat.id, child, parsed) : this.handleCodex(chat.id, child, parsed)).catch((error: unknown) => this.fail(chat.id, error));
          this.eventChains.set(chat.id, next);
        } catch { void this.fail(chat.id, new Error(`invalid ${chat.agent} protocol output`)); }
      }
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.once("error", (error) => { void this.fail(chat.id, error); });
    child.once("close", (code, signal) => {
      if (this.children.get(chat.id) !== child) return;
      this.clearStartTimer(chat.id);
      this.children.delete(chat.id);
      for (const waiter of this.rpcWaiters.get(chat.id)?.values() ?? []) waiter.reject(new Error(stderr.trim() || `${signal ?? "agent exited"}`));
      this.rpcWaiters.delete(chat.id);
      void this.store.get(chat.id).then(async (current) => {
        if (!current || current.state === "suspended" || current.state === "stopped" || current.mode === "terminal") return;
        if (this.interrupting.has(chat.id)) {
          this.interrupting.delete(chat.id);
          current.state = "idle";
          current.error = null;
          await this.save(current);
          await this.publishInterrupted(current);
          return;
        }
        // A turn the agent died in is over: its end says so, so no view keeps showing it run.
        const cut = current.state === "working" || current.state === "waiting-approval";
        current.state = code === 0 ? "idle" : "suspended";
        current.error = code === 0 ? null : `${signal ?? "agent exited"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
        if (code !== 0) this.queues.delete(chat.id);
        if (cut) await this.publishInterrupted(current);
        await this.save(current);
        await this.publish(current, event("system", current.error ?? "Agent process stopped"));
      });
    });
    if (chat.agent === "codex") {
      await this.codexRequest(child, "initialize", { clientInfo: { name: "megabrain", title: "Megabrain", version: "0.2.4" }, capabilities: { experimentalApi: true } });
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      const resumed = chat.agentSessionId !== null;
      const thread = await this.codexRequest(child, resumed ? "thread/resume" : "thread/start", { ...(resumed ? { threadId: chat.agentSessionId } : {}), cwd: chat.cwd, ...(chat.approvals === true ? { approvalPolicy: "on-request", sandbox: "workspace-write" } : { approvalPolicy: "never", sandbox: "danger-full-access" }) });
      const current = await this.requireChat(chat.id);
      current.agentSessionId = text(object(thread).thread && object(object(thread).thread).id) || text(object(thread).threadId) || current.agentSessionId;
      current.state = "idle";
      await this.save(current);
      await this.drain(chat.id);
    } else {
      // Claude prints system/init only after its first user line, so queued input goes out now.
      // With nothing queued the process is up with stdin open, which is idle: the first send writes to it.
      const current = await this.requireChat(chat.id);
      if (current.state === "starting" && (this.queues.get(chat.id)?.length ?? 0) === 0) { current.state = "idle"; await this.save(current); }
      await this.drain(chat.id);
    }
  }

  private async handleClaudeStream(id: string, streamEvent: Record<string, unknown>): Promise<void> {
    const kind = text(streamEvent.type);
    if (kind === "message_start") { this.currentMessage.set(id, text(object(streamEvent.message).id)); this.countClaude(id, (tokens) => ({ ...tokens, thinking: 0, textChars: 0 }), false); return; }
    if (kind === "content_block_delta") {
      const delta = object(streamEvent.delta);
      const messageId = this.currentMessage.get(id) ?? "";
      if (delta.type === "text_delta") {
        this.publishLive(id, event("delta", text(delta.text), undefined, { stream: "assistant", ...withMessage(messageId) }));
        this.countClaude(id, (tokens) => ({ ...tokens, textChars: tokens.textChars + text(delta.text).length }));
      }
      // Without summarized display a chunk carries only a token estimate, which system/thinking_tokens reports too.
      else if (delta.type === "thinking_delta" && text(delta.thinking) !== "") this.publishLive(id, event("delta", text(delta.thinking), undefined, { stream: "thinking", ...withMessage(messageId) }));
      return;
    }
    if (kind === "message_delta") {
      const output = count(object(streamEvent.usage).output_tokens);
      if (output !== undefined) this.countClaude(id, (tokens) => ({ done: tokens.done + output, thinking: 0, textChars: 0 }));
      return;
    }
    const block = object(streamEvent.content_block);
    // An Agent call is published from the complete message, which carries the type and description its subagent shows.
    if (kind === "content_block_start" && block.type === "tool_use" && !isClaudeSubagentTool(text(block.name))) await this.publishToolCall(id, text(block.id), text(block.name), "");
  }

  private async publishToolCall(id: string, toolUseId: string, name: string, input: string, extra: Partial<ChatEvent> = {}): Promise<void> {
    const names = this.toolNames.get(id) ?? new Map<string, string>();
    this.toolNames.set(id, names);
    if (names.has(toolUseId)) return;
    names.set(toolUseId, name);
    const chat = await this.requireChat(id);
    await this.publish(chat, event("tool-call", name, { name, input }, extra));
  }

  /** A subagent's start is the call that started it, carrying who it is; its steps then carry its id as parentId. */
  private async startSubagent(chat: Chat, subagent: Subagent, name: string, input: string): Promise<void> {
    const known = this.subagents.get(chat.id) ?? new Map<string, { name: string; background: boolean; ended: boolean }>();
    this.subagents.set(chat.id, known);
    if (known.has(subagent.id)) return;
    known.set(subagent.id, { name, background: false, ended: false });
    await this.publish(chat, event("tool-call", name, { name, input }, { subagent }));
  }

  /** Ends a subagent once, whichever of the agent's reports of it arrives first. */
  private async endSubagent(chat: Chat, end: SubagentEnd): Promise<void> {
    const known = this.subagents.get(chat.id)?.get(end.id);
    if (known === undefined || known.ended) return;
    known.ended = true;
    await this.publish(chat, event("tool-result", end.text, { name: known.name, status: end.status === "completed" ? "ok" : "error" }, { subagent: { id: end.id, status: end.status } }));
  }

  /** A step a Claude subagent took: its message, or the results of its tool calls, never the prompt it was given. */
  private async publishClaudeStep(chat: Chat, parentId: string, item: Record<string, unknown>): Promise<void> {
    const blocks = Array.isArray(object(item.message).content) ? (object(item.message).content as unknown[]).map(object) : [];
    const identity = { parentId, ...withMessage(text(object(item.message).id)) };
    for (const block of blocks) {
      if (item.type === "assistant" && block.type === "thinking" && text(block.thinking) !== "") await this.publish(chat, event("thinking", text(block.thinking), undefined, identity));
      else if (item.type === "assistant" && block.type === "text" && text(block.text) !== "") await this.publish(chat, event("assistant", text(block.text), undefined, identity));
      else if (item.type === "assistant" && block.type === "tool_use") await this.publishToolCall(chat.id, text(block.id), text(block.name), JSON.stringify(block.input ?? {}), { parentId });
      else if (item.type === "user" && block.type === "tool_result") {
        const name = this.toolNames.get(chat.id)?.get(text(block.tool_use_id)) ?? "tool";
        await this.publish(chat, event("tool-result", flattenContent(block.content), { name, status: block.is_error === true ? "error" : "ok" }, { parentId }));
      }
    }
  }

  private async handleClaude(id: string, child: ChildProcessWithoutNullStreams, item: Record<string, unknown>): Promise<void> {
    // A subagent's output names the Agent call that runs it; its chunks are never the chat's own.
    const parentId = text(item.parent_tool_use_id);
    if (item.type === "stream_event") { if (parentId === "") await this.handleClaudeStream(id, object(item.event)); return; }
    const chat = await this.requireChat(id);
    if (parentId !== "" && (item.type === "assistant" || item.type === "user")) { await this.publishClaudeStep(chat, parentId, item); return; }
    if (item.type === "system" && item.subtype === "thinking_tokens") {
      const estimate = count(item.estimated_tokens);
      if (estimate !== undefined) this.countClaude(id, (tokens) => ({ ...tokens, thinking: estimate }));
      return;
    }
    if (item.type === "system" && item.subtype === "api_retry") {
      const retry = { attempt: count(item.attempt), maxAttempts: count(item.max_retries), delayMs: count(item.retry_delay_ms), reason: text(item.error) || undefined };
      this.publishProgress(id, { retry: Object.fromEntries(Object.entries(retry).filter(([, value]) => value !== undefined)) });
      return;
    }
    if (item.type === "system" && item.subtype === "status") { if (text(item.status) !== "") this.publishProgress(id, { status: text(item.status) }); return; }
    if (item.type === "system" && item.subtype === "task_notification") {
      // A foreground subagent ends on its hand-back, which carries the whole report; a background one only here.
      const end = claudeNotified(item);
      if (this.subagents.get(id)?.get(end.id)?.background === true) await this.endSubagent(chat, end);
      return;
    }
    if (item.type === "system" && item.subtype === "init") {
      if (typeof item.session_id === "string") chat.agentSessionId = item.session_id;
      if (Array.isArray(item.slash_commands)) chat.slashCommands = item.slash_commands.filter((name): name is string => typeof name === "string");
      if (chat.state === "starting") chat.state = "idle";
      await this.save(chat);
      await this.drain(id);
      return;
    }
    if (item.type === "assistant") {
      const message = object(item.message);
      this.updateContext(chat, object(message.usage));
      await this.save(chat);
      const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
      const textValue = blocks.filter((block) => block.type === "text").map((block) => text(block.text)).join("");
      const thinking = blocks.filter((block) => block.type === "thinking").map((block) => text(block.thinking)).join("");
      const identity = withMessage(text(message.id));
      if (thinking) await this.publish(chat, event("thinking", thinking, undefined, identity));
      if (textValue) await this.publish(chat, event("assistant", textValue, undefined, identity));
      for (const block of blocks.filter((candidate) => candidate.type === "tool_use")) {
        const input = JSON.stringify(block.input ?? {});
        if (isClaudeSubagentTool(text(block.name))) await this.startSubagent(chat, claudeSubagent(text(block.id), block.input), text(block.name), input);
        else await this.publishToolCall(id, text(block.id), text(block.name), input);
      }
      return;
    }
    if (item.type === "user") {
      const blocks = Array.isArray(object(item.message).content) ? (object(item.message).content as unknown[]).map(object) : [];
      for (const block of blocks.filter((candidate) => candidate.type === "tool_result")) {
        const subagent = this.subagents.get(id)?.get(text(block.tool_use_id));
        if (subagent !== undefined) {
          const end = claudeHandBack(text(block.tool_use_id), block, item.tool_use_result);
          if (end === null) subagent.background = true;
          else await this.endSubagent(chat, end);
          continue;
        }
        const name = this.toolNames.get(id)?.get(text(block.tool_use_id)) ?? "tool";
        await this.publish(chat, event("tool-result", flattenContent(block.content), { name, status: block.is_error === true ? "error" : "ok" }));
      }
      return;
    }
    if (item.type === "result") {
      // The interrupted turn's own result, after a message sent now already started the next turn.
      if (item.is_error === true && this.interrupting.has(id) && chat.state === "working") { this.interrupting.delete(id); return; }
      if (typeof item.session_id === "string") chat.agentSessionId = item.session_id;
      this.updateContext(chat, object(item.usage));
      const modelUsage = object(item.modelUsage);
      const modelUsageEntry = object(modelUsage[chat.model ?? ""] ?? Object.values(modelUsage)[0]);
      const window = modelUsageEntry.contextWindow;
      if (typeof window === "number" && Number.isSafeInteger(window) && window > 0) chat.contextWindow = window;
      chat.state = item.is_error === true ? "idle" : "idle";
      chat.error = null;
      chat.lastActivityAt = new Date().toISOString();
      await this.save(chat);
      if (item.is_error === true && this.interrupting.has(id)) this.interrupting.delete(id);
      // The turn ended: a foreground subagent that never handed back was stopped with it.
      for (const [subagentId, subagent] of this.subagents.get(id) ?? []) if (!subagent.background) await this.endSubagent(chat, { id: subagentId, status: "stopped", text: "" });
      await this.drain(id);
    }
    if (item.type === "control_request") {
      const request = object(item.request);
      if (request.subtype === "can_use_tool") await this.createApproval(chat, text(request.tool_name), JSON.stringify(request.input ?? {}), text(request.tool_use_id));
    }
  }

  private settleRpc(id: string, item: Record<string, unknown>): boolean {
    if (typeof item.id !== "number" || !("result" in item || "error" in item)) return false;
    const waiter = this.rpcWaiters.get(id)?.get(item.id);
    if (waiter) { this.rpcWaiters.get(id)?.delete(item.id); item.error ? waiter.reject(new Error(text(object(item.error).message) || "Codex request failed")) : waiter.resolve(item.result); }
    return true;
  }

  private async handleCodex(id: string, child: ChildProcessWithoutNullStreams, item: Record<string, unknown>): Promise<void> {
    const method = text(item.method);
    const params = object(item.params);
    const chat = await this.requireChat(id);
    // A spawned thread reports through the same connection; only its steps are shown, under its subagent.
    const thread = text(params.threadId);
    if (thread !== "" && chat.agentSessionId !== null && thread !== chat.agentSessionId) { await this.handleCodexSubagent(chat, thread, method, params); return; }
    if (method === "thread/tokenUsage/updated") {
      const usage = object(params.tokenUsage);
      const last = object(usage.last ?? usage.total);
      const input = count(last.inputTokens);
      const window = usage.modelContextWindow;
      if (input !== undefined) chat.contextTokens = input;
      if (typeof window === "number" && Number.isSafeInteger(window) && window > 0) chat.contextWindow = window;
      await this.save(chat);
      const total = count(object(usage.total).outputTokens);
      const latest = count(object(usage.last).outputTokens) ?? 0;
      if (total !== undefined) {
        const base = this.codexTokenBase.get(id) ?? Math.max(0, total - latest);
        this.codexTokenBase.set(id, base);
        this.publishProgress(id, { tokens: total - base });
      }
    } else if (method === "error") {
      if (params.willRetry === true) this.publishProgress(id, { retry: { reason: text(object(params.error).message) || "error" } });
    } else if (method === "item/reasoning/summaryPartAdded") {
      // Each summary part is a paragraph of its own, as the stored reasoning shows it.
      const index = count(params.summaryIndex);
      if (index !== undefined && index > 0) this.publishLive(id, event("delta", "\n\n", undefined, { stream: "thinking", ...withMessage(text(params.itemId)) }));
    } else if (/delta$/i.test(method) && /reasoning|thinking|agentMessage|assistantMessage/.test(method)) {
      const stream = /reasoning|thinking/.test(method) ? "thinking" : "assistant";
      this.publishLive(id, event("delta", text(params.delta ?? params.text), undefined, { stream, ...withMessage(text(params.itemId)) }));
    } else if (method.includes("reasoning") || method.includes("thinking")) { if (text(params.delta ?? params.text) !== "") await this.publish(chat, event("thinking", text(params.delta ?? params.text))); }
    else if (method.includes("agentMessage") || method.includes("assistantMessage")) await this.publish(chat, event("assistant", text(params.delta ?? params.text)));
    else if (method === "item/started") {
      const itemData = object(params.item);
      if (text(itemData.type).toLowerCase().includes("command")) await this.publish(chat, event("tool-call", text(itemData.command), { name: "command", input: text(itemData.command) }));
    } else if (method === "item/completed") {
      const itemData = object(params.item);
      const type = text(itemData.type).toLowerCase();
      for (const subagent of codexSpawned(itemData)) await this.startSubagent(chat, subagent, text(itemData.tool), text(itemData.prompt));
      for (const end of codexEnded(itemData)) await this.endSubagent(chat, end);
      if (type === "agentmessage" && text(itemData.text)) await this.publish(chat, event("assistant", text(itemData.text), undefined, withMessage(text(itemData.id))));
      if (type === "reasoning" && codexReasoning(itemData)) await this.publish(chat, event("thinking", codexReasoning(itemData), undefined, withMessage(text(itemData.id))));
      if (type.includes("command")) await this.publish(chat, event("tool-result", text(itemData.aggregatedOutput ?? itemData.output), { name: "command", status: itemData.exitCode === 0 ? "ok" : "error" }));
      if (type.includes("approval") && typeof params.id === "number") await this.resolveApproval(id, params.id, { decision: "accept" });
    } else if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const approval = await this.createApproval(chat, method.includes("fileChange") ? "file change" : "command execution", JSON.stringify(params, null, 2), text(params.itemId));
      const requestId = Number(item.id);
      if (Number.isFinite(requestId)) this.pendingRpcApproval.set(`${id}:${requestId}`, approval.id);
    } else if (method === "turn/started") {
      const turn = text(params.turnId);
      this.activeTurns.set(id, turn);
      chat.state = "working";
      await this.save(chat);
    } else if (method === "turn/completed") {
      this.activeTurns.delete(id);
      chat.state = "idle";
      await this.save(chat);
      if (text(object(params.turn).status) === "interrupted" && this.interrupting.has(id)) {
        this.interrupting.delete(id);
        await this.publishInterrupted(chat);
      }
      await this.drain(id);
    }
  }

  private async handleCodexSubagent(chat: Chat, thread: string, method: string, params: Record<string, unknown>): Promise<void> {
    if (this.subagents.get(chat.id)?.has(thread) !== true) return;
    const itemData = object(params.item);
    const type = text(itemData.type).toLowerCase();
    const parent = { parentId: thread };
    if (method === "item/started" && type.includes("command")) await this.publish(chat, event("tool-call", text(itemData.command), { name: "command", input: text(itemData.command) }, parent));
    if (method !== "item/completed") return;
    if (type === "agentmessage" && text(itemData.text)) await this.publish(chat, event("assistant", text(itemData.text), undefined, { ...parent, ...withMessage(text(itemData.id)) }));
    const reasoning = codexReasoning(itemData);
    if (type === "reasoning" && reasoning) await this.publish(chat, event("thinking", reasoning, undefined, { ...parent, ...withMessage(text(itemData.id)) }));
    if (type.includes("command")) await this.publish(chat, event("tool-result", text(itemData.aggregatedOutput ?? itemData.output), { name: "command", status: itemData.exitCode === 0 ? "ok" : "error" }, parent));
  }

  private readonly rpcWaiters = new Map<string, Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>>();
  private readonly pendingRpcApproval = new Map<string, string>();
  private rpcSequence = 1;
  private async codexRequest(child: ChildProcessWithoutNullStreams, method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.rpcSequence++;
    // The current child is keyed by its owning chat; it is set before initialize is requested.
    const chatId = [...this.children.entries()].find(([, process]) => process === child)?.[0];
    if (!chatId) throw new Error("Codex child is no longer active");
    const waiters = this.rpcWaiters.get(chatId) ?? new Map(); this.rpcWaiters.set(chatId, waiters);
    const result = new Promise<unknown>((resolve, reject) => waiters.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  }

  /** Starts the next turn when the agent is free; drains run one at a time per chat, so two callers never send twice. */
  private drain(id: string): Promise<void> {
    const next = (this.drainChains.get(id) ?? Promise.resolve()).then(() => this.drainOnce(id));
    this.drainChains.set(id, next.catch(() => undefined));
    return next;
  }

  private async drainOnce(id: string): Promise<void> {
    const child = this.children.get(id);
    const chat = await this.store.get(id);
    if (!child || !chat || chat.state === "working" || chat.state === "waiting-approval") return;
    let parts: Part[];
    const outbox = this.queues.get(id);
    if (outbox !== undefined && outbox.length > 0) {
      parts = outbox.shift() as Part[];
      if (outbox.length === 0) this.queues.delete(id);
      this.queueHeld.delete(id);
    } else {
      if (chat.state !== "idle" || chat.mode !== "chat" || this.queueHeld.has(id) || this.draining) return;
      const items = await this.loadQueue(id);
      const item = items.shift();
      if (item === undefined) return;
      parts = item.parts;
      await this.persistQueue(id);
      chat.lastActivityAt = new Date().toISOString();
      await this.publish(chat, event("user", firstText(parts), undefined, withImages(parts)));
    }
    chat.state = "working";
    await this.save(chat);
    const adapter = chatProtocolAdapters[chat.agent];
    const turnId = await adapter.send(chat, child, parts, (method, params) => this.codexRequest(child, method, params));
    if (turnId) this.activeTurns.set(id, turnId);
    if (chat.agent === "claude" && !this.outputSeen.has(id) && !this.startTimers.has(id)) this.armStartTimer(id, child);
  }

  // Claude prints nothing until it reads input; if it still says nothing after the first write, the chat is stuck.
  private armStartTimer(id: string, child: ChildProcessWithoutNullStreams): void {
    const configured = Number(this.environment.MEGABRAIN_CHAT_START_TIMEOUT_MS);
    const ms = Number.isFinite(configured) && configured > 0 ? configured : 60_000;
    const timer = setTimeout(() => {
      this.startTimers.delete(id);
      if (this.children.get(id) !== child || this.outputSeen.has(id)) return;
      this.children.delete(id);
      child.kill("SIGTERM");
      void this.fail(id, new Error(`Claude did not answer within ${ms / 1000} s of the first message`));
    }, ms);
    timer.unref?.();
    this.startTimers.set(id, timer);
  }

  private clearStartTimer(id: string): void {
    const timer = this.startTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.startTimers.delete(id);
  }

  private async interrupt(id: string): Promise<void> {
    const chat = await this.requireChat(id);
    const child = this.children.get(id);
    this.queueHeld.add(id);
    if (chat.agent === "claude") {
      this.interrupting.add(id);
      chat.state = "idle";
      await this.save(chat);
      await this.publishInterrupted(chat);
      await chatProtocolAdapters[chat.agent].interrupt(chat, child, this.activeTurns.get(id), (method, params) => child ? this.codexRequest(child, method, params) : Promise.resolve(undefined));
    }
    else {
      const turnId = this.activeTurns.get(id);
      if (turnId && child) {
        this.interrupting.add(id);
        await chatProtocolAdapters[chat.agent].interrupt(chat, child, turnId, (method, params) => this.codexRequest(child, method, params));
      } else {
        chat.state = "idle";
        await this.save(chat);
        await this.publishInterrupted(chat);
      }
    }
  }

  private async stop(id: string): Promise<void> {
    const chat = await this.requireChat(id);
    const child = this.children.get(id);
    if (child) { child.kill("SIGTERM"); this.children.delete(id); }
    this.clearStartTimer(id);
    for (const map of [this.queues, this.activeTurns]) map.delete(id);
    chat.state = "suspended";
    chat.error = null;
    chat.lastActivityAt = new Date().toISOString();
    await this.save(chat);
    await this.publish(chat, event("system", "Stopped"));
  }

  /** A person's rename: the title is theirs from now on and automatic titles stop for this chat. */
  private async rename(id: string, title: string): Promise<Chat> {
    const chat = await this.requireChat(id);
    const named = title.trim().slice(0, 120);
    if (named === "") throw new Error("a chat title cannot be empty");
    chat.title = named;
    chat.titleSource = "person";
    await this.save(chat);
    await this.publish(chat, this.stateEvent(chat));
    return chat;
  }

  /** Stops the agent and deletes the chat's record and events; the agent's own session log stays resumable. */
  private async remove(id: string): Promise<{ removed: string }> {
    await this.requireChat(id);
    this.removed.add(id);
    const child = this.children.get(id);
    this.children.delete(id);
    this.clearStartTimer(id);
    if (child) child.kill("SIGTERM");
    await Promise.allSettled([this.eventChains.get(id), this.appendChains.get(id), this.queueWrites.get(id)]);
    this.stopArtifactWatch(id);
    for (const map of [this.queues, this.queued, this.queueWrites, this.drainChains, this.activeTurns, this.eventChains, this.appendChains, this.publishedState, this.turnStarted, this.currentMessage, this.claudeTokens, this.codexTokenBase, this.toolNames, this.subagents, this.subscribers]) map.delete(id);
    this.queueHeld.delete(id);
    this.interrupting.delete(id);
    this.interruptedEvents.delete(id);
    this.outputSeen.delete(id);
    await rm(this.store.dir(id), { recursive: true, force: true });
    this.store.forget(id);
    await this.dropConversation(id);
    return { removed: id };
  }

  private async mode(id: string, mode: string): Promise<{ chat: Chat; terminal: null; command: string[] | null }> {
    const chat = await this.requireChat(id);
    if (mode !== "chat" && mode !== "terminal") throw new Error("mode must be chat or terminal");
    if (mode === "terminal" && chat.mode === "terminal") {
      // Already the terminal's: reopening it after an app restart changes nothing, the app attaches to the TUI that runs.
    } else if (mode === "terminal") {
      const child = this.children.get(id);
      if (child) { this.children.delete(id); await stopChild(child); }
      // The app attaches to a TUI already on its own tmux server; one anywhere else would be a second writer.
      const elsewhere = (await this.foreignHolders(chat)).filter((holder) => holder.tmuxSession === null);
      if (elsewhere.length > 0) throw new Error(heldMessage(chat, elsewhere));
      this.clearStartTimer(id);
      for (const map of [this.queues, this.activeTurns]) map.delete(id);
      if (chat.state === "working" || chat.state === "waiting-approval") await this.publish(chat, event("system", "Interrupted"));
      chat.error = null;
      chat.mode = "terminal";
      chat.state = "idle";
      chat.terminalSince = new Date().toISOString();
      await this.save(chat);
    } else if (chat.mode === "terminal") {
      if (this.draining) throw new Error(DRAINING);
      // A TUI opened without a session writes its own; adopt it so the chat resumes where the terminal left off.
      if (chat.agentSessionId === null) chat.agentSessionId = await this.sessionOfTerminal(chat);
      // The chat's agent becomes the session's one process: every TUI the app still runs on it ends first.
      const ended = await this.endAppTerminals(chat);
      const elsewhere = (await this.foreignHolders(chat)).filter((holder) => !ended.has(holder.pid));
      if (elsewhere.length > 0) throw new Error(heldMessage(chat, elsewhere));
      await this.importTerminalTurns(chat);
      chat.mode = "chat";
      chat.state = "starting";
      await this.save(chat);
      // runAgent owns the record from here: saving this copy again could land after its idle and undo it.
      void this.runAgent(chat, true).catch((error) => this.fail(id, error));
    }
    // The terminal's command rides along, so opening it costs no second round trip.
    return { chat, terminal: null, command: chat.mode === "terminal" ? chatProtocolAdapters[chat.agent].terminalCommand(chat) : null };
  }

  /** Turns typed in the terminal live only in the agent's log; they join the chat, once each, before the agent respawns. */
  private async importTerminalTurns(chat: Chat): Promise<void> {
    const known = new Set((await this.store.events(chat.id)).flatMap((line) => line.event?.sourceId === undefined ? [] : [line.event.sourceId]));
    const since = chat.terminalSince ?? "";
    const turns = await readSessionTurns(chat, this.environment.HOME ?? homedir());
    for (const turn of turns) {
      if (turn.at <= since || known.has(turn.sourceId)) continue;
      const { kind, text: value, at, tool, messageId, parentId, subagent, sourceId } = turn;
      await this.publish(chat, { id: randomUUID(), at, kind, text: value, ...(tool === undefined ? {} : { tool }), ...(messageId === undefined ? {} : { messageId }), ...(parentId === undefined ? {} : { parentId }), ...(subagent === undefined ? {} : { subagent }), sourceId });
    }
    // The TUIs are gone by now, so a turn the log leaves open was cut and nobody will finish it.
    const last = turns.filter((turn) => turn.at > since).at(-1);
    const marker = last === undefined ? "" : `${last.sourceId}:interrupted`;
    if (last === undefined || known.has(marker) || !await this.logTurnOpen(chat)) return;
    await this.publish(chat, { ...event("system", "Interrupted"), at: last.at, sourceId: marker });
  }

  private async logTurnOpen(chat: Chat): Promise<boolean> {
    const path = await sessionLogPath(chat, this.environment.HOME ?? homedir());
    if (path === null) return false;
    try { return sessionTurnOpen(chat.agent, await readFile(path, "utf8")); } catch { return false; }
  }

  /** Every process holding the chat's session other than this daemon's own agents. */
  private async foreignHolders(chat: Chat, panes?: ReadonlyMap<number, string>): Promise<SessionHolder[]> {
    if (chat.agentSessionId === null) return [];
    const own = new Set([...this.children.values()].flatMap((child) => child.pid === undefined ? [] : [child.pid]));
    return liveSessionHolders(chat.agent, chat.agentSessionId, { home: this.environment.HOME ?? homedir(), processes: this.processes(), exclude: own, cwd: chat.cwd, ...(panes === undefined ? {} : { panes }) });
  }

  /** The pane processes of one session on the app's tmux server, as pane pid to session name. */
  private async panesOf(session: string): Promise<ReadonlyMap<number, string>> {
    const listed = await ownedTmuxProcess(this.processes()).run("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_pid}"]);
    const pids = listed.kind === "ok" ? listed.value.stdout.split("\n").map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 1) : [];
    return new Map(pids.map((pid) => [pid, session]));
  }

  /**
   * Ends the chat's own terminal and any other session megabrain runs on the app's tmux server that resumes the chat's
   * session. Returns the pids of the holders it ended, which may take a moment more to exit.
   */
  private async endAppTerminals(chat: Chat): Promise<ReadonlySet<number>> {
    const alias = this.entryOf(chat.id)?.[1].aliases.tmux ?? null;
    const [server, aliased] = (alias ?? "").split(":");
    const own = server === OWNED_TMUX_SERVER && aliased !== undefined && aliased.startsWith("mb-") ? aliased : null;
    const panes = own === null ? undefined : await this.panesOf(own);
    const ended = (await this.foreignHolders(chat, panes)).filter((holder) => holder.tmuxSession?.startsWith("mb-") === true);
    const sessions = new Set(ended.flatMap((holder) => holder.tmuxSession === null ? [] : [holder.tmuxSession]));
    if (own !== null) sessions.add(own);
    const pids = new Set(ended.map((holder) => holder.pid));
    if (sessions.size === 0) return pids;
    const tmux = ownedTmuxProcess(this.processes());
    for (const session of sessions) {
      await tmux.run("tmux", ["kill-session", "-t", `=${session}`]);
      try { if (session.startsWith(APP_SESSION_PREFIX)) forgetAppTerminal(this.stateDir, session); } catch { /* a listing aid */ }
    }
    try {
      const owned = readOwnedSessions(this.stateDir);
      const kept = Object.fromEntries(Object.entries(owned).filter(([, entry]) => !(entry.tmuxServer === OWNED_TMUX_SERVER && sessions.has(entry.tmuxSession))));
      if (Object.keys(kept).length !== Object.keys(owned).length) writeOwnedSessions(this.stateDir, kept);
      const key = this.entryOf(chat.id)?.[0];
      if (key !== undefined && aliased !== undefined && sessions.has(aliased)) setConversationAlias(this.stateDir, key, { tmux: null });
    } catch { /* a listing aid */ }
    // tmux returns before the pane's process has gone; the next holder check must not see it.
    for (let attempt = 0; attempt < 20 && (await this.foreignHolders(chat)).some((holder) => pids.has(holder.pid)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    return pids;
  }

  /** A terminal-mode chat shows its TUI's state: working while the session log holds an unfinished turn and a process still runs it. */
  private async refreshTerminalChats(): Promise<void> {
    for (const listed of await this.store.list()) {
      if (listed.mode !== "terminal" || listed.agentSessionId === null) continue;
      const path = await sessionLogPath(listed, this.environment.HOME ?? homedir());
      let content: string;
      let key: string;
      try {
        const info = await stat(path ?? "");
        key = `${info.size}:${info.mtimeMs}`;
        if (key === this.terminalLogs.get(listed.id) && listed.state !== "working") continue;
        content = await readFile(path ?? "", "utf8");
      } catch { content = ""; key = ""; }
      this.terminalLogs.set(listed.id, key);
      const working = sessionTurnOpen(listed.agent, content) && (await this.foreignHolders(listed)).length > 0;
      const state: Chat["state"] = working ? "working" : "idle";
      // The record may have moved on while the log was read: only a chat still in the same terminal stint changes.
      const chat = await this.store.get(listed.id);
      if (!chat || chat.mode !== "terminal" || chat.terminalSince !== listed.terminalSince || chat.state === state) continue;
      chat.state = state;
      if (!working) chat.lastActivityAt = new Date().toISOString();
      await this.save(chat);
    }
  }

  private async terminalCommand(id: string): Promise<string[]> {
    const chat = await this.requireChat(id);
    return chatProtocolAdapters[chat.agent].terminalCommand(chat);
  }

  private updateContext(chat: Chat, usage: Record<string, unknown>): void {
    const fields = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
    if (fields.some((value) => value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0))) return;
    if (fields.some((value) => typeof value === "number")) chat.contextTokens = fields.reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
  }

  private async setModel(id: string, model: string, effort: string | null): Promise<Chat> {
    if (!model || model.length > 200) throw new Error("model must be a non-empty id no longer than 200 characters");
    const chat = await this.requireChat(id);
    if ((chat.state !== "idle" && chat.state !== "suspended") || chat.mode !== "chat") throw new Error(`cannot change the model while chat is ${chat.state}; wait until it is idle`);
    chat.model = model;
    if (effort !== null) chat.effort = effort;
    chat.lastActivityAt = new Date().toISOString();
    if (chat.agent === "claude" && chat.state === "idle") {
      const child = this.children.get(id);
      if (child) { this.children.delete(id); child.kill("SIGTERM"); }
      chat.state = "starting";
      await this.save(chat);
      void this.runAgent(chat).catch((error) => this.fail(id, error));
    } else await this.save(chat);
    this.publishLive(id, this.stateEvent(chat));
    return chat;
  }

  private async startArtifactWatch(chat: Chat): Promise<void> {
    if (this.artifactWatches.has(chat.id)) return;
    const artifacts = await listChatArtifacts(this.stateDir, chat, this.environment.HOME ?? homedir());
    const watch: ArtifactWatch = { timer: setInterval(() => { void this.checkArtifactWatch(chat); }, 1000), artifacts, storeFingerprint: "", fileFingerprint: "", refreshing: false };
    watch.storeFingerprint = chatArtifactStoreFingerprint(this.stateDir, artifacts);
    watch.fileFingerprint = chatArtifactFileFingerprint(artifacts);
    watch.timer.unref?.();
    this.artifactWatches.set(chat.id, watch);
  }

  private stopArtifactWatch(id: string): void {
    const watch = this.artifactWatches.get(id);
    if (watch !== undefined) clearInterval(watch.timer);
    this.artifactWatches.delete(id);
  }

  private async replaceArtifactSnapshot(chat: Chat, watch: ArtifactWatch, artifacts: ChatArtifact[]): Promise<void> {
    artifacts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    const changed = chatArtifactSignature(watch.artifacts) !== chatArtifactSignature(artifacts);
    watch.artifacts = artifacts;
    watch.storeFingerprint = chatArtifactStoreFingerprint(this.stateDir, artifacts);
    watch.fileFingerprint = chatArtifactFileFingerprint(artifacts);
    if (changed) this.publishLive(chat.id, event("artifacts", ""));
  }

  private async refreshClaudeArtifacts(chat: Chat): Promise<void> {
    const watch = this.artifactWatches.get(chat.id);
    if (watch === undefined || watch.refreshing) return;
    watch.refreshing = true;
    try {
      const claude = await listClaudeChatArtifacts(chat, this.environment.HOME ?? homedir());
      const artifacts = [...watch.artifacts.filter((artifact) => artifact.source !== "claude-artifact" && artifact.source !== "claude-design"), ...claude.map((item) => item.artifact)];
      await this.replaceArtifactSnapshot(chat, watch, artifacts);
    } catch { /* a session log can be mid-write; the next tool result or local mtime check will retry */ }
    finally { watch.refreshing = false; }
  }

  private async checkArtifactWatch(chat: Chat): Promise<void> {
    const watch = this.artifactWatches.get(chat.id);
    if (watch === undefined || watch.refreshing || this.subscribers.get(chat.id)?.size === 0) return;
    const storeFingerprint = chatArtifactStoreFingerprint(this.stateDir, watch.artifacts);
    const fileFingerprint = chatArtifactFileFingerprint(watch.artifacts);
    if (storeFingerprint === watch.storeFingerprint && fileFingerprint === watch.fileFingerprint) return;
    watch.refreshing = true;
    try {
      let artifacts = watch.artifacts;
      if (storeFingerprint !== watch.storeFingerprint) {
        const megabrain = await listMegabrainChatArtifacts(this.stateDir, chat);
        artifacts = [...artifacts.filter((artifact) => artifact.source !== "megabrain"), ...megabrain.map((item) => item.artifact)];
      }
      if (fileFingerprint !== watch.fileFingerprint) {
        artifacts = artifacts.map((artifact) => {
          if (artifact.path === undefined) return artifact;
          try { return { ...artifact, updatedAt: statSync(artifact.path).mtime.toISOString() }; }
          catch { return artifact; }
        });
      }
      await this.replaceArtifactSnapshot(chat, watch, artifacts);
    } catch { /* files can disappear during a check; keep the last complete snapshot */ }
    finally { watch.refreshing = false; }
  }

  private async events(id: string, since: number, follow: boolean, socket?: Socket): Promise<ChatLine[]> {
    const chat = await this.requireChat(id);
    const head: ChatLine = { cursor: String(since), chat, queue: [...await this.loadQueue(id)] };
    if (socket) {
      socket.write(`${JSON.stringify(head)}\n`);
      if (follow) {
        const listeners = this.subscribers.get(id) ?? new Set();
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
        listeners.add(listener); this.subscribers.set(id, listeners);
        socket.once("close", () => { listeners.delete(listener); if (listeners.size === 0) this.stopArtifactWatch(id); });
        try {
          await this.startArtifactWatch(chat);
          for (const line of await this.store.events(id, since)) write(line);
          for (let index = 0; index < pending.length; index += 1) { const line = pending[index] as ChatLine; write(line, pendingLive.has(line)); }
          replaying = false;
          const current = await this.store.get(id);
          if (current) write({ cursor: "", event: this.stateEvent(current) }, true);
        } catch (error) {
          listeners.delete(listener);
          if (listeners.size === 0) this.stopArtifactWatch(id);
          throw error;
        }
        return [];
      }
      for (const line of await this.store.events(id, since)) socket.write(`${JSON.stringify(line)}\n`);
    }
    return [head, ...await this.store.events(id, since)];
  }

  private async permission(id: string, request: Record<string, unknown>): Promise<unknown> {
    const chat = await this.requireChat(id);
    const args = object(request.arguments);
    const approval = await this.createApproval(chat, text(args.tool_name), JSON.stringify(args.input ?? {}), text(args.tool_use_id));
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pendingApprovals.delete(approval.id); resolve({ behavior: "deny" }); }, 10 * 60_000);
      this.pendingApprovals.set(approval.id, { approval, resolve: (decision) => { clearTimeout(timer); resolve({ behavior: decision === "allow" || decision === "allow-session" ? "allow" : "deny" }); } });
    });
  }

  private async createApproval(chat: Chat, tool: string, input: string, reason: string): Promise<ChatApproval> {
    const approval: ChatApproval = { id: randomUUID(), tool, input, reason: reason || null, decisions: ["allow", "allow-session", "deny"] };
    chat.state = "waiting-approval";
    await this.save(chat);
    await this.publish(chat, event("approval", `${tool} requires approval`), approval);
    return approval;
  }

  private async approve(id: string, approvalId: string, decision: string): Promise<void> {
    if (!(["allow", "allow-session", "deny"] as string[]).includes(decision)) throw new Error("decision must be allow, allow-session, or deny");
    const pending = this.pendingApprovals.get(approvalId);
    if (pending) { pending.resolve(decision); this.pendingApprovals.delete(approvalId); }
    for (const [key, candidate] of this.pendingRpcApproval) {
      if (!key.startsWith(`${id}:`) || candidate !== approvalId) continue;
      const [, requestId] = key.split(":");
      const child = this.children.get(id);
      if (child) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: Number(requestId), result: { decision: decision === "deny" ? "decline" : decision === "allow-session" ? "acceptForSession" : "accept" } })}\n`);
      this.pendingRpcApproval.delete(key);
    }
    const chat = await this.requireChat(id);
    if (chat.state === "waiting-approval") chat.state = "working";
    await this.save(chat);
  }

  private async resolveApproval(id: string, requestId: number, response: unknown): Promise<void> {
    const child = this.children.get(id);
    if (child) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, result: response })}\n`);
  }

  private async requireChat(id: string): Promise<Chat> {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error("invalid chat id");
    const chat = await this.store.get(id);
    if (!chat) throw new Error(`chat not found: ${id}`);
    return chat;
  }
  private async normalizeParts(cwd: string, parts: Part[]): Promise<Part[]> {
    return Promise.all(parts.map(async (part) => {
      if (part.type !== "image") return part;
      const path = isAbsolute(part.path) ? part.path : resolve(cwd, part.path);
      const file = await stat(path);
      if (!file.isFile()) throw new Error(`image is not a regular file: ${path}`);
      return { type: "image", path };
    }));
  }

  private processes(): ProcessAdapter {
    const base = createProcessAdapter();
    const path = this.environment.PATH;
    return path === undefined ? base : { ...base, run: (command, args, options) => base.run(command, args, { ...options, env: { PATH: path, ...options?.env } }) };
  }

  /** The conversation entry that belongs to this chat, wherever it is keyed. */
  private entryOf(chatId: string): [string, Conversation] | undefined {
    return Object.entries(readConversations(this.stateDir).conversations).find(([, entry]) => entry.aliases.chatId === chatId);
  }

  /** A chat with a turn is one conversation in the registry: keyed by its chat until the agent reports its session, then by the session. */
  private track(chat: Chat): void {
    if (chat.title === null && chat.agentSessionId === null && chat.mode === "chat") return;
    try {
      const key = chat.agentSessionId === null ? chatKey(chat.id) : sessionKey(chat.agent, chat.agentSessionId);
      if (this.tracked.get(chat.id) === key) return;
      const current = this.entryOf(chat.id);
      if (current !== undefined && current[0] !== key) promoteConversation(this.stateDir, current[0], key);
      else if (current === undefined) upsertConversation(this.stateDir, key, { owner: "app-chat", cwd: chat.cwd, aliases: { chatId: chat.id, tmux: null, pid: null, dispatchId: null }, createdAt: chat.createdAt, hidden: false });
      this.tracked.set(chat.id, key);
    } catch { /* the registry is a listing aid: a locked file must not fail a turn */ }
  }

  /** Removing a chat also ends the app terminal its terminal mode left on the app's tmux server, and drops its entry. */
  private async dropConversation(chatId: string): Promise<void> {
    this.tracked.delete(chatId);
    const found = this.entryOf(chatId);
    if (found === undefined) return;
    const [key, entry] = found;
    const [server, session] = (entry.aliases.tmux ?? "").split(":");
    if (server === OWNED_TMUX_SERVER && session !== undefined && session !== "") await ownedTmuxProcess(this.processes()).run("tmux", ["kill-session", "-t", `=${session}`]);
    removeConversation(this.stateDir, key);
  }

  /** Chats that never had a turn are placeholders: nothing the person made, so a restart collects them. */
  private async pruneUnused(): Promise<void> {
    for (const chat of await this.store.list()) {
      if (chat.mode !== "chat" || chat.agentSessionId !== null || chat.title !== null) continue;
      if ((await this.store.events(chat.id)).some((line) => line.event?.kind === "user")) continue;
      await rm(this.store.dir(chat.id), { recursive: true, force: true });
      this.store.forget(chat.id);
    }
  }

  /** The session of the TUI running in this chat's own pane; no pane, no answer. */
  private async sessionOfTerminal(chat: Chat): Promise<string | null> {
    const alias = this.entryOf(chat.id)?.[1].aliases.tmux ?? null;
    const [server, session] = (alias ?? "").split(":");
    if (server !== OWNED_TMUX_SERVER || session === undefined || session === "") return null;
    const processes = this.processes();
    const panes = await ownedTmuxProcess(processes).run("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_pid}"]);
    const panePids = panes.kind === "ok" ? panes.value.stdout.split("\n").map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 1) : [];
    const found = await discoverSessionId(chat, this.environment.HOME ?? homedir(), panePids, processes);
    if (found !== null) try { promoteConversation(this.stateDir, this.entryOf(chat.id)?.[0] ?? chatKey(chat.id), sessionKey(chat.agent, found)); } catch { /* listing aid */ }
    return found;
  }
  /** Persists the chat and, when its state moved, publishes the new state to followers and history. */
  private async save(chat: Chat): Promise<void> {
    if (this.removed.has(chat.id)) return;
    await this.store.put(chat);
    this.track(chat);
    if (this.publishedState.get(chat.id) === chat.state) return;
    this.publishedState.set(chat.id, chat.state);
    if (chat.state === "working") {
      if (!this.turnStarted.has(chat.id)) { this.turnStarted.set(chat.id, new Date().toISOString()); this.claudeTokens.delete(chat.id); this.codexTokenBase.delete(chat.id); }
    }
    else if (chat.state !== "waiting-approval") this.turnStarted.delete(chat.id);
    await this.publish(chat, this.stateEvent(chat));
    if (chat.state === "idle") void this.summarizer.turnEnded(chat.id);
  }
  private stateEvent(chat: Chat): ChatEvent {
    const startedAt = this.turnStarted.get(chat.id);
    return event("state", chat.state, undefined, chat.state === "working" && startedAt !== undefined ? { turnStartedAt: startedAt } : {});
  }
  /** Sends an event to current followers only; the cursor is the last stored one, so a resume never skips history. */
  private publishLive(id: string, value: ChatEvent): void { this.broadcast(id, { cursor: "", event: value }); }
  private publishProgress(id: string, progress: ChatProgress): void { this.publishLive(id, event("progress", "", undefined, { progress })); }
  /** Moves a Claude turn's token count and, unless told not to, tells followers the new total. */
  private countClaude(id: string, change: (tokens: { done: number; thinking: number; textChars: number }) => { done: number; thinking: number; textChars: number }, publish = true): void {
    const tokens = change(this.claudeTokens.get(id) ?? { done: 0, thinking: 0, textChars: 0 });
    this.claudeTokens.set(id, tokens);
    if (publish) this.publishProgress(id, { tokens: tokens.done + tokens.thinking + Math.ceil(tokens.textChars / 4) });
  }
  private broadcast(id: string, line: ChatLine): void {
    for (const listener of this.subscribers.get(id) ?? []) listener(line, true);
  }
  private async publish(chat: Chat, value: ChatEvent, approval?: ChatApproval): Promise<void> {
    const previous = this.appendChains.get(chat.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.removed.has(chat.id)) return;
      const line = await this.store.append(chat.id, value, approval);
      for (const listener of this.subscribers.get(chat.id) ?? []) listener(line);
      if (value.kind === "tool-result") void this.refreshClaudeArtifacts(chat);
    });
    this.appendChains.set(chat.id, next);
    await next;
  }
  private async publishInterrupted(chat: Chat): Promise<void> {
    if (this.interruptedEvents.has(chat.id)) return;
    this.interruptedEvents.add(chat.id);
    await this.publish(chat, event("system", "Interrupted"));
  }
  private async fail(id: string, error: unknown): Promise<void> {
    const chat = await this.store.get(id);
    if (!chat) return;
    chat.state = "error"; chat.error = error instanceof Error ? error.message : String(error);
    await this.save(chat);
    await this.publish(chat, event("system", chat.error));
  }
  private scheduleExit(): void {
    if (this.closed || this.clients > 0 || [...this.children.values()].some((child) => child.exitCode === null)) return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.close(); }, 10 * 60_000);
    this.idleTimer.unref?.();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.idleTimer && clearTimeout(this.idleTimer);
    for (const id of this.artifactWatches.keys()) this.stopArtifactWatch(id);
    if (this.terminalTimer !== undefined) clearInterval(this.terminalTimer);
    this.server?.close();
    this.server = undefined;
    // An agent left running here would outlive the daemon, reparented to init with nobody to stop it; the next
    // daemon must not find it still holding its session either.
    const children = [...this.children.values()];
    this.children.clear();
    await Promise.all(children.map(stopChild));
    // The caller of a handover still has its answer in flight; everything else is dropped shortly after so the process can leave.
    const open = [...this.sockets];
    setTimeout(() => { for (const socket of open) socket.destroy(); }, 100).unref?.();
    try { await (await import("node:fs/promises")).unlink(chatSocket(this.stateDir)); } catch { /* already closed */ }
    try { await (await import("node:fs/promises")).unlink(chatPid(this.stateDir)); } catch { /* already closed */ }
    instances.delete(this.stateDir);
  }
  private server: ReturnType<typeof createServer> | undefined;
  async listen(): Promise<void> {
    if (await socketAccepts(this.stateDir, DEFAULT_CONNECT_TIMEOUT_MS)) throw new Error("chatd is already running");
    await discardStaleState(this.stateDir, { pid: false });
    return new Promise((resolve, reject) => {
      const socketPath = chatSocket(this.stateDir);
      this.server = createServer((socket) => {
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
        this.clients += 1;
        if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
        socket.once("close", () => { this.clients -= 1; this.scheduleExit(); });
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          const end = buffer.indexOf("\n");
          if (end === -1) return;
          const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let request: Request;
          try { request = JSON.parse(raw) as Request; }
          catch { socket.end(`${JSON.stringify({ ok: false, error: "invalid request" })}\n`); return; }
          void this.handle(request, socket).then((value) => {
            if (!socket.destroyed && !(request.operation === "events" && request.follow === true)) socket.end(`${JSON.stringify({ ok: true, value })}\n`);
          }).catch((error: unknown) => { if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`); });
        });
      });
      this.server.once("error", reject);
      this.server.listen(socketPath, () => { void chmod(socketPath, 0o600).then(resolve, reject); });
      const poll = timeoutMs(this.environment.MEGABRAIN_CHAT_TERMINAL_POLL_MS, DEFAULT_TERMINAL_POLL_MS);
      let refreshing = false;
      this.terminalTimer = setInterval(() => {
        if (refreshing) return;
        refreshing = true;
        void this.refreshTerminalChats().catch(() => undefined).finally(() => { refreshing = false; });
      }, poll);
      this.terminalTimer.unref?.();
    });
  }
}

async function socketRequest(stateDir: string, request: Request, timeouts: Timeouts | { connect: number; request: undefined }, onLine?: (line: ChatLine) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(chatSocket(stateDir));
    let buffer = "";
    let responseSeen = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number | undefined, message: string, code?: string) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = ms === undefined ? undefined : setTimeout(() => { reject(Object.assign(new Error(message), code === undefined ? {} : { code })); socket.destroy(); }, ms);
    };
    arm(timeouts.connect, `chatd did not accept the connection within ${timeouts.connect / 1000} s`, "ETIMEDOUT");
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      arm(timeouts.request, `chatd did not answer within ${(timeouts.request ?? 0) / 1000} s`);
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      // A following call has no final reply; the first line proves the daemon answers, and its death ends the socket.
      if (request.follow === true) arm(undefined, "");
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const parsed = JSON.parse(line) as Response | ChatLine;
          if ("ok" in parsed) {
            responseSeen = true;
            arm(undefined, "");
            if (parsed.ok) resolve(parsed.value);
            else reject(Object.assign(new Error(parsed.error), { code: parsed.code }));
            if (!request.follow) socket.end();
          } else onLine?.(parsed);
        } catch (error) { reject(error); socket.destroy(); }
      }
    });
    socket.once("error", (error) => { arm(undefined, ""); reject(error); });
    socket.once("close", () => {
      arm(undefined, "");
      if (!responseSeen) reject(new Error(request.follow === true ? "chatd stopped while following events" : "chatd closed the connection"));
    });
  });
}

export async function runChatd(stateDir: string): Promise<void> {
  const daemon = new ChatDaemon(stateDir);
  await daemon.start();
  await daemon.listen();
  instances.set(stateDir, daemon);
  try { await unlink(chatLock(stateDir)); } catch { /* no client lock during direct starts */ }
}

/**
 * A running chatd of another protocol version is asked to hand over: it waits for working chats, suspends the rest and
 * leaves, so the caller's next request finds no socket and starts a current daemon. One that predates the handshake
 * cannot be asked, and is used as it is.
 */
async function ensureProtocol(stateDir: string, timeouts: Timeouts): Promise<void> {
  let hello: Record<string, unknown> = {};
  try { hello = object(await socketRequest(stateDir, { operation: "hello" }, timeouts)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOENT") throw error;
  }
  const protocol = hello.protocol;
  // Same protocol, older build: it drains in the background, still answering, and this call goes on with it.
  if (protocol === CHAT_PROTOCOL_VERSION && typeof hello.build === "number" && chatBuild() > hello.build) {
    try { await socketRequest(stateDir, { operation: "drain", wait: false }, timeouts); } catch { /* a chatd without drain keeps serving */ }
    return;
  }
  if (protocol === CHAT_PROTOCOL_VERSION || protocol === undefined) return;
  await socketRequest(stateDir, { operation: "handover" }, { connect: timeouts.connect, request: undefined });
  for (let attempt = 0; attempt < 100 && await socketAccepts(stateDir, 200); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
}

type Starter = { startDetached(command: string, args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<{ kind: string; error?: string }> };

/**
 * A request a draining chatd refuses (a new turn it cannot start) waits until that chatd has gone, then goes to
 * the next one, which this call starts.
 */
export async function callChatd(stateDir: string, request: Request, environment: Environment, processAdapter: Starter, onLine?: (line: ChatLine) => void): Promise<unknown> {
  try { return await callChatdOnce(stateDir, request, environment, processAdapter, onLine); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes(DRAINING)) throw error;
    await untilChatdGone(stateDir);
    return callChatdOnce(stateDir, request, environment, processAdapter, onLine);
  }
}

async function untilChatdGone(stateDir: string): Promise<void> {
  for (;;) {
    const local = instances.get(stateDir);
    if (local === undefined && !await socketAccepts(stateDir, 200)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export type ChatdStatus = Readonly<{ running: false } | { running: true; pid: number; protocol: number; build: number; draining: boolean; working: string[] }>;

/** The running chatd as it reports itself; never starts one. */
export async function chatdStatus(stateDir: string): Promise<ChatdStatus> {
  const local = instances.get(stateDir);
  if (local !== undefined) return { running: true, ...await local.handle({ operation: "daemon-status" }) as Omit<Extract<ChatdStatus, { running: true }>, "running"> };
  if (!existsSync(chatSocket(stateDir)) || !await socketAccepts(stateDir, DEFAULT_CONNECT_TIMEOUT_MS)) return { running: false };
  const status = object(await socketRequest(stateDir, { operation: "daemon-status" }, { connect: DEFAULT_CONNECT_TIMEOUT_MS, request: DEFAULT_REQUEST_TIMEOUT_MS }));
  return { running: true, pid: Number(status.pid), protocol: Number(status.protocol), build: Number(status.build), draining: status.draining === true, working: Array.isArray(status.working) ? status.working.filter((id): id is string => typeof id === "string") : [] };
}

/** Drains the running chatd and waits until it has exited: every turn finished, queued messages left for the next one. */
export async function drainChatd(stateDir: string): Promise<Readonly<{ running: false } | { running: true; drained: true; waitedMs: number; resumes: string[] }>> {
  const local = instances.get(stateDir);
  if (local === undefined && (!existsSync(chatSocket(stateDir)) || !await socketAccepts(stateDir, DEFAULT_CONNECT_TIMEOUT_MS))) return { running: false };
  const result = object(local === undefined
    ? await socketRequest(stateDir, { operation: "drain" }, { connect: DEFAULT_CONNECT_TIMEOUT_MS, request: undefined })
    : await local.handle({ operation: "drain" }));
  await untilChatdGone(stateDir);
  return { running: true, drained: true, waitedMs: Number(result.waitedMs), resumes: Array.isArray(result.resumes) ? result.resumes.filter((id): id is string => typeof id === "string") : [] };
}

async function callChatdOnce(stateDir: string, request: Request, environment: Environment, processAdapter: Starter, onLine?: (line: ChatLine) => void): Promise<unknown> {
  const local = instances.get(stateDir);
  if (local) return local.handle(request);
  const timeouts = timeoutsFor(environment);
  const dir = join(stateDir, "chatd");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const transportFailure = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ECONNREFUSED" || code === "ENOENT";
  };
  const requestWhenReady = async (): Promise<unknown> => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      try { return await socketRequest(stateDir, request, timeouts, onLine); }
      catch (error) {
        if (!transportFailure(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const ownerAlive = pidAlive(await filePid(chatLock(stateDir)));
    if (!ownerAlive) {
      try { await unlink(chatLock(stateDir)); } catch { /* another client cleaned it */ }
      await discardStaleState(stateDir, { pid: true });
      return callChatdOnce(stateDir, request, environment, processAdapter, onLine);
    }
    throw new Error("chatd did not become ready in time");
  };
  if (existsSync(chatSocket(stateDir))) {
    try {
      await ensureProtocol(stateDir, timeouts);
      return await socketRequest(stateDir, request, timeouts, onLine);
    }
    catch (error) {
      if (!transportFailure(error)) throw error;
      // The socket belongs to a dead chatd unless a starter holds a live lock; clean up and start one fresh daemon.
      if (!pidAlive(await filePid(chatLock(stateDir)))) {
        try { await unlink(chatLock(stateDir)); } catch { /* no lock */ }
        await discardStaleState(stateDir, { pid: true });
      }
    }
  }
  let lock;
  try {
    lock = await open(chatLock(stateDir), "wx", 0o600);
    await lock.writeFile(`${process.pid}\n`);
    await lock.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return requestWhenReady();
  }
  try {
    const invocation = selfInvocation(process.execPath, process.argv, ["__chatd"]);
    const launched = await processAdapter.startDetached(invocation.command, invocation.args, { env: { ...scrubAgentEnvironment({ ...process.env, ...environment }), MEGABRAIN_CHATD_STATE_DIR: stateDir } });
    if (launched.kind === "ok") return await requestWhenReady();
    // Embedded callers such as the test router share a process; production launches a detached owner.
    const daemon = new ChatDaemon(stateDir, environment);
    await daemon.start();
    await daemon.listen();
    instances.set(stateDir, daemon);
    try { await unlink(chatLock(stateDir)); } catch { /* already removed */ }
    return daemon.handle(request);
  } catch (error) {
    try { await unlink(chatLock(stateDir)); } catch { /* stale lock cleanup */ }
    throw error;
  }
}

export async function callPermissionServer(stateDir: string, chatId: string, request: Record<string, unknown>): Promise<unknown> {
  return socketRequest(stateDir, { operation: "permission", id: chatId, request }, { connect: DEFAULT_CONNECT_TIMEOUT_MS, request: undefined });
}
