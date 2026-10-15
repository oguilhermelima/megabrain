import { open as openFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { openDatabase, withWrite } from "../../db/db.js";
import { listDispatches } from "../../db/queries/dispatches.js";
import { listRepositories, registerRepository, type RepositoryRecord } from "../../db/queries/repositories.js";
import { listWorktrees } from "../../db/queries/worktrees.js";
import { repositoryCheckout } from "../../core/project-registry.js";

type Environment = Readonly<Record<string, string | undefined>>;
type SessionStatus = "working" | "idle" | "waiting" | "ended";
type ProjectSession = Readonly<{ agent: "claude" | "codex" | "grok" | "agy"; sessionId: string; title: string; status: SessionStatus; startedAt: string | null; lastActivityAt: string | null; dispatchId: string | null }>;
type GitWorktree = Readonly<{ path: string; branch: string | null; head: string | null; primary: boolean; parent: string | null }>;
type Project = Readonly<{ name: string; path: string; remote: string | null; source: "megabrain" | "import"; missing: boolean; worktrees: readonly (GitWorktree & { pullRequest: { number: number; state: string; url: string } | null; sessions: readonly ProjectSession[] })[] }>;
type Dispatch = ReturnType<typeof listDispatches>[number];
type RawSession = Readonly<{ agent: ProjectSession["agent"]; id: string; cwd: string; title: string; status: SessionStatus; startedAt: string | null; lastActivityAt: string | null; processId?: number }>;

const HISTORY_MARKER = "project-registry-backfilled";
const DAY = 86_400_000;

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

function codexRolloutPaths(home: string): Promise<string[]> {
  const root = join(home, ".codex", "sessions");
  return readdir(root).catch(() => []).then(async (years) => {
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
  });
}

async function codexSessions(home: string, processAdapter: ProcessAdapter, titles: ReadonlyMap<string, string>): Promise<RawSession[]> {
  const paths = await codexRolloutPaths(home);
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

function pullRequestMap(value: unknown): Map<string, { number: number; state: string; url: string }> {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.flatMap((item) => {
    const entry = record(item);
    if (entry === undefined || typeof entry.headRefName !== "string" || typeof entry.number !== "number" || typeof entry.state !== "string" || typeof entry.url !== "string") return [];
    return [[entry.headRefName, { number: entry.number, state: entry.state, url: entry.url }] as const];
  }));
}

async function repositoryProject(repository: RepositoryRecord, found: readonly RawSession[], dispatches: readonly Dispatch[], processAdapter: ProcessAdapter): Promise<Project> {
  const checkout = await repositoryCheckout(repository.path, processAdapter);
  if (checkout.kind !== "ok") return { name: repository.name, path: repository.path, remote: repository.remote, source: repository.source, missing: true, worktrees: [] };
  const [worktreesResult, parentsResult, pullResult] = await Promise.all([
    processAdapter.run("git", ["-C", repository.path, "worktree", "list", "--porcelain"]),
    processAdapter.run("git", ["-C", repository.path, "config", "--get-regexp", "^branch\\..*\\.megabrain-parent$"]),
    processAdapter.run("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "headRefName,number,state,url"], { cwd: repository.path, timeoutMs: 2_000 }),
  ]);
  if (worktreesResult.kind !== "ok") return { name: repository.name, path: repository.path, remote: repository.remote, source: repository.source, missing: true, worktrees: [] };
  const parents = new Map<string, string>();
  if (parentsResult.kind === "ok") for (const line of parentsResult.value.stdout.split("\n")) {
    const match = /^branch\.(.*)\.megabrain-parent\s+(.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) parents.set(match[1], match[2]);
  }
  let pulls = new Map<string, { number: number; state: string; url: string }>();
  if (pullResult.kind === "ok") {
    try { pulls = pullRequestMap(JSON.parse(pullResult.value.stdout) as unknown); }
    catch { pulls = new Map(); }
  }
  const worktrees = parseWorktrees(worktreesResult.value.stdout, repository.path, parents).map((worktree) => ({
    ...worktree,
    pullRequest: worktree.branch === null ? null : pulls.get(worktree.branch) ?? null,
    sessions: projectSessions(worktree.path, found, dispatches),
  }));
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
  let repositories: RepositoryRecord[];
  let dispatches: Dispatch[];
  try { repositories = listRepositories(opened.value.db); dispatches = listDispatches(opened.value.db, { includeArchived: true }); }
  finally { opened.value.close(); }
  const home = environment.HOME ?? process.env.HOME ?? "";
  const found = await sessionsForMachine(home, processAdapter);
  const projects = await Promise.all(repositories.map((repository) => repositoryProject(repository, found, dispatches, processAdapter)));
  return ok(`${JSON.stringify(projects, null, 2)}\n`);
}
