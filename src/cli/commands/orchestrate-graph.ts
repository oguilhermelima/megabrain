import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ChatStore, type Chat } from "../../chat/store.js";
import { readContextMeter } from "../../core/context-meter.js";
import { listDispatches, listMessages, stateDatabase } from "../../adapters/state-db.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { usageText } from "../../core/usage.js";

type Agent = "claude" | "codex" | "grok" | "agy";
type Target = { session: string } | { chat: string };
type Env = Readonly<Record<string, string | undefined>>;
type Message = { type: "received" | "ask" | "reply" | "done" | "change" | "supervise" | "stalled"; text: string; at: string };
type Node = {
  id: string; kind: "coordinator" | "lane"; parent: string | null; label: string; agent: Agent; model: string | null; effort: string | null;
  state: "starting" | "working" | "asking" | "idle" | "done" | "closed" | "failed" | "stalled"; startedAt: string; endedAt: string | null;
  contextPercent: number | null; last: Message | null; finding: string | null; unanswered: boolean; worktree: string | null; branch: string | null;
  commits: number | null; chatId: string | null; session: string | null;
};
type Graph = { version: 1; focus: string; root: string; nodes: Node[]; events: Array<{ at: string; node: string; direction: "to-parent" | "to-child"; type: string; text: string }> };
type Dispatch = Record<string, unknown> & { dispatchId: string; state: string };

const agents = new Set<Agent>(["claude", "codex", "grok", "agy"]);
const string = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
const key = (agent: string, id: string): string => agent + ":" + id;
const nodeId = (session: string): string => "session:" + session;

function sessionOf(record: Dispatch): string | null {
  const agent = string(record.agent);
  if (agent === null || !agents.has(agent as Agent)) return null;
  const id = string(record.agentSessionId) ?? string(record.agentThreadId) ?? string(record.grokSessionId) ?? string(record.agySessionId) ?? string(record.sessionId);
  return id === null ? null : key(agent, id);
}

function messageType(value: string): Message["type"] | null {
  return ["received", "ask", "reply", "done", "change", "supervise", "stalled"].includes(value) ? value as Message["type"] : null;
}

function dispatchState(state: string, messages: readonly Record<string, unknown>[]): Node["state"] {
  const latest = messages.at(-1);
  if (latest?.type === "ask" && latest.from === "child") return "asking";
  if (state === "queued" || state === "spawning") return "starting";
  if (state === "running") return "working";
  if (state === "waiting_for_reply") return "idle";
  if (state === "done") return "done";
  if (state === "closed") return "closed";
  if (state === "failed" || state === "circuit_broken") return "failed";
  return latest?.type === "stalled" ? "stalled" : "failed";
}

function unanswered(messages: readonly Record<string, unknown>[]): boolean {
  let ask = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.from === "child" && message.type === "ask") ask = index;
    if (message?.from === "parent" && message.type === "reply" && ask >= 0) ask = -1;
  }
  return ask >= 0;
}

const commitCache = new Map<string, { at: number; count: number | null }>();
function commits(path: string | null, branch: string | null): number | null {
  if (path === null || branch === null || !existsSync(path)) return null;
  const cacheKey = path + "\0" + branch;
  const cached = commitCache.get(cacheKey);
  if (cached !== undefined && Date.now() - cached.at < 3000) return cached.count;
  const result = spawnSync("git", ["-C", path, "rev-list", "--count", "main.." + branch], { encoding: "utf8", timeout: 2000 });
  const parsed = result.status === 0 ? Number(result.stdout.trim()) : NaN;
  const count = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  commitCache.set(cacheKey, { at: Date.now(), count });
  return count;
}

function chatSession(chat: Chat): string | null {
  return chat.agentSessionId === null ? null : key(chat.agent, chat.agentSessionId);
}

function parentSession(record: Dispatch): string | null {
  const id = string(record.parentAgentSessionId) ?? string(record.parentAgentThreadId);
  const agent = string(record.parentAgent);
  return id === null || agent === null || !agents.has(agent as Agent) ? null : key(agent, id);
}

function coordinator(chat: Chat | undefined, session: string, id = nodeId(session)): Node {
  const [agentText, ...parts] = session.split(":");
  const agent = agents.has(agentText as Agent) ? agentText as Agent : "claude";
  const sessionId = parts.join(":");
  return {
    id, kind: "coordinator", parent: null, label: chat?.title ?? chat?.cwd ?? session, agent, model: chat?.model ?? null, effort: chat?.effort ?? null,
    state: chat?.state === "working" || chat?.state === "starting" ? chat.state : chat?.state === "error" ? "failed" : chat?.state === "idle" ? "idle" : "working",
    startedAt: chat?.createdAt ?? new Date(0).toISOString(), endedAt: null,
    contextPercent: typeof chat?.contextTokens === "number" && typeof chat.contextWindow === "number" && chat.contextWindow > 0 ? Math.min(100, Math.round(chat.contextTokens / chat.contextWindow * 100)) : null,
    last: null, finding: null, unanswered: false, worktree: null, branch: null, commits: null, chatId: chat?.id ?? null, session: sessionId === "chat" ? null : session,
  };
}

