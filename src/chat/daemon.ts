import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ChatStore, type Chat, type ChatApproval, type ChatEvent, type ChatLine } from "./store.js";
import { chatProtocolAdapters, type MessagePart } from "./protocol.js";

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
function event(kind: ChatEvent["kind"], value: string, tool?: ChatEvent["tool"]): ChatEvent {
  return { id: randomUUID(), at: new Date().toISOString(), kind, text: value, ...(tool === undefined ? {} : { tool }) };
}

/** Owns every chat child. The CLI is a short-lived socket client; chatd keeps this object alive. */
export class ChatDaemon {
  readonly store: ChatStore;
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly queues = new Map<string, Part[][]>();
  private readonly activeTurns = new Map<string, string>();
  private readonly interrupting = new Set<string>();
  private readonly interruptedEvents = new Set<string>();
  private readonly pendingApprovals = new Map<string, { approval: ChatApproval; resolve: (decision: string) => void }>();
  private readonly subscribers = new Map<string, Set<(line: ChatLine) => void>>();
  private readonly eventChains = new Map<string, Promise<void>>();
  private readonly startTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly outputSeen = new Set<string>();
  private readonly appendChains = new Map<string, Promise<unknown>>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private clients = 0;
  private closed = false;
  constructor(readonly stateDir: string, readonly environment: Environment = process.env) { this.store = new ChatStore(stateDir); }

  async start(): Promise<void> {
    const dir = join(this.stateDir, "chatd");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    if (await socketAccepts(this.stateDir, DEFAULT_CONNECT_TIMEOUT_MS)) throw new Error("chatd is already running");
    await discardStaleState(this.stateDir, { pid: true });
    await this.store.initialize();
    for (const chat of await this.store.list()) {
      if (chat.state !== "stopped" && chat.state !== "error") {
        chat.state = "stopped";
        chat.error = null;
        await this.store.put(chat);
      }
    }
    await writeFile(chatPid(this.stateDir), `${process.pid}\n`, { mode: 0o600 });
    await chmod(chatPid(this.stateDir), 0o600);
  }

