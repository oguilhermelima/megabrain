import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProcessAdapter } from "./proc.js";

// Grok and Agy export no session id to the commands they run, but each records which live process
// holds which session (measured 2026-10-12, Grok 1.0.52 and Antigravity CLI 1.3.3):
// - Grok writes <GROK_HOME>/active_sessions.json, [{session_id, pid, cwd, opened_at}], one entry per
//   live process; `grok --resume <id>` lists the same session_id under the new pid.
// - Agy holds <home>/.gemini/antigravity-cli/presence/<conversation>.lock open from its first
//   prompt on, and `agy --conversation <id>` holds the same lock.
// The agent is the caller's stable ancestor (adapters/ancestor.ts), so its pid is the key.

type Environment = Readonly<Record<string, string | undefined>>;
type Ancestor = Readonly<{ pid: number; command: string }>;
export type SessionLiveness = "alive" | "not-alive" | "unknown";

function grokHome(environment: Environment): string {
  return environment.GROK_HOME ?? join(environment.HOME ?? "", ".grok");
}

function grokSessions(environment: Environment): ReadonlyArray<{ sessionId: string; pid: number }> | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(grokHome(environment), "active_sessions.json"), "utf8")); } catch { return undefined; }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    return typeof record.session_id === "string" && record.session_id !== "" && typeof record.pid === "number" ? [{ sessionId: record.session_id, pid: record.pid }] : [];
  });
}

const AGY_PRESENCE = /\/\.gemini\/antigravity-cli\/presence\/([0-9a-f-]{36})\.lock$/;

function agyPresenceLock(environment: Environment, conversation: string): string {
  return join(environment.HOME ?? "", ".gemini", "antigravity-cli", "presence", `${conversation}.lock`);
}

export async function agentSessionOf(ancestor: Ancestor, environment: Environment, processAdapter: ProcessAdapter): Promise<string | undefined> {
  const name = basename(ancestor.command.split(/\s+/)[0] ?? "");
  if (name === "grok") {
    const session = grokSessions(environment)?.find((entry) => entry.pid === ancestor.pid);
    return session === undefined ? undefined : `grok:${session.sessionId}`;
  }
  if (name === "agy") {
    const result = await processAdapter.run("lsof", ["-Fn", "-p", String(ancestor.pid)]);
    if (result.kind !== "ok") return undefined;
    for (const line of result.value.stdout.split("\n")) {
      const match = line.startsWith("n") ? AGY_PRESENCE.exec(line.slice(1)) : null;
      if (match?.[1] !== undefined) return `agy:${match[1]}`;
    }
  }
  return undefined;
}

// A grok session is alive while any listed pid for it still runs; an agy conversation while any
// process holds its presence lock.
export async function agentSessionLiveness(owner: string, environment: Environment, processAdapter: ProcessAdapter): Promise<SessionLiveness> {
  const grok = /^grok:(.+)$/.exec(owner)?.[1];
  if (grok !== undefined) {
    const sessions = grokSessions(environment);
    if (sessions === undefined) return "unknown";
    for (const session of sessions.filter((entry) => entry.sessionId === grok)) {
      const result = await processAdapter.run("ps", ["-o", "lstart=", "-p", String(session.pid)]);
      if (result.kind === "ok" && result.value.stdout.trim() !== "") return "alive";
    }
    return "not-alive";
  }
  const agy = /^agy:(.+)$/.exec(owner)?.[1];
  if (agy !== undefined) {
    const lock = agyPresenceLock(environment, agy);
    const result = await processAdapter.run("lsof", ["-t", lock]);
    if (result.kind === "ok") return result.value.stdout.trim() === "" ? "not-alive" : "alive";
    if (result.kind === "failed" && (result.error === "lsof exited with status 1" || !existsSync(lock))) return "not-alive";
  }
  return "unknown";
}
