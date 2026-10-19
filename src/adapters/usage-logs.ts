import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { aggregateUsage, claudeParser, codexParser, dayReader, parseGrokUsage, rangeStart, type FileUsage, type LineParser, type UsageProvider, type UsageReport } from "../core/usage-stats.js";
import { readOnlyStateDatabase } from "./state-db.js";
import { read } from "./state/shared.js";

type Environment = Readonly<Record<string, string | undefined>>;

export type UsageStatsOptions = { days: number | null; provider: UsageProvider | null; now: Date; timeZone: string };

/** What megabrain itself started: dispatches, the time their agents worked, and native chats. */
export type MegabrainUsage = { dispatches: number; agentSeconds: number; chats: number; since: string | null };

export type UsageStats = UsageReport & {
  megabrain: MegabrainUsage | null;
  /** How the logs were read: parsed now, or taken from the cache by path, size and mtime. */
  scan: { files: number; parsed: number; cached: number; milliseconds: number };
};

const CACHE_FILE = "usage-cache.json";
const CACHE_VERSION = 1;
const CONCURRENCY = 4;

type Listed = { path: string; provider: UsageProvider; size: number; mtimeMs: number };
type CacheEntry = { size: number; mtimeMs: number; usage: FileUsage | null };

async function listFiles(root: string, keep: (path: string) => boolean): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true });
    return entries.map((entry) => join(root, entry)).filter(keep);
  } catch (cause: unknown) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return [];
    throw new Error(`could not list usage logs in ${root}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

async function logFiles(home: string, selected: UsageProvider | null): Promise<Array<{ path: string; provider: UsageProvider }>> {
  const jsonl = (path: string) => path.endsWith(".jsonl");
  const [claude, codex, archived, grok] = await Promise.all([
    selected === null || selected === "claude" ? listFiles(join(home, ".claude", "projects"), jsonl) : [],
    selected === null || selected === "codex" ? listFiles(join(home, ".codex", "sessions"), jsonl) : [],
    selected === null || selected === "codex" ? listFiles(join(home, ".codex", "archived_sessions"), jsonl) : [],
    selected === null || selected === "grok" ? listFiles(join(home, ".grok", "sessions"), (path) => basename(path) === "usage.json") : [],
  ]);
  return [
    ...claude.map((path) => ({ path, provider: "claude" as const })),
    ...[...codex, ...archived].map((path) => ({ path, provider: "codex" as const })),
    ...grok.map((path) => ({ path, provider: "grok" as const })),
  ];
}

async function mapLimited<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) { const index = next; next += 1; results[index] = await work(items[index] as T); }
  }));
  return results;
}

/** Feeds a log to a parser one line at a time, as bytes: a log can be larger than a string may be. */
async function feedLines(path: string, parser: LineParser): Promise<FileUsage> {
  let carry: Buffer[] = [];
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    let start = 0;
    let newline = chunk.indexOf(10, start);
    while (newline !== -1) {
      const piece = chunk.subarray(start, newline);
      const line = carry.length === 0 ? piece : Buffer.concat([...carry, piece]);
      carry = [];
      if (line.length > 0) parser.line(line);
      start = newline + 1;
      newline = chunk.indexOf(10, start);
    }
    if (start < chunk.length) carry.push(chunk.subarray(start));
  }
  if (carry.length > 0) parser.line(Buffer.concat(carry));
  return parser.result();
}

/** A Grok session's folder: its summary names the working directory; the folder name encodes it otherwise. */
async function grokProject(usagePath: string): Promise<string | null> {
  try {
    const summary = JSON.parse(await readFile(join(dirname(usagePath), "summary.json"), "utf8")) as { info?: { cwd?: unknown } };
    if (typeof summary.info?.cwd === "string") return summary.info.cwd;
  } catch { /* fall back to the folder name */ }
  try { return decodeURIComponent(basename(dirname(dirname(usagePath)))); } catch { return null; }
}

async function parseFile(file: Listed, timeZone: string): Promise<FileUsage> {
  try {
    if (file.provider === "grok") return parseGrokUsage(await readFile(file.path, "utf8"), await grokProject(file.path), timeZone);
    const usage = await feedLines(file.path, file.provider === "claude" ? claudeParser(timeZone) : codexParser(timeZone));
    return usage.session === "" ? { ...usage, session: file.path } : usage;
  } catch (cause: unknown) {
    throw new Error(`could not read ${file.provider} usage log ${file.path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

async function readCache(stateDir: string, timeZone: string): Promise<Map<string, CacheEntry>> {
  try {
    const value = JSON.parse(await readFile(join(stateDir, CACHE_FILE), "utf8")) as { version?: unknown; timeZone?: unknown; files?: Record<string, CacheEntry> };
    // Days are local dates, so a cache read in another time zone has them on the wrong days.
    if (value.version !== CACHE_VERSION || value.timeZone !== timeZone || typeof value.files !== "object" || value.files === null) return new Map();
    return new Map(Object.entries(value.files));
  } catch { return new Map(); }
}

async function writeCache(stateDir: string, timeZone: string, files: Map<string, CacheEntry>): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const target = join(stateDir, CACHE_FILE);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, timeZone, files: Object.fromEntries(files) }), { mode: 0o600 });
    await rename(temporary, target);
  } catch { /* The cache only saves time; the report is right without it. */ }
}