async function lane(record: Dispatch, parent: string, messages: Record<string, unknown>[], environment: Env): Promise<Node> {
  const agent = string(record.agent);
  const safeAgent = agents.has(agent as Agent) ? agent as Agent : "codex";
  const latest = [...messages].reverse().find((message) => messageType(String(message.type)) !== null);
  const type = latest === undefined ? null : messageType(String(latest.type));
  const text = latest === undefined ? null : string(latest.text);
  const last = type === null || text === null || latest === undefined ? null : { type, text: text.slice(0, 200), at: string(latest.createdAt) ?? string(record.updatedAt) ?? string(record.createdAt) ?? new Date(0).toISOString() };
  const supervise = [...messages].reverse().find((message) => message.type === "supervise");
  const findingObj = record.superviseFinding ?? supervise?.finding;
  const findingRecord = typeof findingObj === "object" && findingObj !== null ? findingObj as Record<string, unknown> : null;
  const cause = string(findingRecord?.cause) ?? string(supervise?.cause);
  const reset = string(findingRecord?.resetAt) ?? string(supervise?.resetAt);
  const finding = cause === null ? null : cause + (reset === null ? "" : "; resets at " + reset);
  const messagesForState = messages;
  const state = dispatchState(record.state, messagesForState);
  const startedAt = string(record.createdAt) ?? new Date(0).toISOString();
  const endedAt = ["done", "failed", "closed", "circuit_broken"].includes(record.state) ? string(record.updatedAt) : null;
  const worktree = string(record.worktreePath);
  const branch = string(record.branch);
  const explicitPercent = typeof record.contextPercent === "number" ? record.contextPercent
    : typeof record.contextTokens === "number" && typeof record.contextWindow === "number" && record.contextWindow > 0 ? record.contextTokens / record.contextWindow * 100 : null;
  const sessionId = sessionOf(record)?.slice(safeAgent.length + 1);
  const meter = explicitPercent === null && sessionId !== undefined && sessionId !== ""
    ? await readContextMeter({
      agent: safeAgent,
      ...(safeAgent === "codex" ? { agentThreadId: sessionId } : { agentSessionId: sessionId }),
      ...(worktree === null ? {} : { agentCwd: worktree }),
      ...(typeof record.agyLogFile === "string" ? { agyLogFile: record.agyLogFile } : {}),
      ...(environment.GROK_HOME === undefined ? {} : { grokHome: environment.GROK_HOME }),
    }, environment.HOME ?? resolveStateDirectory(environment))
    : { status: "unknown" as const };
  const contextPercent = explicitPercent !== null ? Math.max(0, Math.min(100, Math.round(explicitPercent)))
    : meter.status === "known" && meter.percentUsed !== undefined ? Math.max(0, Math.min(100, Math.round(meter.percentUsed))) : null;
  return {
    id: record.dispatchId, kind: "lane", parent, label: string(record.label) ?? string(record.chatName) ?? branch ?? record.dispatchId,
    agent: safeAgent, model: string(record.model), effort: string(record.effort), state, startedAt, endedAt, contextPercent, last, finding,
    unanswered: unanswered(messages), worktree, branch, commits: commits(worktree, branch), chatId: null,
    session: sessionOf(record),
  };
}

