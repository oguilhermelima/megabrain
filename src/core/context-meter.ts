import { open, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";

export type ContextMeter = Readonly<
  | { readonly status: "known"; readonly usedTokens: number; readonly percentUsed?: number; readonly sourceFrame: string }
  | { readonly status: "unknown" }
>;

export type ContextSubject = Readonly<{
  readonly agent: string;
  readonly agentThreadId?: string;
  readonly agentSessionId?: string;
  readonly agentCwd?: string;
  readonly grokHome?: string;
  /** Window of the launch model from the registry; outranks any inference from the transcript. */
  readonly contextWindow?: number;
}>;

const unknown: ContextMeter = { status: "unknown" };
const TAIL_BYTES = 512 * 1024;
const CLAUDE_WINDOW = 200_000;
const CLAUDE_LONG_WINDOW = 1_000_000;

async function readTail(path: string): Promise<string | undefined> {
  try {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function listNames(directory: string): Promise<string[]> {
  try { return await readdir(directory); } catch { return []; }
}

export async function findCodexRollout(home: string, threadId: string): Promise<string | undefined> {
  const root = join(home, ".codex", "sessions");
  for (const year of (await listNames(root)).sort().reverse()) {
    for (const month of (await listNames(join(root, year))).sort().reverse()) {
      for (const day of (await listNames(join(root, year, month))).sort().reverse()) {
        const file = (await listNames(join(root, year, month, day))).find((name) => name.startsWith("rollout-") && name.endsWith(`-${threadId}.jsonl`));
        if (file !== undefined) return join(root, year, month, day, file);
      }
    }
  }
  return undefined;
}

export async function findClaudeTranscript(home: string, sessionId: string): Promise<string | undefined> {
  const root = join(home, ".claude", "projects");
  for (const project of await listNames(root)) {
    if ((await listNames(join(root, project))).includes(`${sessionId}.jsonl`)) return join(root, project, `${sessionId}.jsonl`);
  }
  return undefined;
}

/** Match Grok's active session registry to a process inside the dispatch pane, never by recency. */
export async function resolveGrokSessionId(home: string, panePid: string, cwd: string, process: ProcessAdapter, grokHome = join(home, ".grok")): Promise<string | undefined> {
  if (!/^\d+$/.test(panePid) || cwd === "") return undefined;
  let active: unknown;
  try { active = JSON.parse(await readFile(join(grokHome, "active_sessions.json"), "utf8")) as unknown; }
  catch { return undefined; }
  if (!Array.isArray(active)) return undefined;
  const listed = await process.run("ps", ["-ax", "-o", "pid=,ppid=,command="]);
  if (listed.kind !== "ok") return undefined;
  const parents = new Map<string, string>();
  const commands = new Map<string, string>();
  for (const line of listed.value.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      parents.set(match[1], match[2]);
      commands.set(match[1], match[3]);
    }
  }
  const tree = new Set<string>();
  const pending = [panePid];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || tree.has(pid)) continue;
    tree.add(pid);
    for (const [candidate, parent] of parents) if (parent === pid) pending.push(candidate);
  }
  const grokPids = new Set([...tree].filter((pid) => {
    const executable = commands.get(pid)?.trim().split(/\s+/, 1)[0] ?? "";
    return basename(executable) === "grok";
  }));
  const matches = active.filter((item): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item)
    && typeof item.session_id === "string" && item.session_id !== ""
    && item.cwd === cwd && Number.isSafeInteger(item.pid) && grokPids.has(String(item.pid)));
  return matches.length === 1 ? String(matches[0]?.session_id) : undefined;
}

function records(tail: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const line of tail.split("\n").reverse()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) found.push(parsed as Record<string, unknown>);
    } catch { /* torn first line of a tail read, or a partial write */ }
  }
  return found;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function measured(source: string, used: number, window: number | undefined): ContextMeter {
  if (window === undefined) return { status: "known", usedTokens: used, sourceFrame: `${source}: ${used} tokens, window unknown` };
  if (window <= 0) return unknown;
  return { status: "known", usedTokens: used, percentUsed: Math.round((used / window) * 1000) / 10, sourceFrame: `${source}: ${used}/${window} tokens` };
}

