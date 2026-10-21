import { existsSync } from "node:fs";
import { open as openFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { openDatabaseReadOnly } from "../../db/db.js";
import { listDispatches } from "../../db/queries/dispatches.js";
import { getRepositoryPullRequests, listRepositories, type RepositoryRecord } from "../../db/queries/repositories.js";
import { callStateOwner } from "../../db/state-owner.js";
import type { DatabaseAdapter } from "../../db/db.js";
import { listWorktrees } from "../../db/queries/worktrees.js";
import { repositoryCheckout } from "../../core/project-registry.js";
import { readContextMeter } from "../../core/context-meter.js";
import { listHiddenItems } from "../../db/queries/hidden-items.js";
import { OWNED_TMUX_SERVER } from "../../core/session-ownership.js";
import { promoteConversation, readConversations, sessionKey, type ConversationRegistry } from "../../core/conversations.js";
import { agyConversationIndex, sessionHistory, type HistorySession } from "../../adapters/session-history.js";
import { ChatStore, type Chat } from "../../chat/store.js";
import { appHost, appTarget, inferSessionHost, readAppPanes, readProcessTable, type ProcessTable } from "../../core/session-origin.js";
import { loadAndPersistModelRegistry, contextWindowOf, type ModelRegistry } from "../../core/model.js";
import { resolveStateDirectory } from "../../core/state.js";
import { readArchivedWorktrees } from "../../core/archived-worktrees.js";
import { readProjectAppearance } from "../../core/project-appearance.js";
import { selfInvocation } from "../../core/self-invocation.js";

type Environment = Readonly<Record<string, string | undefined>>;
type SessionStatus = "working" | "idle" | "waiting" | "ended";
type ConversationOwner = "app-chat" | "app-terminal" | "dispatch" | "foreign";
type ProjectSession = Readonly<{ agent: "claude" | "codex" | "grok" | "agy"; sessionId: string; title: string; status: SessionStatus; startedAt: string | null; lastActivityAt: string | null; dispatchId: string | null; model: string | null; contextWindow: number | null; contextTokens?: number | null; owner: "megabrain" | "external"; origin: "megabrain" | "external"; conversationOwner: ConversationOwner; host: string; parent: string | null; chatId?: string | null; tmuxServer?: string; tmuxSession?: string; terminalPid?: number; cacheExpiresAt?: string | null; idleCompactAt?: string | null }>;
type GitWorktree = Readonly<{ path: string; branch: string | null; head: string | null; primary: boolean; parent: string | null }>;
type Project = Readonly<{ name: string; path: string; remote: string | null; source: "megabrain" | "import"; missing: boolean; worktrees: readonly (GitWorktree & { pullRequest: PullRequestSummary | null; sessions: readonly ProjectSession[] })[] }>;
type Dispatch = ReturnType<typeof listDispatches>[number];
export type RawSession = Readonly<{ agent: ProjectSession["agent"]; id: string; cwd: string; title: string; status: SessionStatus; startedAt: string | null; lastActivityAt: string | null; processId?: number; model?: string | null; contextWindow?: number | null }>;

type ClaudeLogDetails = Readonly<{ model: string | null; contextWindow: number | null; contextTokens: number | null }>;
const claudeLogCache = new Map<string, Readonly<{ signature: string; value: ClaudeLogDetails }>>();

// title and isDraft are null for a value cached before they were read; the cache keeps gh's own JSON.
type PullRequestSummary = Readonly<{ number: number; state: string; url: string; title: string | null; isDraft: boolean | null }>;

const HISTORY_MARKER = "project-registry-backfilled";
const DAY = 86_400_000;
// Codex rollouts are cheap to list and its sessions are resumed over days, so its ended sessions reach further back.
const CODEX_WINDOW = 7 * DAY;
const recentWindow = (agent: ProjectSession["agent"]): number => agent === "codex" ? CODEX_WINDOW : DAY;
const PULL_REQUEST_CACHE_TTL = 60_000;
const PROJECT_CACHE_FILE = "projects-derived-cache.json";
type ProjectCache = {
  version: 1;
  worktrees: Record<string, { headMtimeMs: number; indexMtimeMs: number; configMtimeMs: number; primary: boolean; parent: string | null }>;
  sessions: Record<string, { path: string; size: number; mtimeMs: number; title: string | null; codex?: CodexRollout | null }>;
};
// What a Codex rollout's head and tail say; it only changes when the file does, so it is cached by path, size and mtime.
type CodexRollout = Readonly<{ id: string; cwd: string; title: string | null; startedAt: string | null; model: string | null; contextWindow: number | null }>;

function emptyProjectCache(): ProjectCache { return { version: 1, worktrees: {}, sessions: {} }; }

async function readProjectCache(environment: Environment): Promise<ProjectCache> {
  try {
    const value: unknown = JSON.parse(await readFile(join(resolveStateDirectory(environment), PROJECT_CACHE_FILE), "utf8"));
    if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1) return emptyProjectCache();
    const cache = value as Partial<ProjectCache>;
    return { version: 1, worktrees: cache.worktrees ?? {}, sessions: cache.sessions ?? {} };
  } catch { return emptyProjectCache(); }
}

async function writeProjectCache(environment: Environment, cache: ProjectCache): Promise<void> {
  const directory = resolveStateDirectory(environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, PROJECT_CACHE_FILE);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch { await unlink(temporary).catch(() => undefined); }
}

function logCacheKey(path: string, size: number, mtimeMs: number): string {
  return createHash("sha256").update(`${path}\0${size}\0${mtimeMs}`).digest("hex");
}

async function cachedClaudeTitle(cache: ProjectCache, home: string, cwd: string, sessionId: string): Promise<string | undefined> {
  const path = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  try {
    const info = await stat(path);
    const key = logCacheKey(path, info.size, info.mtimeMs);
    const saved = cache.sessions[key];
    if (saved !== undefined) return saved.title ?? undefined;
    const title = await claudeTitle(home, cwd, sessionId);
    for (const [oldKey, entry] of Object.entries(cache.sessions)) if (entry.path === path) delete cache.sessions[oldKey];
    cache.sessions[key] = { path, size: info.size, mtimeMs: info.mtimeMs, title: title ?? null };
    return title;
  } catch { return claudeTitle(home, cwd, sessionId); }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (cause: unknown) { return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPERM"; }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string" && value[key] !== "") return value[key] as string;
  return undefined;
}

export function iso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