  async handle(request: Request, socket?: Socket): Promise<unknown> {
    this.clients += 1;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    try {
      switch (request.operation) {
        case "list":
          await Promise.all([...this.eventChains.values(), ...this.appendChains.values()]);
          return await this.store.list();
        case "start": return await this.startChat(request);
        case "send": return await this.send(text(request.id), validateParts(request.parts));
        case "interrupt": return await this.interrupt(text(request.id));
        case "stop": return await this.stop(text(request.id));
        case "approve": return await this.approve(text(request.id), text(request.approvalId), text(request.decision));
        case "events": return await this.events(text(request.id), Number(request.since ?? 0), request.follow === true, socket);
        case "mode": return await this.mode(text(request.id), text(request.mode));
        case "model": return await this.setModel(text(request.id), text(request.model), text(request.effort) || null);
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
    const agent = text(request.agent);
    if (agent !== "claude" && agent !== "codex") throw new Error("--agent must be claude or codex");
    const cwd = text(request.cwd);
    if (!cwd || !cwd.startsWith("/")) throw new Error("--cwd must be an absolute path");
    const parts = request.parts === undefined ? [] : await this.normalizeParts(cwd, validateParts(request.parts));
    const now = new Date().toISOString();
    const chat: Chat = {
      id: randomUUID(), agent, cwd, model: text(request.model) || null, ...(request.approvals === true ? { approvals: true } : {}),
      title: firstText(parts).slice(0, 120) || null, state: "starting", mode: "chat",
      agentSessionId: null, createdAt: now, lastActivityAt: now, error: null,
    };
    await this.store.put(chat);
    await this.publish(chat, event("system", `Started ${agent} chat`));
    const queue = this.queues.get(chat.id) ?? [];
    if (parts.length > 0) { queue.push(parts); this.queues.set(chat.id, queue); await this.publish(chat, event("user", firstText(parts))); }
    void this.runAgent(chat).catch((error: unknown) => this.fail(chat.id, error));
    return chat;
  }

  private async send(id: string, inputParts: Part[]): Promise<void> {
    const chat = await this.requireChat(id);
    const parts = await this.normalizeParts(chat.cwd, inputParts);
    if (chat.state === "stopped" || chat.mode !== "chat") throw new Error("chat is stopped or in terminal mode");
    const textValue = firstText(parts);
    if (chat.title === null && textValue !== "") chat.title = textValue.slice(0, 120);
    chat.lastActivityAt = new Date().toISOString();
    await this.store.put(chat);
    await this.publish(chat, event("user", textValue));
    this.interrupting.delete(id);
    this.interruptedEvents.delete(id);
    if (chat.agent === "codex" && chat.state === "working" && this.activeTurns.has(id)) {
      const child = this.children.get(id);
      const turnId = this.activeTurns.get(id);
      if (child && turnId) chatProtocolAdapters[chat.agent].steer(chat, child, turnId, parts, (method, params) => this.codexRequest(child, method, params)).catch((error) => this.fail(id, error));
      return;
    }
    const queue = this.queues.get(id) ?? [];
    queue.push(parts);
    this.queues.set(id, queue);
    if (chat.agent === "claude" && chat.state === "working") return;
    if (!this.children.has(id) && chat.state === "idle") {
      chat.state = "starting";
      await this.store.put(chat);
      void this.runAgent(chat).catch((error) => this.fail(id, error));
      return;
    }
    await this.drain(id);
  }

  private async runAgent(chat: Chat): Promise<void> {
    const invocation = await chatProtocolAdapters[chat.agent].prepare(chat, this.stateDir);
    const child = spawn(invocation.command, invocation.args, { cwd: chat.cwd, env: { ...process.env, ...this.environment }, stdio: ["pipe", "pipe", "pipe"] });
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
      void this.store.get(chat.id).then(async (current) => {
        if (!current || current.state === "stopped" || current.mode === "terminal") return;
        if (this.interrupting.has(chat.id)) {
          this.interrupting.delete(chat.id);
          current.state = "idle";
          current.error = null;
          await this.store.put(current);
          await this.publishInterrupted(current);
          return;
        }
        current.state = code === 0 ? "idle" : "stopped";
        current.error = code === 0 ? null : `${signal ?? "agent exited"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
        await this.store.put(current);
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
      await this.store.put(current);
      await this.drain(chat.id);
    } else {
      // Claude prints system/init only after its first user line, so queued input goes out now.
      // With nothing queued the chat stays starting until init or the first send, which writes to the open stdin.
      await this.drain(chat.id);
    }
  }

  private async handleClaude(id: string, child: ChildProcessWithoutNullStreams, item: Record<string, unknown>): Promise<void> {
    const chat = await this.requireChat(id);
    if (item.type === "system" && item.subtype === "init") {
      if (typeof item.session_id === "string") chat.agentSessionId = item.session_id;
      if (chat.state === "starting") chat.state = "idle";
      await this.store.put(chat);
      await this.drain(id);
      return;
    }
    if (item.type === "assistant") {
      const message = object(item.message);
      this.updateContext(chat, object(message.usage));
      await this.store.put(chat);
      const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
      const textValue = blocks.filter((block) => block.type === "text").map((block) => text(block.text)).join("");
      const thinking = blocks.filter((block) => block.type === "thinking").map((block) => text(block.thinking)).join("");
      if (thinking) await this.publish(chat, event("thinking", thinking));
      if (textValue) await this.publish(chat, event("assistant", textValue));
      return;
    }
    if (item.type === "result") {
      if (typeof item.session_id === "string") chat.agentSessionId = item.session_id;
      this.updateContext(chat, object(item.usage));
      const modelUsage = object(item.modelUsage);
      const modelUsageEntry = object(modelUsage[chat.model ?? ""] ?? Object.values(modelUsage)[0]);
      const window = modelUsageEntry.contextWindow;
      if (typeof window === "number" && Number.isSafeInteger(window) && window > 0) chat.contextWindow = window;
      chat.state = item.is_error === true ? "idle" : "idle";
      chat.error = null;
      chat.lastActivityAt = new Date().toISOString();
      await this.store.put(chat);
      if (item.is_error === true && this.interrupting.has(id)) this.interrupting.delete(id);
      await this.drain(id);
    }
    if (item.type === "control_request") {
      const request = object(item.request);
      if (request.subtype === "can_use_tool") await this.createApproval(chat, text(request.tool_name), JSON.stringify(request.input ?? {}), text(request.tool_use_id));
    }
  }

  private async handleCodex(id: string, child: ChildProcessWithoutNullStreams, item: Record<string, unknown>): Promise<void> {
    if (typeof item.id === "number" && ("result" in item || "error" in item)) {
      const waiter = this.rpcWaiters.get(id)?.get(item.id);
      if (waiter) { this.rpcWaiters.get(id)?.delete(item.id); item.error ? waiter.reject(new Error(text(object(item.error).message) || "Codex request failed")) : waiter.resolve(item.result); }
      return;
    }
    const method = text(item.method);
    const params = object(item.params);
    const chat = await this.requireChat(id);
    if (method === "thread/tokenUsage/updated") {
      const usage = object(params.tokenUsage);
      const last = object(usage.last ?? usage.total);
      const count = last.inputTokens;
      const window = usage.modelContextWindow;
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) chat.contextTokens = count;
      if (typeof window === "number" && Number.isSafeInteger(window) && window > 0) chat.contextWindow = window;
      await this.store.put(chat);
    } else if (method.includes("reasoning") || method.includes("thinking")) await this.publish(chat, event("thinking", text(params.delta ?? params.text)));
    else if (method.includes("agentMessage") || method.includes("assistantMessage")) await this.publish(chat, event("assistant", text(params.delta ?? params.text)));
    else if (method === "item/started") {
      const itemData = object(params.item);
      if (text(itemData.type).toLowerCase().includes("command")) await this.publish(chat, event("tool-call", text(itemData.command), { name: "command", input: text(itemData.command) }));
    } else if (method === "item/completed") {
      const itemData = object(params.item);
      const type = text(itemData.type).toLowerCase();
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
      await this.store.put(chat);
    } else if (method === "turn/completed") {
      this.activeTurns.delete(id);
      chat.state = "idle";
      await this.store.put(chat);
      if (text(object(params.turn).status) === "interrupted" && this.interrupting.has(id)) {
        this.interrupting.delete(id);
        await this.publishInterrupted(chat);
      }
      await this.drain(id);
    }
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

  private async drain(id: string): Promise<void> {
    const queue = this.queues.get(id);
    const child = this.children.get(id);
    const chat = await this.store.get(id);
    if (!queue || queue.length === 0 || !child || !chat || chat.state === "working" || chat.state === "waiting-approval") return;
    const parts = queue.shift() as Part[];
    if (queue.length === 0) this.queues.delete(id);
    chat.state = "working";
    await this.store.put(chat);
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
    if (chat.agent === "claude") {
      this.interrupting.add(id);
      chat.state = "idle";
      await this.store.put(chat);
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
        await this.store.put(chat);
        await this.publishInterrupted(chat);
      }
    }
  }

  private async stop(id: string): Promise<void> {
    const chat = await this.requireChat(id);
    const child = this.children.get(id);
    if (child) { child.kill("SIGTERM"); this.children.delete(id); }
    chat.state = "stopped";
    chat.lastActivityAt = new Date().toISOString();
    await this.store.put(chat);
    await this.publish(chat, event("system", "Stopped"));
  }

  private async mode(id: string, mode: string): Promise<{ chat: Chat; terminal: null }> {
    const chat = await this.requireChat(id);
    if (mode !== "chat" && mode !== "terminal") throw new Error("mode must be chat or terminal");
    if (mode === "terminal" && chat.state !== "idle") throw new Error(`cannot switch to terminal while chat is ${chat.state}; wait until it is idle`);
    if (mode === "terminal") {
      const child = this.children.get(id);
      if (child) { child.kill("SIGTERM"); this.children.delete(id); }
      chat.mode = "terminal";
      chat.state = "idle";
    } else if (chat.mode === "terminal") {
      chat.mode = "chat";
      chat.state = "starting";
      await this.store.put(chat);
      void this.runAgent(chat).catch((error) => this.fail(id, error));
    }
    await this.store.put(chat);
    return { chat, terminal: null };
  }

  private async terminalCommand(id: string): Promise<string[]> {
    const chat = await this.requireChat(id);
    if (!chat.agentSessionId) throw new Error("chat has no agent session to resume yet");
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
    if (chat.state !== "idle" || chat.mode !== "chat") throw new Error(`cannot change the model while chat is ${chat.state}; wait until it is idle`);
    chat.model = model;
    if (effort !== null) chat.effort = effort;
    chat.lastActivityAt = new Date().toISOString();
    if (chat.agent === "claude") {
      const child = this.children.get(id);
      if (child) { this.children.delete(id); child.kill("SIGTERM"); }
      chat.state = "starting";
      await this.store.put(chat);
      void this.runAgent(chat).catch((error) => this.fail(id, error));
    } else await this.store.put(chat);
    await this.publish(chat, event("system", `Model set to ${model}${effort ? ` (${effort})` : ""}`));
    return chat;
  }

  private async events(id: string, since: number, follow: boolean, socket?: Socket): Promise<ChatLine[]> {
    const chat = await this.requireChat(id);
    if (socket) {
      socket.write(`${JSON.stringify({ cursor: String(since), chat })}\n`);
      if (follow) {
        const listeners = this.subscribers.get(id) ?? new Set();
        let cursor = since;
        let replaying = true;
        const pending: ChatLine[] = [];
        const write = (line: ChatLine) => {
          const next = Number(line.cursor);
          if (!Number.isSafeInteger(next) || next <= cursor) return;
          socket.write(`${JSON.stringify(line)}\n`);
          cursor = next;
        };
        const listener = (line: ChatLine) => replaying ? pending.push(line) : write(line);
        listeners.add(listener); this.subscribers.set(id, listeners);
        socket.once("close", () => { listeners.delete(listener); });
        try {
          for (const line of await this.store.events(id, since)) write(line);
          for (let index = 0; index < pending.length; index += 1) write(pending[index] as ChatLine);
          replaying = false;
        } catch (error) {
          listeners.delete(listener);
          throw error;
        }
        return [];
      }
      for (const line of await this.store.events(id, since)) socket.write(`${JSON.stringify(line)}\n`);
    }
    return [{ cursor: String(since), chat }, ...await this.store.events(id, since)];
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
    await this.store.put(chat);
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
    await this.store.put(chat);
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
  private async publish(chat: Chat, value: ChatEvent, approval?: ChatApproval): Promise<void> {
    const previous = this.appendChains.get(chat.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const line = await this.store.append(chat.id, value, approval);
      for (const listener of this.subscribers.get(chat.id) ?? []) listener(line);
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
    await this.store.put(chat);
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
    this.server?.close();
    this.server = undefined;
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

/** A compiled binary reports a virtual /$bunfs/ script in argv[1]; only a real script path is passed on. */
export function chatdInvocation(execPath: string, argv: readonly string[]): { command: string; args: string[] } {
  const script = argv[1];
  const entryArguments = script !== undefined && !script.startsWith("/$bunfs/") ? [script] : [];
  return { command: execPath, args: [...entryArguments, "__chatd"] };
}

export async function callChatd(stateDir: string, request: Request, environment: Environment, processAdapter: { startDetached(command: string, args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<{ kind: string; error?: string }> }, onLine?: (line: ChatLine) => void): Promise<unknown> {
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
      return callChatd(stateDir, request, environment, processAdapter, onLine);
    }
    throw new Error("chatd did not become ready in time");
  };
  if (existsSync(chatSocket(stateDir))) {
    try { return await socketRequest(stateDir, request, timeouts, onLine); }
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
    const invocation = chatdInvocation(process.execPath, process.argv);
    const launched = await processAdapter.startDetached(invocation.command, invocation.args, { env: { ...environment, MEGABRAIN_CHATD_STATE_DIR: stateDir } });
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
