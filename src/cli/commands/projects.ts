import { open as openFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { openDatabase, withWrite } from "../../db/db.js";
import { listDispatches } from "../../db/queries/dispatches.js";
import { getRepositoryPullRequests, listRepositories, registerRepository, saveRepositoryPullRequests, type RepositoryRecord } from "../../db/queries/repositories.js";
import type { DatabaseAdapter } from "../../db/db.js";
import { listWorktrees } from "../../db/queries/worktrees.js";
import { repositoryCheckout } from "../../core/project-registry.js";
import { readContextMeter } from "../../core/context-meter.js";
import { listHiddenItems } from "../../db/queries/hidden-items.js";

type Environment = Readonly<Record<string, string | undefined>>;
type SessionStatus = "working" | "idle" | "waiting" | "ended";
type ProjectSession = Readonly<{ agent: "claude" | "codex" | "grok" | "agy"; sessionId: string; title: string; status: SessionStatus; startedAt: string | null; lastActivityAt: string | null; dispatchId: string | null; contextTokens?: number | null; cacheExpiresAt?: string | null; idleCompactAt?: string | null }>;
type GitWorktree = Readonly<{ path: string; branch: string | null; head: string | null; primary: boolean; parent: string | null }>;
type Project = Readonly<{ name: string; path: string; remote: string | null; source: "megabrain" | "import"; missing: boolean; worktrees: readonly (GitWorktree & { pullRequest: PullRequestSummary | null; sessions: readonly ProjectSession[] })[] }>;
type Dispatch = ReturnType<typeof listDispatches>[number];
type RawSession = Readonly<{ agent: ProjectSession["agent"]; id: string; cwd: string; title: string; status: SessionStatus; startedAt: string | null; lastActivityAt: string | null; processId?: number }>;

// title and isDraft are null for a value cached before they were read; the cache keeps gh's own JSON.
type PullRequestSummary = Readonly<{ number: number; state: string; url: string; title: string | null; isDraft: boolean | null }>;

const HISTORY_MARKER = "project-registry-backfilled";
const DAY = 86_400_000;
const PULL_REQUEST_CACHE_TTL = 60_000;

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (cause: unknown) { return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPERM"; }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string" && value[key] !== "") return value[key] as string;
  return undefined;
}

function iso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function userTitle(value: unknown): string | undefined {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, 80) || undefined;
  if (Array.isArray(value)) {
    const text = value.filter((part) => typeof part === "object" && part !== null && ["text", "input_text", "output_text"].includes(String((part as Record<string, unknown>).type)))
      .map((part) => (part as Record<string, unknown>).text).filter((part): part is string => typeof part === "string").join(" ");
    return userTitle(text);
  }
  return undefined;
}