export function userTitle(value: unknown): string | undefined {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, 80) || undefined;
  if (Array.isArray(value)) {
    const text = value.filter((part) => typeof part === "object" && part !== null && ["text", "input_text", "output_text"].includes(String((part as Record<string, unknown>).type)))
      .map((part) => (part as Record<string, unknown>).text).filter((part): part is string => typeof part === "string").join(" ");
    return userTitle(text);
  }
  return undefined;
}

export async function claudeTitle(home: string, cwd: string, sessionId: string): Promise<string | undefined> {
  const project = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  let file: FileHandle | undefined;
  try {
    file = await openFile(join(project, `${sessionId}.jsonl`), "r");
    const handle = file;
    const info = await handle.stat();
    const readWindow = async (start: number, length: number): Promise<string> => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead).toString("utf8");
    };
    const titleIn = (contents: string): string | undefined => {
      let title: string | undefined;
      for (const line of contents.split("\n")) {
        try {
          const entry = record(JSON.parse(line) as unknown);
          if (entry?.type === "ai-title") title = userTitle(entry.aiTitle) ?? title;
        } catch { /* Ignore partial and non-JSON transcript lines. */ }
      }
      return title;
    };
    const tailStart = Math.max(0, info.size - 512 * 1024);
    const aiTitle = titleIn(await readWindow(tailStart, info.size - tailStart));
    if (aiTitle !== undefined) return aiTitle;
    const head = await readWindow(0, Math.min(info.size, 256 * 1024));
    const headTitle = titleIn(head);
    if (headTitle !== undefined) return headTitle;
    for (const line of head.split("\n")) {
      try {
        const entry = record(JSON.parse(line) as unknown);
        if (entry?.type !== "user") continue;
        const message = record(entry.message);
        const title = userTitle(message?.content);
        if (title !== undefined) return title;
      } catch { /* Ignore partial and non-JSON transcript lines. */ }
    }
  } catch { /* The session has no local transcript. */ }
  finally { await file?.close().catch(() => undefined); }
  return undefined;
}

async function claudeModelSettings(home: string, cwd: string): Promise<{ readonly paths: string[]; readonly models: string[] }> {
  const globalSettings = join(home, ".claude", "settings.json");
  const projectSettings = join(cwd, ".claude");
  const files = await readdir(projectSettings).catch(() => []);
  const paths = [globalSettings, ...files.filter((name) => /^settings.*\.json$/.test(name)).map((name) => join(projectSettings, name))];
  const models: string[] = [];
  for (const path of paths) {
    try {
      const settings = record(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (typeof settings?.model === "string") models.push(settings.model);
    } catch { /* Missing or invalid settings do not provide model evidence. */ }
  }
  return { paths, models };
}

async function claudeLogDetails(home: string, cwd: string, sessionId: string, registry: ModelRegistry): Promise<ClaudeLogDetails> {
  const path = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  const settings = await claudeModelSettings(home, cwd);
  let logStat: { size: number; mtimeMs: number };
  try { logStat = await stat(path); } catch { return { model: null, contextWindow: null, contextTokens: null }; }
  const signatures = await Promise.all(settings.paths.map(async (settingPath) => {
    try { const info = await stat(settingPath); return `${info.size}:${info.mtimeMs}`; } catch { return "missing"; }
  }));
  const signature = `${logStat.size}:${logStat.mtimeMs}|${signatures.join("|")}`;
  const cached = claudeLogCache.get(path);
  if (cached?.signature === signature) return cached.value;

  let latestModel: string | null = null;
  let latestUsage: number | null = null;
  let provedLong = false;
  let boundarySeen = false;
  let handle: FileHandle | undefined;
  try {
    handle = await openFile(path, "r");
    const start = Math.max(0, logStat.size - 512 * 1024);
    const buffer = Buffer.alloc(logStat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n").reverse()) {
      try {
        const entry = record(JSON.parse(line) as unknown);
        if (!boundarySeen && entry?.type === "system" && entry.subtype === "compact_boundary") {
          boundarySeen = true;
          // Usage recorded before the latest compact boundary describes the old context.
          const meta = record(entry.compactMetadata);
          if (typeof meta?.preTokens === "number" && meta.preTokens > 200000) provedLong = true;
          if (latestUsage === null) latestUsage = typeof meta?.postTokens === "number" && Number.isSafeInteger(meta.postTokens) && meta.postTokens >= 0 ? meta.postTokens : 0;
        }
        if (entry?.type !== "assistant" || entry.isSidechain === true) continue;
        const message = record(entry.message);
        if (latestModel === null && typeof message?.model === "string" && message.model !== "") latestModel = message.model;
        const usage = record(message?.usage);
        if (latestUsage === null && usage !== undefined) {
          const values = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].map((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : value === undefined ? 0 : Number.NaN);
          if (values.every(Number.isFinite)) latestUsage = values.reduce((sum, value) => sum + value, 0);
        }
        if (latestModel !== null && boundarySeen) break;
      } catch { /* Ignore partial lines and malformed entries. */ }
    }
  } catch { /* Transcript details are optional for a project session. */ }
  finally { await handle?.close().catch(() => undefined); }

  const settingsLong = settings.models.some((model) => /\[1m\]/i.test(model));
  const modelEntry = latestModel === null ? undefined : registry.models.find((entry) => entry.agent === "claude" && entry.model === latestModel?.replace(/\[1m\]$/i, ""));
  const supported = Array.isArray(modelEntry?.contextWindows) ? modelEntry.contextWindows.filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0) : [];
  const defaultWindow = supported[0] ?? contextWindowOf(registry, "claude", latestModel?.replace(/\[1m\]$/i, "") ?? "");
  const contextWindow = provedLong || latestUsage !== null && latestUsage > 200000 || latestModel !== null && /\[1m\]/i.test(latestModel) || settingsLong
    ? 1000000 : defaultWindow ?? null;
  const value = { model: latestModel, contextWindow, contextTokens: latestUsage };
  if (claudeLogCache.size >= 512) claudeLogCache.delete(claudeLogCache.keys().next().value as string);
  claudeLogCache.set(path, { signature, value });
  return value;
}

export async function codexSessionTitles(home: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  let contents: string;
  try { contents = await readFile(join(home, ".codex", "session_index.jsonl"), "utf8"); }
  catch { return titles; }
  for (const line of contents.split("\n")) {
    try {
      const entry = record(JSON.parse(line) as unknown);
      const id = stringField(entry ?? {}, "id");
      const title = userTitle(entry?.thread_name);
      if (id !== undefined && title !== undefined) titles.set(id, title);
    } catch { /* Ignore malformed index rows. */ }
  }
  return titles;
}

