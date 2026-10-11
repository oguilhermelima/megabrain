import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";

export type ClaudeSession = Readonly<{
  pid: number;
  sessionId: string;
  status: "idle" | "busy" | "unknown";
  statusUpdatedAt?: number;
}>;

async function readSession(home: string, pid: number, sessionId: string): Promise<ClaudeSession | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(resolve(home, ".claude", "sessions", `${pid}.json`), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = parsed as Record<string, unknown>;
    if (value.pid !== pid || value.sessionId !== sessionId) return undefined;
    const status = value.status === "idle" ? "idle" : value.status === "busy" || value.status === "not_fully_idle" ? "busy" : "unknown";
    const statusUpdatedAt = typeof value.statusUpdatedAt === "number" && Number.isFinite(value.statusUpdatedAt) ? value.statusUpdatedAt : undefined;
    return { pid, sessionId, status, ...(statusUpdatedAt === undefined ? {} : { statusUpdatedAt }) };
  } catch {
    return undefined;
  }
}

export async function resolveClaudeSession(home: string, pid: number, sessionId: string): Promise<ClaudeSession | undefined> {
  if (sessionId === "") return undefined;
  const current = Number.isSafeInteger(pid) && pid > 0 ? await readSession(home, pid, sessionId) : undefined;
  if (current !== undefined) return current;
  try {
    const directory = resolve(home, ".claude", "sessions");
    const files = (await readdir(directory)).filter((file) => /^\d+\.json$/.test(file)).sort();
    for (const file of files) {
      const candidatePid = Number(file.slice(0, -5));
      const session = await readSession(home, candidatePid, sessionId);
      if (session !== undefined) return session;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function findClaudeSessionPid(sessionId: string, home: string, process: ProcessAdapter, startPid = globalThis.process.pid): Promise<number | undefined> {
  if (sessionId === "") return undefined;
  let pid = startPid;
  const visited = new Set<number>();
  while (Number.isSafeInteger(pid) && pid > 0 && !visited.has(pid)) {
    visited.add(pid);
    if (await readSession(home, pid, sessionId) !== undefined) return pid;
    const parent = await process.run("ps", ["-p", String(pid), "-o", "ppid="]);
    if (parent.kind !== "ok") return undefined;
    const nextPid = Number(parent.value.stdout.trim());
    if (!Number.isSafeInteger(nextPid) || nextPid <= 0 || nextPid === pid) return undefined;
    pid = nextPid;
  }
  return undefined;
}
