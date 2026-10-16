import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { claudeTitle, codexSessionTitles, codexUserTitle, grokUserTitle, iso, record, stringField, userTitle } from "../cli/commands/projects.js";

export const HISTORY_AGENTS = ["claude", "codex", "grok", "agy"] as const;
export type HistoryAgent = (typeof HISTORY_AGENTS)[number];
export type HistorySession = Readonly<{ agent: HistoryAgent; id: string; title: string; startedAt: string | null; lastActivityAt: string | null; messageCount: number | null }>;
export type HistoryOptions = Readonly<{ home?: string; stateDir?: string; limit?: number }>;

const DEFAULT_LIMIT = 50;
const HEAD_BYTES = 256 * 1024;
const CONCURRENCY = 64;
const CACHE_FILE = "session-history-cache.json";

// What one log file contributes, keyed in the cache by path, size and mtime. `null` means the file
// is not a session of any folder (a rollout without a header), so it is not read again.
type Parsed = Readonly<{ cwd: string; id: string; title: string | null; startedAt: string | null; lastActivityAt?: string | null; messageCount: number | null }> | null;
type CacheEntry = Readonly<{ size: number; mtimeMs: number; parsed: Parsed }>;
type Cache = Map<string, CacheEntry>;

async function readCache(stateDir: string): Promise<Cache> {
  try {
    const value = record(JSON.parse(await readFile(join(stateDir, CACHE_FILE), "utf8")) as unknown);
    const files = record(value?.files) ?? {};
    return new Map(Object.entries(files).flatMap(([path, entry]) => {
      const row = record(entry);
      return row !== undefined && typeof row.size === "number" && typeof row.mtimeMs === "number" && "parsed" in row ? [[path, row as unknown as CacheEntry] as const] : [];
    }));
  } catch { return new Map(); }
}

async function writeCache(stateDir: string, cache: Cache): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true });
    const target = join(stateDir, CACHE_FILE);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, files: Object.fromEntries(cache) }));
    await rename(temporary, target);
  } catch { /* The cache only saves time; history works without it. */ }
}

async function mapLimited<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) { const index = next; next += 1; results[index] = await work(items[index] as T); }
  }));
  return results;
}

async function head(path: string, bytes = HEAD_BYTES): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close().catch(() => undefined); }
}

type Listed = Readonly<{ path: string; size: number; mtimeMs: number }>;

async function listed(paths: readonly string[]): Promise<Listed[]> {
  const found = await mapLimited(paths, async (path): Promise<Listed | undefined> => {
    try { const info = await stat(path); return { path, size: info.size, mtimeMs: info.mtimeMs }; } catch { return undefined; }
  });
  return found.filter((entry): entry is Listed => entry !== undefined);
}

// Parses each file once per (size, mtime); a cached file costs one stat.
async function parsedFiles(files: readonly Listed[], cache: Cache, parse: (path: string) => Promise<Parsed>): Promise<Array<Listed & { parsed: Parsed }>> {
  return mapLimited(files, async (file) => {
    const hit = cache.get(file.path);
    if (hit !== undefined && hit.size === file.size && hit.mtimeMs === file.mtimeMs) return { ...file, parsed: hit.parsed };
    let parsed: Parsed = null;
    try { parsed = await parse(file.path); } catch { /* An unreadable log is not a session. */ }
    cache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, parsed });
    return { ...file, parsed };
  });
}

function firstTimestamp(contents: string): string | null {
  for (const line of contents.split("\n")) {
    try { const stamp = iso(record(JSON.parse(line) as unknown)?.timestamp); if (stamp !== null) return stamp; } catch { /* Ignore partial and non-JSON lines. */ }
  }
  return null;
}

async function claudeHistory(home: string, cwd: string, cache: Cache): Promise<HistorySession[]> {
  const directory = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
  const files = await parsedFiles(await listed(names.map((name) => join(directory, name))), cache, async (path) => {
    const id = path.slice(directory.length + 1, -".jsonl".length);
    return { cwd, id, title: await claudeTitle(home, cwd, id) ?? null, startedAt: firstTimestamp(await head(path)), messageCount: null };
  });
  return files.flatMap((file) => file.parsed === null ? [] : [{ agent: "claude" as const, id: file.parsed.id, title: file.parsed.title ?? "Claude", startedAt: file.parsed.startedAt, lastActivityAt: new Date(file.mtimeMs).toISOString(), messageCount: null }]);
}

async function rolloutPaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => entry.isDirectory() ? rolloutPaths(join(directory, entry.name))
    : entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl") ? [join(directory, entry.name)] : []));
  return nested.flat();
}