async function claudeSessions(home: string, cache: ProjectCache): Promise<RawSession[]> {
  const directory = join(home, ".claude", "sessions");
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const now = Date.now();
  const found = await Promise.all(names.filter((name) => /^\d+\.json$/.test(name)).map(async (name): Promise<RawSession | undefined> => {
    try {
      const value = record(JSON.parse(await readFile(join(directory, name), "utf8")) as unknown);
      const pid = Number(name.slice(0, -5));
      if (value === undefined || value.pid !== pid) return undefined;
      const cwd = stringField(value, "cwd");
      const id = stringField(value, "sessionId");
      if (cwd === undefined || id === undefined) return undefined;
      const live = processIsAlive(pid);
      const rawStatus = stringField(value, "status") ?? "";
      const status: SessionStatus = !live ? "ended" : rawStatus === "waiting" || value.waitingFor !== undefined ? "waiting"
        : rawStatus === "idle" ? "idle" : "working";
      const startedAt = iso(value.startedAt);
      const lastActivityAt = iso(value.updatedAt) ?? iso(value.statusUpdatedAt) ?? startedAt;
      if (status === "ended" && (lastActivityAt === null || now - Date.parse(lastActivityAt) > DAY)) return undefined;
      const explicitTitle = (value.nameSource === "user" || value.nameSource === "auto") ? userTitle(value.name) : undefined;
      const title = explicitTitle ?? await cachedClaudeTitle(cache, home, cwd, id) ?? "Claude";
      return { agent: "claude", id, cwd: resolve(cwd), title: title.slice(0, 80), status, startedAt, lastActivityAt, processId: pid };
    } catch { return undefined; }
  }));
  return found.filter((value): value is RawSession => value !== undefined);
}

async function grokLogActivity(home: string, cwd: string, sessionId: string): Promise<string | null> {
  const path = join(home, ".grok", "sessions", encodeURIComponent(cwd), sessionId, "updates.jsonl");
  let file: FileHandle | undefined;
  try {
    file = await openFile(path, "r");
    const info = await file.stat();
    const start = Math.max(0, info.size - 65_536);
    const buffer = Buffer.alloc(info.size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n").reverse()) {
      try {
        const entry = record(JSON.parse(line) as unknown);
        const timestamp = iso(entry?.timestamp) ?? iso(entry?.updated_at) ?? iso(entry?.updatedAt);
        if (timestamp !== null) return timestamp;
      } catch { /* Ignore partial and non-JSON tail lines. */ }
    }
  } catch { /* Session logs are optional and may be rotated. */ }
  finally { await file?.close().catch(() => undefined); }
  return null;
}

export async function grokUserTitle(home: string, cwd: string, sessionId: string): Promise<string | undefined> {
  const path = join(home, ".grok", "sessions", encodeURIComponent(cwd), sessionId, "updates.jsonl");
  let file;
  try {
    file = await openFile(path, "r");
    const info = await file.stat();
    const buffer = Buffer.alloc(Math.min(info.size, 256 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      try {
        const entry = record(JSON.parse(line) as unknown);
        const params = record(entry?.params);
        const update = record(params?.update);
        if (update?.sessionUpdate !== "user_message_chunk") continue;
        const content = record(update.content);
        const title = userTitle(content?.text ?? content?.content ?? update.text);
        if (title !== undefined) return title;
      } catch { /* Ignore partial and non-JSON transcript lines. */ }
    }
  } catch { /* Session logs are optional and may be rotated. */ }
  finally { await file?.close().catch(() => undefined); }
  return undefined;
}

async function grokSessions(home: string): Promise<RawSession[]> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(home, ".grok", "active_sessions.json"), "utf8")) as unknown; }
  catch { return []; }
  if (!Array.isArray(value)) return [];
  const now = Date.now();
  return (await Promise.all(value.map(async (item): Promise<RawSession | undefined> => {
    const entry = record(item);
    if (entry === undefined) return undefined;
    const id = stringField(entry, "session_id", "sessionId");
    const cwd = stringField(entry, "cwd");
    if (id === undefined || cwd === undefined) return undefined;
    const pid = typeof entry.pid === "number" ? entry.pid : undefined;
    const live = pid === undefined || processIsAlive(pid);
    const lastActivityAt = iso(entry.updatedAt) ?? iso(entry.updated_at) ?? iso(entry.timestamp) ?? await grokLogActivity(home, cwd, id) ?? iso(entry.started_at);
    const statusValue = stringField(entry, "status") ?? "";
    const status: SessionStatus = !live || statusValue === "ended" ? "ended" : statusValue === "waiting" ? "waiting" : statusValue === "idle" ? "idle" : "working";
    if (status === "ended" && (lastActivityAt === null || now - Date.parse(lastActivityAt) > DAY)) return undefined;
    const title = userTitle(stringField(entry, "title", "name")) ?? await grokUserTitle(home, cwd, id) ?? "Grok";
    return { agent: "grok", id, cwd: resolve(cwd), title, status, startedAt: iso(entry.startedAt) ?? iso(entry.started_at), lastActivityAt, ...(pid === undefined ? {} : { processId: pid }) };
  }))).filter((session): session is RawSession => session !== undefined);
}

async function codexRolloutPaths(home: string, processAdapter: ProcessAdapter): Promise<string[]> {
  const root = join(home, ".codex", "sessions");
  const recent = await processAdapter.run("find", [root, "-type", "f", "-name", "rollout-*.jsonl", "-mmin", String(-CODEX_WINDOW / 60_000)]);
  if (recent.kind === "ok") return recent.value.stdout.split("\n").filter((path) => path !== "");
  const years = await readdir(root).catch(() => []);
  return (async () => {
    const directories = await Promise.all(years.map(async (year) => {
      const months = await readdir(join(root, year)).catch(() => []);
      return Promise.all(months.map(async (month) => {
        const days = await readdir(join(root, year, month)).catch(() => []);
        return Promise.all(days.map(async (day) => {
          const dir = join(root, year, month, day);
          return (await readdir(dir).catch(() => [])).filter((name) => name.startsWith("rollout-") && name.endsWith(".jsonl")).map((name) => join(dir, name));
        }));
      }));
    }));
    return directories.flat(3);
  })();
}