async function claudeTitle(home: string, cwd: string, sessionId: string): Promise<string | undefined> {
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

async function codexSessionTitles(home: string): Promise<Map<string, string>> {
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

async function claudeSessions(home: string): Promise<RawSession[]> {
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
      const title = explicitTitle ?? await claudeTitle(home, cwd, id) ?? "Claude";
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

async function grokUserTitle(home: string, cwd: string, sessionId: string): Promise<string | undefined> {
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
  const recent = await processAdapter.run("find", [root, "-type", "f", "-name", "rollout-*.jsonl", "-mmin", "-1440"]);
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

async function codexSessions(home: string, processAdapter: ProcessAdapter, titles: ReadonlyMap<string, string>): Promise<RawSession[]> {
  const paths = await codexRolloutPaths(home, processAdapter);
  const cutoff = Date.now() - DAY;
  const eligible: Array<{ path: string; modified: number }> = [];
  await Promise.all(paths.map(async (path) => {
    try { const info = await stat(path); if (info.mtimeMs >= cutoff) eligible.push({ path, modified: info.mtimeMs }); } catch { /* A rollout may be rotated while listing. */ }
  }));
  const ps = await processAdapter.run("ps", ["-axo", "pid=,command="]);
  const codexPids = ps.kind === "ok" ? ps.value.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match !== null && /(?:^|\/)codex(?:\s|$)|Codex\.app/.test(match[2] ?? "") ? [match[1] as string] : [];
  }) : [];
  const cwdByPid = new Map<number, string>();
  if (codexPids.length > 0) {
    const cwd = await processAdapter.run("lsof", ["-a", "-p", codexPids.join(","), "-d", "cwd", "-Fn"]);
    if (cwd.kind === "ok") {
      let pid: number | undefined;
      for (const line of cwd.value.stdout.split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (line.startsWith("n") && pid !== undefined) cwdByPid.set(pid, resolve(line.slice(1)));
      }
    }
  }
  const found = await Promise.all(eligible.map(async ({ path, modified }): Promise<RawSession | undefined> => {
    try {
      const file = await import("node:fs/promises").then(({ open }) => open(path, "r"));
      let head: string;
      try { const buffer = Buffer.alloc(256 * 1024); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); head = buffer.subarray(0, bytesRead).toString("utf8"); }
      finally { await file.close(); }
      for (const line of head.split("\n")) {
        const value = record(JSON.parse(line) as unknown);
        if (value?.type === "session_meta") {
          const payload = record(value.payload);
          const cwd = stringField(payload ?? {}, "cwd");
          const id = stringField(payload ?? {}, "session_id", "id");
          if (cwd === undefined || id === undefined) return undefined;
          const pid = [...cwdByPid.entries()].find(([, processCwd]) => processCwd === resolve(cwd))?.[0];
          const startedAt = iso(payload?.timestamp) ?? iso(value.timestamp);
          const firstUserMessage = codexUserTitle(head);
          return { agent: "codex", id, cwd: resolve(cwd), title: titles.get(id) ?? firstUserMessage ?? "Codex", status: pid === undefined ? "ended" : "working", startedAt, lastActivityAt: new Date(modified).toISOString(), ...(pid === undefined ? {} : { processId: pid }) };
        }
      }
    } catch { /* Ignore malformed or unavailable rollout headers. */ }
    return undefined;
  }));
  return found.filter((value): value is RawSession => value !== undefined);
}

function codexUserTitle(contents: string): string | undefined {
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

async function sessionsForMachine(home: string, processAdapter: ProcessAdapter): Promise<RawSession[]> {
  const [claude, grok, codexTitles] = await Promise.all([claudeSessions(home), grokSessions(home), codexSessionTitles(home)]);
  const codex = await codexSessions(home, processAdapter, codexTitles);
  const unique = new Map<string, RawSession>();
  for (const session of [...claude, ...grok, ...codex]) unique.set(`${session.agent}:${session.id}`, session);
  return [...unique.values()];
}

function dispatchForSession(session: RawSession, worktree: string, dispatches: readonly Dispatch[]): Dispatch | null {
  const matches = dispatches.filter((dispatch) => dispatch.worktreePath === worktree && dispatch.agent === session.agent);
  const exact = matches.find((dispatch) => ["agentThreadId", "agentSessionId", "grokSessionId", "codexSessionId"].some((key) => dispatch[key] === session.id));
  if (exact !== undefined) return exact;
  const started = session.startedAt === null ? Number.NaN : Date.parse(session.startedAt);
  const timed = matches.map((dispatch) => ({ dispatch, created: typeof dispatch.createdAt === "string" ? Date.parse(dispatch.createdAt) : Number.NaN }))
    .filter((item) => Number.isFinite(started) && Number.isFinite(item.created) && Math.abs(item.created - started) <= 10 * 60_000)
    .sort((left, right) => Math.abs(left.created - started) - Math.abs(right.created - started));
  return timed[0]?.dispatch ?? null;
}

function projectSessions(path: string, found: readonly RawSession[], dispatches: readonly Dispatch[]): ProjectSession[] {
  const now = Date.now();
  const sessions = found.filter((session) => session.cwd === resolve(path)).map((session): ProjectSession => {
    const dispatch = dispatchForSession(session, path, dispatches);
    const title = stringField(dispatch ?? {}, "label", "chatName") ?? session.title;
    return {
      agent: session.agent,
      sessionId: `${session.agent}:${session.id}`,
      title: title.slice(0, 80),
      status: dispatch?.state === "waiting_for_reply" ? "waiting" : session.status,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      dispatchId: dispatch?.dispatchId ?? null,
    };
  });
  const live = sessions.filter((session) => session.status !== "ended");
  const ended = sessions.filter((session) => session.status === "ended" && session.lastActivityAt !== null && now - Date.parse(session.lastActivityAt) <= DAY)
    .sort((left, right) => Date.parse(right.lastActivityAt ?? "") - Date.parse(left.lastActivityAt ?? "")).slice(0, 5);
  return [...live, ...ended];
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

async function repositoryPullRequests(repository: RepositoryRecord, database: DatabaseAdapter, processAdapter: ProcessAdapter): Promise<Map<string, PullRequestSummary>> {
  const cached = getRepositoryPullRequests(database, repository.path);
  const stale = cachedPullRequestMap(cached?.value);
  const now = Date.now();
  if (stale !== undefined && cached !== undefined && cached.fetchedAt <= now && now - cached.fetchedAt < PULL_REQUEST_CACHE_TTL) return stale;
  const refreshed = await processAdapter.run("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "headRefName,number,state,url,title,isDraft"], { cwd: repository.path, timeoutMs: 2_000 });
  if (refreshed.kind === "ok") {
    try {
      const parsed: unknown = JSON.parse(refreshed.value.stdout);
      if (Array.isArray(parsed)) {
        saveRepositoryPullRequests(database, repository.path, JSON.stringify(parsed), now);
        return pullRequestMap(parsed);
      }
    } catch { /* Keep the last known good result on malformed output. */ }
  }
  saveRepositoryPullRequests(database, repository.path, stale === undefined || cached === undefined ? "[]" : cached.value, now);
  return stale ?? new Map();
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
  const measured = await Promise.all(sessions.map(async (session) => {
    const sessionId = session.sessionId.slice(session.agent.length + 1);
    const meter = await readContextMeter({
      agent: session.agent,
      agentSessionId: sessionId,
      agentCwd: cwd,
      ...(session.agent === "claude" ? { agentTranscriptPath: join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`) } : {}),
    }, home);
    return { session, contextTokens: meter.status === "known" ? meter.usedTokens : null };
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

async function repositoryProject(repository: RepositoryRecord, found: readonly RawSession[], dispatches: readonly Dispatch[], processAdapter: ProcessAdapter, database: DatabaseAdapter, home: string, environment: Environment): Promise<Project> {
  const checkout = await repositoryCheckout(repository.path, processAdapter);
  if (checkout.kind !== "ok") return { name: repository.name, path: repository.path, remote: repository.remote, source: repository.source, missing: true, worktrees: [] };
  const [worktreesResult, parentsResult, pulls] = await Promise.all([
    processAdapter.run("git", ["-C", repository.path, "worktree", "list", "--porcelain"]),
    processAdapter.run("git", ["-C", repository.path, "config", "--get-regexp", "^branch\\..*\\.megabrain-parent$"]),
    repositoryPullRequests(repository, database, processAdapter),
  ]);
  if (worktreesResult.kind !== "ok") return { name: repository.name, path: repository.path, remote: repository.remote, source: repository.source, missing: true, worktrees: [] };
  const parents = new Map<string, string>();
  if (parentsResult.kind === "ok") for (const line of parentsResult.value.stdout.split("\n")) {
    const match = /^branch\.(.*)\.megabrain-parent\s+(.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) parents.set(match[1], match[2]);
  }
  const worktrees = await Promise.all(parseWorktrees(worktreesResult.value.stdout, repository.path, parents).map(async (worktree) => ({
    ...worktree,
    pullRequest: worktree.branch === null ? null : pulls.get(worktree.branch) ?? null,
    sessions: await timedSessions(projectSessions(worktree.path, found, dispatches), home, worktree.path, environment),
  })));
  return { name: repository.name, path: repository.path, remote: repository.remote, source: repository.source, missing: false, worktrees };
}

export async function backfillProjectHistory(environment: Environment, processAdapter: ProcessAdapter): Promise<Result<void>> {
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  const handle = opened.value;
  try {
    const marker = handle.db.query<{ value: string }>("SELECT value FROM settings WHERE key = ?").get(HISTORY_MARKER);
    if (marker !== null) return ok(undefined);
    const candidates = new Set<string>();
    for (const worktree of listWorktrees(handle.db)) candidates.add(worktree.repo);
    for (const dispatch of listDispatches(handle.db, { includeArchived: true })) if (typeof dispatch.worktreePath === "string" && dispatch.worktreePath !== "") candidates.add(dispatch.worktreePath);
    const resolved = await Promise.all([...candidates].map((path) => repositoryCheckout(path, processAdapter)));
    const records = resolved.flatMap((item) => item.kind === "ok" ? [{ ...item.value, source: "megabrain" as const, addedAt: new Date().toISOString() }] : []);
    const written = withWrite(handle, (db) => {
      if (db.query<{ value: string }>("SELECT value FROM settings WHERE key = ?").get(HISTORY_MARKER) !== null) return;
      for (const repository of records) registerRepository(db, repository);
      db.run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING", [HISTORY_MARKER, new Date().toISOString(), new Date().toISOString()]);
    });
    return written.kind === "ok" ? ok(undefined) : failed(written.error, written.exitCode);
  } finally { handle.close(); }
}

export async function executeProjects(args: readonly string[], environment: Environment, processAdapter = createProcessAdapter()): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok("Usage: megabrain projects [--json]\n");
  if (args.some((argument) => argument !== "--json")) return failed("Usage: megabrain projects [--json]", 2);
  const backfilled = await backfillProjectHistory(environment, processAdapter);
  if (backfilled.kind !== "ok") return backfilled;
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  try {
    const repositories = listRepositories(opened.value.db);
    const dispatches = listDispatches(opened.value.db, { includeArchived: true });
    const home = environment.HOME ?? process.env.HOME ?? "";
    const found = await sessionsForMachine(home, processAdapter);
    const hiddenItems = new Set(listHiddenItems(opened.value.db).map((item) => `${item.kind}:${item.path}`));
    const projects = await Promise.all(repositories.map(async (repository) => {
      const project = await repositoryProject(repository, found, dispatches, processAdapter, opened.value.db, home, environment);
      return { ...project, hidden: hiddenItems.has(`repo:${repository.path}`), worktrees: project.worktrees.map((tree) => ({ ...tree, hidden: hiddenItems.has(`worktree:${tree.path}`) })) };
    }));
    return ok(`${JSON.stringify(projects, null, 2)}\n`);
  } finally { opened.value.close(); }
}