function codexMeter(tail: string): ContextMeter {
  for (const entry of records(tail)) {
    const payload = object(entry.payload);
    if (entry.type !== "event_msg" || payload?.type !== "token_count") continue;
    const info = object(payload.info);
    if (info === undefined) continue;
    const used = count(object(info.last_token_usage)?.total_tokens);
    const window = count(info.model_context_window);
    if (used === undefined || window === undefined) return unknown;
    return measured("codex rollout token_count", used, window);
  }
  return unknown;
}

/** Tokens in the context for one assistant entry, or undefined when its usage is malformed. */
function claudeUsed(tokens: Record<string, unknown>): number | undefined {
  const parts = [tokens.input_tokens, tokens.cache_read_input_tokens, tokens.cache_creation_input_tokens].map((part) => part === undefined ? 0 : count(part));
  return parts.some((part) => part === undefined) ? undefined : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

/** The transcript's model id never says whether the window is 200k or 1M; only a [1m] marker or usage past 200k does. */
function claudeMeter(tail: string, registryWindow: number | undefined): ContextMeter {
  let latest: Readonly<{ used: number; model: string }> | undefined;
  let provenLong = false;
  for (const entry of records(tail)) {
    const message = object(entry.message);
    const tokens = object(message?.usage);
    if (entry.type !== "assistant" || entry.isSidechain === true || tokens === undefined) continue;
    const model = typeof message?.model === "string" ? message.model : "";
    if (model === "" || model.startsWith("<")) continue;
    const used = claudeUsed(tokens);
    if (used === undefined) { if (latest === undefined) return unknown; continue; }
    if (used > CLAUDE_WINDOW) provenLong = true;
    latest ??= { used, model };
  }
  if (latest === undefined) return unknown;
  const window = registryWindow ?? (/\[1m\]/i.test(latest.model) || provenLong ? CLAUDE_LONG_WINDOW : undefined);
  return measured("claude transcript usage", latest.used, window);
}

function grokMeter(tail: string, registryWindow: number | undefined): ContextMeter {
  for (const entry of records(tail)) {
    const params = object(entry.params);
    const update = object(params?.update);
    if (entry.method !== "_x.ai/session/update" || update?.sessionUpdate !== "turn_completed") continue;
    const used = count(object(update.usage)?.totalTokens);
    return used === undefined ? unknown : measured("grok session usage", used, registryWindow);
  }
  return unknown;
}

/** Context in use, read from the agent's own structured session file. Anything not observed there is unknown. */
export async function readContextMeter(subject: ContextSubject, home: string): Promise<ContextMeter> {
  if (subject.agent === "codex" && subject.agentThreadId !== undefined && subject.agentThreadId !== "") {
    const path = await findCodexRollout(home, subject.agentThreadId);
    const tail = path === undefined ? undefined : await readTail(path);
    return tail === undefined ? unknown : codexMeter(tail);
  }
  if (subject.agent === "claude" && subject.agentSessionId !== undefined && subject.agentSessionId !== "") {
    const path = await findClaudeTranscript(home, subject.agentSessionId);
    const tail = path === undefined ? undefined : await readTail(path);
    return tail === undefined ? unknown : claudeMeter(tail, subject.contextWindow);
  }
  if (subject.agent === "grok" && subject.agentSessionId !== undefined && subject.agentSessionId !== "" && subject.agentCwd !== undefined && subject.agentCwd !== "") {
    const session = join(subject.grokHome ?? join(home, ".grok"), "sessions", encodeURIComponent(subject.agentCwd), subject.agentSessionId, "updates.jsonl");
    const tail = await readTail(session);
    return tail === undefined ? unknown : grokMeter(tail, subject.contextWindow);
  }
  return unknown;
}