async function codexSessions(home: string, processAdapter: ProcessAdapter, titles: ReadonlyMap<string, string>, table: ProcessTable, cache: ProjectCache): Promise<RawSession[]> {
  const paths = await codexRolloutPaths(home, processAdapter);
  const cutoff = Date.now() - CODEX_WINDOW;
  const eligible: Array<{ path: string; modified: number; size: number }> = [];
  await Promise.all(paths.map(async (path) => {
    try { const info = await stat(path); if (info.mtimeMs >= cutoff) eligible.push({ path, modified: info.mtimeMs, size: info.size }); } catch { /* A rollout may be rotated while listing. */ }
  }));
  // A rollout is live when a codex process holds it open; the folder says nothing about which conversation runs.
  const codexPids = [...table].filter(([, entry]) => /(?:^|\/)codex(?:\s|$)|Codex\.app/.test(entry.command)).map(([pid]) => String(pid));
  const pidByRollout = new Map<string, number>();
  if (codexPids.length > 0) {
    const open = await processAdapter.run("lsof", ["-p", codexPids.join(","), "-Fn"]);
    if (open.kind === "ok") {
      let pid: number | undefined;
      for (const line of open.value.stdout.split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (line.startsWith("n") && pid !== undefined) {
          const rollout = /rollout-[^/]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(line)?.[1];
          if (rollout !== undefined) pidByRollout.set(rollout, pid);
        }
      }
    }
  }
  const found = await Promise.all(eligible.map(async ({ path, modified, size }): Promise<RawSession | undefined> => {
    const key = logCacheKey(path, size, modified);
    let rollout = cache.sessions[key]?.codex;
    if (rollout === undefined) {
      rollout = await readCodexRollout(path);
      for (const [oldKey, entry] of Object.entries(cache.sessions)) if (entry.path === path) delete cache.sessions[oldKey];
      cache.sessions[key] = { path, size, mtimeMs: modified, title: null, codex: rollout ?? null };
    }
    if (rollout === null) return undefined;
    const pid = pidByRollout.get(rollout.id);
    return { agent: "codex", id: rollout.id, cwd: rollout.cwd, title: titles.get(rollout.id) ?? rollout.title ?? "Codex", status: pid === undefined ? "ended" : "working", startedAt: rollout.startedAt, lastActivityAt: new Date(modified).toISOString(), model: rollout.model, contextWindow: rollout.contextWindow, ...(pid === undefined ? {} : { processId: pid }) };
  }));
  return found.filter((value): value is RawSession => value !== undefined);
}

async function readCodexRollout(path: string): Promise<CodexRollout | null> {
  try {
    const file = await import("node:fs/promises").then(({ open }) => open(path, "r"));
    let head: string;
    let tail: string;
    try {
      const info = await file.stat();
      const headBuffer = Buffer.alloc(Math.min(info.size, 256 * 1024));
      const headRead = await file.read(headBuffer, 0, headBuffer.length, 0);
      head = headBuffer.subarray(0, headRead.bytesRead).toString("utf8");
      const tailStart = Math.max(0, info.size - 512 * 1024);
      const tailBuffer = Buffer.alloc(info.size - tailStart);
      const tailRead = await file.read(tailBuffer, 0, tailBuffer.length, tailStart);
      tail = tailBuffer.subarray(0, tailRead.bytesRead).toString("utf8");
    }
    finally { await file.close(); }
    for (const line of head.split("\n")) {
      const value = record(JSON.parse(line) as unknown);
      if (value?.type === "session_meta") {
        const payload = record(value.payload);
        const cwd = stringField(payload ?? {}, "cwd");
        const id = stringField(payload ?? {}, "session_id", "id");
        if (cwd === undefined || id === undefined) return null;
        const details = codexModelDetails(tail);
        return { id, cwd: resolve(cwd), title: codexUserTitle(head) ?? null, startedAt: iso(payload?.timestamp) ?? iso(value.timestamp), model: details.model, contextWindow: details.contextWindow };
      }
    }
  } catch { /* Ignore malformed or unavailable rollout headers. */ }
  return null;
}

function codexModelDetails(tail: string): Readonly<{ model: string | null; contextWindow: number | null }> {
  let model: string | null = null;
  let contextWindow: number | null = null;
  for (const line of tail.split("\n").reverse()) {
    try {
      const entry = record(JSON.parse(line) as unknown);
      if (entry === undefined) continue;
      const payload = record(entry.payload);
      const info = record(payload?.info);
      const details = payload?.type === "turn_context" ? payload : info;
      if (details === undefined) continue;
      if (model === null) {
        const candidate = stringField(details, "model", "model_slug", "model_name");
        if (candidate !== undefined) model = candidate;
      }
      if (contextWindow === null) {
        const candidate = details.model_context_window;
        if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) contextWindow = candidate;
      }
      if (model !== null && contextWindow !== null) break;
    } catch { /* Ignore partial and malformed rollout lines. */ }
  }
  return { model, contextWindow };
}

export function codexUserTitle(contents: string): string | undefined {
  for (const line of contents.split("\n")) {
    try {
      const entry = record(JSON.parse(line) as unknown);
      const payload = record(entry?.payload);
      if (entry?.type !== "response_item" || payload?.type !== "message" || payload.role !== "user") continue;
      const title = userTitle(payload.content);
      if (title !== undefined) return title;
    } catch { /* Ignore malformed rollout lines. */ }
  }
  return undefined;
}

// agy holds <home>/.gemini/antigravity-cli/presence/<conversation>.lock open while it runs; the prompt log names the workspace.
async function agySessions(home: string, processAdapter: ProcessAdapter): Promise<RawSession[]> {
  const presence = join(home, ".gemini", "antigravity-cli", "presence");
  const locks = (await readdir(presence).catch(() => [])).flatMap((name) => /^[0-9a-f-]{36}\.lock$/i.test(name) ? [name] : []);
  if (locks.length === 0) return [];
  const index = await agyConversationIndex(home);
  // One lsof for every lock: a call per lock cost ~25 ms each, seconds with a hundred stale locks. Exit 1 means nobody holds any.
  const holders = await processAdapter.run("lsof", ["-Fpn", "--", ...locks.map((name) => join(presence, name))]);
  const pidByLock = new Map<string, number>();
  if (holders.kind === "ok") {
    let holder: number | undefined;
    for (const line of holders.value.stdout.split("\n")) {
      if (line.startsWith("p")) holder = Number(line.slice(1));
      else if (line.startsWith("n") && holder !== undefined && !pidByLock.has(line.slice(1))) pidByLock.set(line.slice(1), holder);
    }
  }
  return (locks.flatMap((name): RawSession[] => {
    const id = name.slice(0, -".lock".length);
    const known = index.get(id);
    const pid = pidByLock.get(join(presence, name)) ?? Number.NaN;
    if (known === undefined || !Number.isSafeInteger(pid) || pid <= 0) return [];
    return [{ agent: "agy", id, cwd: known.workspace, title: known.title ?? "Antigravity", status: "working", startedAt: new Date(known.first).toISOString(), lastActivityAt: new Date(known.last).toISOString(), processId: pid }];
  }));
}