async function chatDates(stateDir: string): Promise<string[]> {
  let ids: string[];
  try { ids = await readdir(join(stateDir, "chats")); } catch { return []; }
  const dates = await mapLimited(ids, async (id) => {
    try {
      const chat = JSON.parse(await readFile(join(stateDir, "chats", id, "chat.json"), "utf8")) as { createdAt?: unknown };
      return typeof chat.createdAt === "string" ? chat.createdAt : null;
    } catch { return null; }
  });
  return dates.filter((date): date is string => date !== null);
}

/** Dispatches started in the range, and how long each one's agent worked: from its start to the last message the child sent. */
async function megabrainUsage(environment: Environment, stateDir: string, options: UsageStatsOptions): Promise<MegabrainUsage | null> {
  const dayOf = dayReader(options.timeZone);
  const today = dayOf(options.now.toISOString()) ?? "";
  const from = options.days === null ? null : rangeStart(today, options.days);
  const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
  const bounds = from === null ? null : [
    new Date(Date.parse(`${from}T00:00:00.000Z`) - 86_400_000).toISOString(),
    new Date(Date.parse(`${nextDay(today)}`) + 86_400_000).toISOString(),
  ] as const;
  const inRange = (timestamp: string) => {
    const day = dayOf(timestamp);
    return day !== null && (from === null || day >= from) && day <= today;
  };
  const database = readOnlyStateDatabase(environment);
  if (database.kind !== "ok") return null;
  const rows = read(database.value, ({ db }) => db.query<{ created_at: string | null; ended_at: string | null }>(
    `SELECT d.created_at, (SELECT MAX(m.created_at) FROM messages m WHERE m.dispatch_id = d.id AND m."from" = 'child') AS ended_at FROM dispatches d WHERE d.created_at IS NOT NULL${bounds === null ? "" : " AND d.created_at >= ? AND d.created_at < ?"}`,
  ).all(...(bounds ?? [])));
  if (rows.kind !== "ok") return null;
  let dispatches = 0;
  let agentSeconds = 0;
  let since: string | null = null;
  for (const row of rows.value) {
    if (row.created_at === null) continue;
    const day = dayOf(row.created_at);
    if (day !== null && (since === null || day < since)) since = day;
    if (!inRange(row.created_at)) continue;
    dispatches += 1;
    if (row.ended_at === null) continue;
    const seconds = (Date.parse(row.ended_at) - Date.parse(row.created_at)) / 1000;
    if (Number.isFinite(seconds) && seconds > 0) agentSeconds += Math.round(seconds);
  }
  const chats = (await chatDates(stateDir)).filter(inRange).length;
  return { dispatches, agentSeconds, chats, since };
}

/** Reads every agent's logs (through the cache), aggregates them, and adds megabrain's own counts. */
export async function usageStats(environment: Environment, options: UsageStatsOptions): Promise<UsageStats> {
  const started = performance.now();
  const home = environment.HOME ?? process.env.HOME ?? "";
  const stateDir = environment.MEGABRAIN_STATE_DIR ?? join(home, ".megabrain");
  const found = await logFiles(home, options.provider);
  const today = dayReader(options.timeZone)(options.now.toISOString()) ?? options.now.toISOString().slice(0, 10);
  const from = options.days === null ? null : rangeStart(today, options.days);
  // A log cannot contain an entry written after its mtime. Allow 14 hours before local midnight
  // so the cutoff remains conservative for every UTC offset.
  const cutoff = from === null ? null : Date.parse(`${from}T00:00:00.000Z`) - 14 * 60 * 60 * 1000;
  const listed = (await mapLimited(found, async (file): Promise<Listed | null> => {
    try {
      const info = await stat(file.path);
      if (cutoff !== null && info.mtimeMs < cutoff) return null;
      return { ...file, size: info.size, mtimeMs: info.mtimeMs };
    }
    catch (cause: unknown) { throw new Error(`could not inspect usage log ${file.path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
  })).filter((file): file is Listed => file !== null);

  const cache = await readCache(stateDir, options.timeZone);
  const next = new Map<string, CacheEntry>();
  let parsed = 0;
  const usages = await mapLimited(listed, async (file) => {
    const hit = cache.get(file.path);
    if (hit !== undefined && hit.usage !== null && hit.size === file.size && hit.mtimeMs === file.mtimeMs) {
      next.set(file.path, hit);
      return { ...hit.usage, provider: file.provider };
    }
    parsed += 1;
    const usage = await parseFile(file, options.timeZone);
    next.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, usage });
    return { ...usage, provider: file.provider };
  });
  if (parsed > 0 || next.size !== cache.size) await writeCache(stateDir, options.timeZone, next);

  const report = aggregateUsage(usages, options);
  const megabrain = await megabrainUsage(environment, stateDir, options);
  const since = [report.trackingSince, megabrain?.since ?? null].filter((day): day is string => day !== null).sort()[0] ?? null;
  return {
    ...report,
    trackingSince: since,
    megabrain,
    scan: { files: listed.length, parsed, cached: listed.length - parsed, milliseconds: Math.round(performance.now() - started) },
  };
}