async function codexHistory(home: string, cwd: string, cache: Cache): Promise<HistorySession[]> {
  const [paths, titles] = await Promise.all([rolloutPaths(join(home, ".codex", "sessions")), codexSessionTitles(home)]);
  const files = await parsedFiles(await listed(paths), cache, async (path) => {
    const contents = await head(path);
    for (const line of contents.split("\n")) {
      try {
        const entry = record(JSON.parse(line) as unknown);
        if (entry?.type !== "session_meta") continue;
        const payload = record(entry.payload) ?? {};
        const sessionCwd = stringField(payload, "cwd");
        const id = stringField(payload, "session_id", "id");
        if (sessionCwd === undefined || id === undefined) return null;
        return { cwd: resolve(sessionCwd), id, title: codexUserTitle(contents) ?? null, startedAt: iso(payload.timestamp) ?? iso(entry.timestamp), messageCount: null };
      } catch { /* Ignore partial and non-JSON lines. */ }
    }
    return null;
  });
  return files.flatMap((file) => file.parsed === null || file.parsed.cwd !== cwd ? []
    : [{ agent: "codex" as const, id: file.parsed.id, title: titles.get(file.parsed.id) ?? file.parsed.title ?? "Codex", startedAt: file.parsed.startedAt, lastActivityAt: new Date(file.mtimeMs).toISOString(), messageCount: null }]);
}

async function grokHistory(home: string, cwd: string, cache: Cache): Promise<HistorySession[]> {
  const root = join(home, ".grok", "sessions", encodeURIComponent(cwd));
  const ids = await readdir(root, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name), () => []);
  const files = await parsedFiles(await listed(ids.map((id) => join(root, id, "summary.json"))), cache, async (path) => {
    const summary = record(JSON.parse(await readFile(path, "utf8")) as unknown);
    const info = record(summary?.info);
    const id = stringField(info ?? {}, "id") ?? path.slice(root.length + 1).split("/")[0];
    if (summary === undefined || id === undefined) return null;
    const count = summary.num_chat_messages;
    return { cwd, id, title: userTitle(summary.session_summary) ?? await grokUserTitle(home, cwd, id) ?? null, startedAt: iso(summary.created_at), lastActivityAt: iso(summary.updated_at), messageCount: typeof count === "number" ? count : null };
  });
  return files.flatMap((file) => file.parsed === null ? [] : [{ agent: "grok" as const, id: file.parsed.id, title: file.parsed.title ?? "Grok", startedAt: file.parsed.startedAt, lastActivityAt: file.parsed.lastActivityAt ?? new Date(file.mtimeMs).toISOString(), messageCount: file.parsed.messageCount }]);
}

export type AgyConversation = Readonly<{ workspace: string; title: string | null; first: number; last: number }>;

// agy keeps no per-folder tree; its prompt log tags every line with the workspace and conversation.
export async function agyConversationIndex(home: string): Promise<Map<string, AgyConversation>> {
  const conversations = new Map<string, { workspace: string; title: string | null; first: number; last: number }>();
  let contents: string;
  try { contents = await readFile(join(home, ".gemini", "antigravity-cli", "history.jsonl"), "utf8"); } catch { return conversations; }
  for (const line of contents.split("\n")) {
    try {
      const entry = record(JSON.parse(line) as unknown);
      const id = stringField(entry ?? {}, "conversationId");
      const workspace = stringField(entry ?? {}, "workspace");
      const stamp = iso(entry?.timestamp);
      if (entry === undefined || id === undefined || workspace === undefined || stamp === null) continue;
      const at = Date.parse(stamp);
      const known = conversations.get(id) ?? { workspace: resolve(workspace), title: null, first: at, last: at };
      if (known.title === null && entry.type !== "slash_command") known.title = userTitle(entry.display) ?? null;
      known.first = Math.min(known.first, at);
      known.last = Math.max(known.last, at);
      conversations.set(id, known);
    } catch { /* Ignore partial and non-JSON lines. */ }
  }
  return conversations;
}

async function agyHistory(home: string, cwd: string): Promise<HistorySession[]> {
  return [...await agyConversationIndex(home)].filter(([, value]) => value.workspace === cwd)
    .map(([id, value]) => ({ agent: "agy" as const, id, title: value.title ?? "Antigravity", startedAt: new Date(value.first).toISOString(), lastActivityAt: new Date(value.last).toISOString(), messageCount: null }));
}

// Past sessions started in `cwd`, newest activity first, read from each agent's own storage.
export async function sessionHistory(cwd: string, agent?: HistoryAgent, options: HistoryOptions = {}): Promise<HistorySession[]> {
  const home = options.home ?? process.env.HOME ?? "";
  const stateDir = options.stateDir ?? process.env.MEGABRAIN_STATE_DIR ?? join(home, ".megabrain");
  const folder = resolve(cwd);
  const cache = await readCache(stateDir);
  const before = JSON.stringify([...cache]);
  const wanted = (id: HistoryAgent): boolean => agent === undefined || agent === id;
  const lists = await Promise.all([
    wanted("claude") ? claudeHistory(home, folder, cache).catch(() => []) : [],
    wanted("codex") ? codexHistory(home, folder, cache).catch(() => []) : [],
    wanted("grok") ? grokHistory(home, folder, cache).catch(() => []) : [],
    wanted("agy") ? agyHistory(home, folder).catch(() => []) : [],
  ]);
  if (JSON.stringify([...cache]) !== before) await writeCache(stateDir, cache);
  const newest = (session: HistorySession): number => Date.parse(session.lastActivityAt ?? session.startedAt ?? "") || 0;
  return lists.flat().sort((a, b) => newest(b) - newest(a)).slice(0, options.limit ?? DEFAULT_LIMIT);
}