export async function sessionsForMachine(home: string, processAdapter: ProcessAdapter, table?: ProcessTable, cache: ProjectCache = emptyProjectCache()): Promise<RawSession[]> {
  const [claude, grok, codexTitles, agy] = await Promise.all([claudeSessions(home, cache), grokSessions(home), codexSessionTitles(home), agySessions(home, processAdapter)]);
  const codex = await codexSessions(home, processAdapter, codexTitles, table ?? await readProcessTable(processAdapter), cache);
  const unique = new Map<string, RawSession>();
  for (const session of [...claude, ...grok, ...codex, ...agy]) unique.set(`${session.agent}:${session.id}`, session);
  return [...unique.values()];
}

export async function findMachineSession(home: string, processAdapter: ProcessAdapter, agent: string, id: string): Promise<RawSession | undefined> {
  return (await sessionsForMachine(home, processAdapter)).find((session) => session.agent === agent && session.id === id);
}

const DISPATCH_SESSION_KEYS = ["agentThreadId", "agentSessionId", "grokSessionId", "codexSessionId"];

// A dispatch owns a session by its recorded session id, or by the session's process sitting in the agent process's tree. Never by time.
function dispatchForSession(session: RawSession, dispatches: readonly Dispatch[], table: ProcessTable): Dispatch | null {
  const matches = dispatches.filter((dispatch) => dispatch.agent === session.agent);
  const exact = matches.find((dispatch) => DISPATCH_SESSION_KEYS.some((key) => dispatch[key] === session.id));
  if (exact !== undefined) return exact;
  const inTree = (agentPid: number): boolean => {
    const seen = new Set<number>();
    for (let current: number | undefined = session.processId; current !== undefined && current > 1 && !seen.has(current); current = table.get(current)?.ppid) {
      if (current === agentPid) return true;
      seen.add(current);
    }
    return false;
  };
  return matches.find((dispatch) => typeof dispatch.agentPid === "number" && inTree(dispatch.agentPid)) ?? null;
}

type ListContext = Readonly<{
  registry: ConversationRegistry;
  chats: ReadonlyMap<string, Chat>;
  table: ProcessTable;
  appPanes: ReadonlyMap<number, string>;
  includeForeign: boolean;
  home: string;
  stateDir: string;
}>;

const AGENT_TITLES: Readonly<Record<ProjectSession["agent"], string>> = { claude: "Claude", codex: "Codex", grok: "Grok", agy: "Antigravity" };
const chatStatus = (chat: Chat): SessionStatus => chat.state === "working" || chat.state === "starting" ? "working" : chat.state === "waiting-approval" ? "waiting" : chat.state === "idle" ? "idle" : "ended";

// The app tmux session a conversation lives in: its recorded alias, else the pane its live process runs in.
function tmuxOf(alias: string | null, live: RawSession | undefined, context: ListContext): Pick<ProjectSession, "tmuxServer" | "tmuxSession" | "terminalPid"> {
  const [server, session] = (alias ?? "").split(":");
  if (server !== undefined && session !== undefined && server !== "" && session !== "") return { tmuxServer: server, tmuxSession: session };
  const target = live === undefined ? undefined : appTarget(appHost(context.table, live.processId), context.appPanes);
  if (target === undefined) return {};
  return "terminalPid" in target ? { terminalPid: target.terminalPid } : { tmuxServer: OWNED_TMUX_SERVER, tmuxSession: target.tmuxSession };
}

function dispatchHost(dispatch: Dispatch): string {
  const host = stringField(dispatch, "childHost");
  return host === undefined || host === "local" ? "terminal" : host;
}

async function projectSessions(path: string, found: readonly RawSession[], dispatches: readonly Dispatch[], context: ListContext): Promise<ProjectSession[]> {
  const here = resolve(path);
  const liveByKey = new Map(found.map((session) => [`${session.agent}:${session.id}`, session]));
  let history: Map<string, HistorySession> | undefined;
  const historyOf = async (key: string): Promise<HistorySession | undefined> => {
    history ??= new Map((await sessionHistory(here, undefined, { home: context.home, stateDir: context.stateDir, limit: 1000 }).catch(() => [])).map((item) => [`${item.agent}:${item.id}`, item]));
    return history.get(key);
  };
  const rows: ProjectSession[] = [];
  for (const [key, entry] of Object.entries(context.registry.conversations)) {
    const separator = key.indexOf(":");
    const agent = key.slice(0, separator);
    if (entry.hidden || resolve(entry.cwd) !== here || (agent !== "claude" && agent !== "codex" && agent !== "grok" && agent !== "agy")) continue;
    const live = liveByKey.get(key);
    const chat = entry.aliases.chatId === null ? undefined : context.chats.get(entry.aliases.chatId);
    const past = live === undefined && chat === undefined ? await historyOf(key) : undefined;
    const status: SessionStatus = live?.status ?? (chat === undefined ? "ended" : chatStatus(chat));
    rows.push({
      agent, sessionId: key,
      title: (chat?.title ?? live?.title ?? past?.title ?? AGENT_TITLES[agent]).slice(0, 80),
      status,
      startedAt: live?.startedAt ?? chat?.createdAt ?? past?.startedAt ?? entry.createdAt,
      lastActivityAt: live?.lastActivityAt ?? chat?.lastActivityAt ?? past?.lastActivityAt ?? entry.createdAt,
      dispatchId: null, model: live?.model ?? chat?.model ?? null, contextWindow: live?.contextWindow ?? chat?.contextWindow ?? null,
      owner: "megabrain", origin: "megabrain", conversationOwner: entry.owner,
      host: "megabrain", parent: chat?.parentSessionId ?? null, chatId: entry.aliases.chatId,
      ...tmuxOf(entry.aliases.tmux, live, context),
    });
  }
  const now = Date.now();
  const strangers = found.filter((session) => resolve(session.cwd) === here && context.registry.conversations[`${session.agent}:${session.id}`] === undefined && !context.registry.hiddenKeys.includes(`${session.agent}:${session.id}`)).map((session): ProjectSession => {
    const dispatch = dispatchForSession(session, dispatches, context.table);
    return {
      agent: session.agent, sessionId: `${session.agent}:${session.id}`,
      title: (stringField(dispatch ?? {}, "label", "chatName") ?? session.title).slice(0, 80),
      status: dispatch?.state === "waiting_for_reply" ? "waiting" : session.status,
      startedAt: session.startedAt, lastActivityAt: session.lastActivityAt, dispatchId: dispatch?.dispatchId ?? null,
      model: session.model ?? null, contextWindow: session.contextWindow ?? null,
      owner: "external", origin: dispatch === null ? "external" : "megabrain", conversationOwner: dispatch === null ? "foreign" : "dispatch",
      host: dispatch === null ? inferSessionHost(context.table, session.processId) : dispatchHost(dispatch),
      parent: dispatch === null ? null : stringField(dispatch, "parentSessionId") ?? null,
    };
  });
  const included = strangers.filter((session) => context.includeForeign || session.conversationOwner === "dispatch");
  rows.push(...included.filter((session) => session.status !== "ended"));
  rows.push(...included.filter((session) => session.status === "ended" && session.lastActivityAt !== null && now - Date.parse(session.lastActivityAt) <= recentWindow(session.agent))
    .sort((left, right) => Date.parse(right.lastActivityAt ?? "") - Date.parse(left.lastActivityAt ?? "")).slice(0, 5));
  return rows;
}