export async function buildOrchestrationGraph(target: Target, environment: Env): Promise<Graph> {
  const db = stateDatabase(environment);
  if (db.kind !== "ok") throw new Error(db.error);
  const stored = listDispatches(db.value, { includeArchived: true });
  if (stored.kind !== "ok") throw new Error(stored.error);
  const dispatches = stored.value as Dispatch[];
  const messagesById = new Map<string, Record<string, unknown>[]>();
  for (const item of dispatches) {
    const messages = listMessages(db.value, item.dispatchId);
    if (messages.kind !== "ok") throw new Error(messages.error);
    messagesById.set(item.dispatchId, messages.value as Record<string, unknown>[]);
  }
  const chats = await new ChatStore(resolveStateDirectory(environment)).list();
  let focusDispatch: Dispatch | undefined;
  let focusChat: Chat | undefined;
  let requestedSession: string;
  if ("chat" in target) {
    focusChat = chats.find((chat) => chat.id === target.chat) ?? undefined;
    if (focusChat === undefined) throw new Error("chat not found: " + target.chat);
    requestedSession = chatSession(focusChat) ?? ("chat:" + focusChat.id);
  } else {
    const split = target.session.indexOf(":");
    if (split < 1 || !agents.has(target.session.slice(0, split) as Agent) || split === target.session.length - 1) throw new Error("session must be <claude|codex|grok|agy>:<id>");
    requestedSession = target.session;
    focusDispatch = dispatches.find((item) => sessionOf(item) === requestedSession);
    focusChat = chats.find((chat) => chatSession(chat) === requestedSession);
  }
  let current = requestedSession;
  const ancestors = new Set<string>();
  let rootChat = focusChat;
  while (true) {
    if (ancestors.has(current)) break;
    ancestors.add(current);
    const child = dispatches.find((item) => sessionOf(item) === current) ?? (focusDispatch !== undefined && sessionOf(focusDispatch) === current ? focusDispatch : undefined);
    if (child === undefined) break;
    const parent = parentSession(child);
    if (parent === null) break;
    current = parent;
    rootChat = chats.find((chat) => chatSession(chat) === current) ?? rootChat;
  }
  const rootSession = current;
  const root = coordinator(rootChat, rootSession, rootSession.startsWith("chat:") ? "session:" + rootSession : nodeId(rootSession));
  const nodes: Node[] = [root];
  const events: Graph["events"] = [];
  const visited = new Set<string>();
  const addChildren = async (parentSessionValue: string, parentNodeId: string): Promise<void> => {
    for (const record of dispatches) {
      if (parentSession(record) !== parentSessionValue || visited.has(record.dispatchId)) continue;
      visited.add(record.dispatchId);
      const messages = messagesById.get(record.dispatchId) ?? [];
      const child = await lane(record, parentNodeId, messages, environment);
      nodes.push(child);
      for (const message of messages) {
        const type = messageType(String(message.type));
        const text = string(message.text);
        if (type === null || text === null || (message.from !== "child" && message.from !== "parent")) continue;
        events.push({ at: string(message.createdAt) ?? child.startedAt, node: child.id, direction: message.from === "child" ? "to-parent" : "to-child", type, text: text.slice(0, 200) });
      }
      const childSession = sessionOf(record);
      if (childSession !== null) await addChildren(childSession, child.id);
    }
  };
  await addChildren(rootSession, root.id);
  events.sort((a, b) => a.at.localeCompare(b.at));
  const focus = focusDispatch?.dispatchId ?? (focusChat === undefined ? nodeId(requestedSession) : root.id);
  return { version: 1, focus, root: root.id, nodes, events: events.slice(-200) };
}

export async function* followOrchestrationGraph(target: Target, environment: Env, options: { signal?: AbortSignal; intervalMs?: number } = {}): AsyncGenerator<Graph> {
  let previous = "";
  while (!options.signal?.aborted) {
    const graph = await buildOrchestrationGraph(target, environment);
    const snapshot = JSON.stringify(graph);
    if (snapshot !== previous) { previous = snapshot; yield graph; }
    await delay(options.intervalMs ?? 250, undefined, options.signal === undefined ? undefined : { signal: options.signal }).catch(() => undefined);
  }
}

function parse(args: readonly string[]): Result<{ target: Target; follow: boolean }> {
  if (args.includes("-h") || args.includes("--help")) return ok({ target: { session: "--help" }, follow: false });
  let chat: string | undefined; let session: string | undefined; let follow = false; let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--chat") chat = args[++i];
    else if (arg === "--session") session = args[++i];
    else if (arg === "--follow") follow = true;
    else if (arg === "--json") json = true;
    else return { kind: "failed", error: "unknown orchestrate graph option: " + arg, exitCode: 2 };
  }
  if (!json || (chat === undefined) === (session === undefined) || chat === "" || session === "") return failed(usageText("orchestrate-graph"), 2);
  if (chat !== undefined) return ok({ target: { chat }, follow });
  return ok({ target: { session: session as string }, follow });
}

export async function executeOrchestrateGraph(args: readonly string[], environment: Env): Promise<Result<string>> {
  const options = parse(args);
  if (options.kind !== "ok") return options;
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("orchestrate-graph"));
  if (!options.value.follow) {
    try { return ok(JSON.stringify(await buildOrchestrationGraph(options.value.target, environment)) + "\n"); }
    catch (cause) { return failed(cause instanceof Error ? cause.message : String(cause)); }
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  try {
    for await (const graph of followOrchestrationGraph(options.value.target, environment, { signal: controller.signal })) process.stdout.write(JSON.stringify(graph) + "\n");
    return ok("");
  } catch (cause) { return failed(cause instanceof Error ? cause.message : String(cause)); }
  finally { process.removeListener("SIGINT", stop); }
}