function parseWorktrees(output: string, mainPath: string, parentByBranch: ReadonlyMap<string, string>): GitWorktree[] {
  const entries: GitWorktree[] = [];
  for (const block of output.split(/\r?\n\r?\n/)) {
    let path = "";
    let branch: string | null = null;
    let head: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("HEAD ")) head = line.slice(5).slice(0, 7);
      else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
    }
    if (path !== "") {
      const primary = resolve(path) === resolve(mainPath);
      entries.push({ path: resolve(path), branch, head, primary, parent: branch === null ? null : parentByBranch.get(branch) ?? null });
    }
  }
  return entries.sort((left, right) => Number(right.primary) - Number(left.primary)
    || Number(left.branch === null) - Number(right.branch === null)
    || (left.branch ?? "").localeCompare(right.branch ?? "")
    || left.path.localeCompare(right.path));
}

async function repositoryParents(repositoryPath: string): Promise<Map<string, string>> {
  let contents: string;
  try { contents = await readFile(join(repositoryPath, ".git", "config"), "utf8"); }
  catch { return new Map(); }
  const parents = new Map<string, string>();
  let branch: string | undefined;
  for (const line of contents.split(/\r?\n/)) {
    const section = /^\s*\[branch\s+"((?:\\.|[^"])*)"\]\s*$/.exec(line);
    if (section?.[1] !== undefined) { branch = section[1].replace(/\\(.)/g, "$1"); continue; }
    if (/^\s*\[/.test(line)) { branch = undefined; continue; }
    if (branch === undefined) continue;
    const parent = /^\s*megabrain-parent\s*=\s*(.*?)\s*$/.exec(line)?.[1];
    if (parent !== undefined && parent !== "") parents.set(branch, parent.replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1"));
  }
  return parents;
}

async function worktreeMetadataSignature(path: string, configMtimeMs: number): Promise<{ headMtimeMs: number; indexMtimeMs: number; configMtimeMs: number } | undefined> {
  let gitDirectory: string;
  try {
    const gitEntry = await readFile(join(path, ".git"), "utf8").catch(() => "");
    gitDirectory = gitEntry.startsWith("gitdir: ") ? resolve(path, gitEntry.slice(8).trim()) : join(path, ".git");
    const [head, index] = await Promise.all([stat(join(gitDirectory, "HEAD")), stat(join(gitDirectory, "index"))]);
    return { headMtimeMs: head.mtimeMs, indexMtimeMs: index.mtimeMs, configMtimeMs };
  } catch { return undefined; }
}

function pullRequestMap(value: unknown): Map<string, PullRequestSummary> {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.flatMap((item) => {
    const entry = record(item);
    if (entry === undefined || typeof entry.headRefName !== "string" || typeof entry.number !== "number" || typeof entry.state !== "string" || typeof entry.url !== "string") return [];
    return [[entry.headRefName, { number: entry.number, state: entry.state, url: entry.url, title: typeof entry.title === "string" ? entry.title : null, isDraft: typeof entry.isDraft === "boolean" ? entry.isDraft : null }] as const];
  }));
}

function cachedPullRequestMap(value: string | undefined): Map<string, PullRequestSummary> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? pullRequestMap(parsed) : undefined;
  } catch { return undefined; }
}

async function repositoryPullRequests(repository: RepositoryRecord, database: DatabaseAdapter, processAdapter: ProcessAdapter, environment: Environment): Promise<Map<string, PullRequestSummary>> {
  const cached = getRepositoryPullRequests(database, repository.path);
  const stale = cachedPullRequestMap(cached?.value);
  const now = Date.now();
  if (stale !== undefined && cached !== undefined && cached.fetchedAt <= now && now - cached.fetchedAt < PULL_REQUEST_CACHE_TTL) return stale;
  await schedulePullRequestRefresh(repository, processAdapter, environment);
  return stale ?? new Map();
}

const PULL_REQUEST_REFRESH_ARGUMENT = "--refresh-pull-requests";

function refreshLockPath(repositoryPath: string, environment: Environment): string {
  const digest = createHash("sha256").update(repositoryPath).digest("hex");
  return join(resolveStateDirectory(environment), "locks", `projects-pr-${digest}.lock`);
}

async function acquireRefreshLock(path: string): Promise<boolean> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = await openFile(path, "wx", 0o600);
      await lock.writeFile(String(process.pid));
      await lock.close();
      return true;
    } catch (cause: unknown) {
      if (typeof cause !== "object" || cause === null || !("code" in cause) || cause.code !== "EEXIST") return false;
      const owner = Number((await readFile(path, "utf8").catch(() => "")).trim());
      if (processIsAlive(owner)) return false;
      const info = await stat(path).catch(() => undefined);
      if (!Number.isFinite(owner) && info !== undefined && Date.now() - info.mtimeMs < PULL_REQUEST_CACHE_TTL) return false;
      await unlink(path).catch(() => undefined);
    }
  }
  return false;
}

async function schedulePullRequestRefresh(repository: RepositoryRecord, processAdapter: ProcessAdapter, environment: Environment): Promise<void> {
  const lock = refreshLockPath(repository.path, environment);
  try {
    const owner = Number((await readFile(lock, "utf8")).trim());
    if (processIsAlive(owner)) return;
    const info = await stat(lock);
    if (!Number.isFinite(owner) && Date.now() - info.mtimeMs < PULL_REQUEST_CACHE_TTL) return;
    await unlink(lock).catch(() => undefined);
  } catch { /* No refresh is active. */ }
  const refresh = selfInvocation(process.execPath, process.argv, ["projects", PULL_REQUEST_REFRESH_ARGUMENT, repository.path]);
  await processAdapter.startDetached(refresh.command, refresh.args, {
    env: { MEGABRAIN_STATE_DIR: resolveStateDirectory(environment), ...(environment.HOME === undefined ? {} : { HOME: environment.HOME }) },
  });
}

async function refreshRepositoryPullRequests(repositoryPath: string, environment: Environment, processAdapter: ProcessAdapter): Promise<void> {
  const lock = refreshLockPath(repositoryPath, environment);
  if (!(await acquireRefreshLock(lock).catch(() => false))) return;
  const opened = openDatabaseReadOnly(environment);
  if (opened.kind !== "ok") { await unlink(lock).catch(() => undefined); return; }
  try {
    const cached = getRepositoryPullRequests(opened.value.db, repositoryPath);
    const refreshed = await processAdapter.run("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "headRefName,number,state,url,title,isDraft"], { cwd: repositoryPath, timeoutMs: 2_000 });
    let value: string | undefined;
    if (refreshed.kind === "ok") try {
      const parsed: unknown = JSON.parse(refreshed.value.stdout);
      if (Array.isArray(parsed)) value = JSON.stringify(parsed);
    } catch { /* Keep the last known good result on malformed output. */ }
    await callStateOwner(resolveStateDirectory(environment), { operation: "repository-pull-request-cache-write", path: repositoryPath, value: value ?? cached?.value ?? "[]", fetchedAt: Date.now() });
  } finally {
    opened.value.close();
    await unlink(lock).catch(() => undefined);
  }
}

async function claudeIdleEnabled(home: string, cwd: string): Promise<boolean> {
  let enabled = true;
  for (const path of [join(home, ".claude", "settings.json"), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")]) {
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (typeof value === "object" && value !== null && !Array.isArray(value) && "idleCompaction" in value && typeof value.idleCompaction === "boolean") enabled = value.idleCompaction;
    } catch { /* Missing or invalid settings do not disable compaction. */ }
  }
  return enabled;
}

async function timedSessions(sessions: readonly ProjectSession[], home: string, cwd: string, environment: Environment): Promise<ProjectSession[]> {
  const minimumValue = Number(environment.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS ?? 200000);
  const minimum = Number.isSafeInteger(minimumValue) && minimumValue >= 0 ? minimumValue : 200000;
  const loadedRegistry = await loadAndPersistModelRegistry(environment);
  const registry = loadedRegistry.kind === "loaded" ? loadedRegistry.registry : { version: 1 as const, models: [] };
  const measured = await Promise.all(sessions.map(async (session) => {
    const sessionId = session.sessionId.slice(session.agent.length + 1);
    const claudeDetails = session.agent === "claude" ? await claudeLogDetails(home, cwd, sessionId, registry) : undefined;
    const model = claudeDetails?.model ?? session.model;
    const contextWindow = claudeDetails?.contextWindow ?? session.contextWindow;
    const meter = await readContextMeter({
      agent: session.agent,
      agentSessionId: sessionId,
      agentCwd: cwd,
      ...(contextWindow === null ? {} : { contextWindow }),
      ...(session.agent === "claude" ? { agentTranscriptPath: join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`) } : {}),
    }, home);
    return {
      session: { ...session, model, contextWindow },
      contextTokens: claudeDetails?.contextTokens ?? (meter.status === "known" ? meter.usedTokens : null),
    };
  }));
  const needsIdleSetting = measured.some(({ session, contextTokens }) => session.agent === "claude" && session.status !== "working" && session.lastActivityAt !== null && contextTokens !== null && contextTokens >= minimum);
  const idleEnabled = needsIdleSetting ? await claudeIdleEnabled(home, cwd) : false;
  return measured.map(({ session, contextTokens }) => {
    if (session.agent !== "claude" || session.status === "working" || session.lastActivityAt === null) return { ...session, contextTokens, cacheExpiresAt: null, idleCompactAt: null };
    const timestamp = Date.parse(session.lastActivityAt);
    if (!Number.isFinite(timestamp)) return { ...session, contextTokens, cacheExpiresAt: null, idleCompactAt: null };
    return {
      ...session,
      contextTokens,
      cacheExpiresAt: new Date(timestamp + 60 * 60_000).toISOString(),
      idleCompactAt: idleEnabled && contextTokens !== null && contextTokens >= minimum ? new Date(timestamp + 54 * 60_000).toISOString() : null,
    };
  });
}

// A terminal conversation learns its session from the process in its own tmux pane. A dispatch worker in that pane is the dispatch's.
function promoteTerminals(stateDir: string, registry: ConversationRegistry, found: readonly RawSession[], dispatches: readonly Dispatch[], table: ProcessTable, appPanes: ReadonlyMap<number, string>): ConversationRegistry {
  let promoted = false;
  for (const [key, entry] of Object.entries(registry.conversations)) {
    const pane = key.startsWith("terminal:") ? (entry.aliases.tmux ?? "").split(":")[1] : undefined;
    if (pane === undefined || pane === "") continue;
    const session = found.find((candidate) => {
      const target = appTarget(appHost(table, candidate.processId), appPanes);
      return target !== undefined && "tmuxSession" in target && target.tmuxSession === pane && dispatchForSession(candidate, dispatches, table) === null;
    });
    if (session === undefined) continue;
    promoteConversation(stateDir, key, sessionKey(session.agent, session.id));
    promoted = true;
  }
  return promoted ? readConversations(stateDir) : registry;
}

async function repositoryProject(repository: RepositoryRecord, found: readonly RawSession[], dispatches: readonly Dispatch[], processAdapter: ProcessAdapter, database: DatabaseAdapter, home: string, environment: Environment, cache: ProjectCache, context: ListContext): Promise<Project> {
  const checkoutPath = await realpath(repository.path).catch(() => undefined);
  if (checkoutPath === undefined) return { name: repository.name, path: repository.path, remote: repository.remote, source: repository.source, missing: true, worktrees: [] };
  const [worktreesResult, parents, pulls] = await Promise.all([
    processAdapter.run("git", ["-C", repository.path, "worktree", "list", "--porcelain"]),
    repositoryParents(repository.path),
    repositoryPullRequests(repository, database, processAdapter, environment),
  ]);
  if (worktreesResult.kind !== "ok") return { name: repository.name, path: repository.path, remote: repository.remote, source: repository.source, missing: true, worktrees: [] };
  const parsedWorktrees = parseWorktrees(worktreesResult.value.stdout, checkoutPath, parents);
  const configMtimeMs = (await stat(join(repository.path, ".git", "config")).catch(() => undefined))?.mtimeMs ?? -1;
  const worktrees = await Promise.all(parsedWorktrees.map(async (worktree) => {
    const signature = await worktreeMetadataSignature(worktree.path, configMtimeMs);
    const cached = cache.worktrees[worktree.path];
    const derived = signature !== undefined && cached?.headMtimeMs === signature.headMtimeMs && cached.indexMtimeMs === signature.indexMtimeMs && cached.configMtimeMs === signature.configMtimeMs ? cached : undefined;
    const parent = derived?.parent ?? worktree.parent;
    if (signature !== undefined) cache.worktrees[worktree.path] = { ...signature, primary: derived?.primary ?? worktree.primary, parent };
    return {
    ...worktree,
    primary: derived?.primary ?? worktree.primary,
    parent,
    pullRequest: worktree.branch === null ? null : pulls.get(worktree.branch) ?? null,
    sessions: await timedSessions(await projectSessions(worktree.path, found, dispatches, context), home, worktree.path, environment),
  }; }));
  return { name: repository.name, path: repository.path, remote: repository.remote, source: repository.source, missing: false, worktrees };
}

export async function backfillProjectHistory(environment: Environment, processAdapter: ProcessAdapter): Promise<Result<void>> {
  const opened = openDatabaseReadOnly(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  const handle = opened.value;
  const candidates = new Set<string>();
  try {
    const marker = handle.db.query<{ value: string }>("SELECT value FROM settings WHERE key = ?").get(HISTORY_MARKER);
    if (marker !== null) return ok(undefined);
    for (const worktree of listWorktrees(handle.db)) candidates.add(worktree.repo);
    for (const dispatch of listDispatches(handle.db, { includeArchived: true })) if (typeof dispatch.worktreePath === "string" && dispatch.worktreePath !== "") candidates.add(dispatch.worktreePath);
  } finally { handle.close(); }
  const resolved = await Promise.all([...candidates].map((path) => repositoryCheckout(path, processAdapter)));
  const markedAt = new Date().toISOString();
  const records = resolved.flatMap((item) => item.kind === "ok" ? [{ ...item.value, source: "megabrain" as const, addedAt: markedAt }] : []);
  try {
    await callStateOwner(resolveStateDirectory(environment), { operation: "project-history-backfill", markerKey: HISTORY_MARKER, markedAt, repositories: records });
    return ok(undefined);
  } catch (cause: unknown) { return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
}

export async function executeProjects(args: readonly string[], environment: Environment, processAdapter = createProcessAdapter()): Promise<Result<string>> {
  const usage = "Usage: megabrain projects [--json] [--include-foreign] [--origin megabrain|all]";
  if (args[0] === PULL_REQUEST_REFRESH_ARGUMENT && args.length === 2) {
    await refreshRepositoryPullRequests(args[1] as string, environment, processAdapter);
    return ok("");
  }
  if (args.includes("-h") || args.includes("--help")) return ok(`${usage}\n`);
  let includeForeign = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") continue;
    if (argument === "--include-foreign") { includeForeign = true; continue; }
    const value = argument === "--origin" ? args[index + 1] : argument?.startsWith("--origin=") ? argument.slice(9) : undefined;
    if (value !== "megabrain" && value !== "all") return failed(usage, 2);
    includeForeign = value === "all";
    if (argument === "--origin") index += 1;
  }
  const backfilled = await backfillProjectHistory(environment, processAdapter);
  if (backfilled.kind !== "ok") return backfilled;
  const opened = openDatabaseReadOnly(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  try {
    const repositories = listRepositories(opened.value.db);
    const dispatches = listDispatches(opened.value.db, { includeArchived: true });
    const home = environment.HOME ?? process.env.HOME ?? "";
    const cache = await readProjectCache(environment);
    const table = await readProcessTable(processAdapter);
    const found = await sessionsForMachine(home, processAdapter, table, cache);
    const stateDir = resolveStateDirectory(environment);
    const chats = new Map((existsSync(join(stateDir, "chats")) ? await new ChatStore(stateDir).list().catch(() => []) : []).map((chat) => [chat.id, chat]));
    // The app's tmux server is asked only when a live session runs under it or a terminal conversation waits for its session.
    const registry = readConversations(stateDir);
    const waiting = Object.keys(registry.conversations).some((key) => key.startsWith("terminal:"));
    const appPanes = waiting || found.some((session) => appHost(table, session.processId)?.kind === "tmux") ? await readAppPanes(processAdapter) : new Map<number, string>();
    const context: ListContext = { registry: promoteTerminals(stateDir, registry, found, dispatches, table, appPanes), chats, table, appPanes, includeForeign, home, stateDir };
    const hiddenItems = new Set(listHiddenItems(opened.value.db).map((item) => `${item.kind}:${item.path}`));
    const appearance = (await readProjectAppearance(environment)).projects;
    const archived = new Set((await readArchivedWorktrees(environment)).map((item) => `${item.repo}\0${item.branch}`));
    const projects = await Promise.all(repositories.map(async (repository) => {
      const project = await repositoryProject(repository, found, dispatches, processAdapter, opened.value.db, home, environment, cache, context);
      return { ...project, appearance: appearance[repository.path] ?? {}, hidden: hiddenItems.has(`repo:${repository.path}`), worktrees: project.worktrees.filter((tree) => tree.branch === null || !archived.has(`${repository.path}\0${tree.branch}`)).map((tree) => ({ ...tree, hidden: hiddenItems.has(`worktree:${tree.path}`) })) };
    }));
    await writeProjectCache(environment, cache);
    return ok(`${JSON.stringify(projects, null, 2)}\n`);
  } finally { opened.value.close(); }
}
