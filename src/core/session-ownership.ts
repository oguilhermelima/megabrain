import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";

// Sessions megabrain resumed itself live on the tmux server the desktop app's tmux engine uses.
export const OWNED_TMUX_SERVER = "megabrain-app";

export type OwnableAgent = "claude" | "codex";
export type OwnedSession = Readonly<{ tmuxServer: string; tmuxSession: string; command: string; cwd: string; ownedAt: string }>;
export type OwnedSessions = Readonly<Record<string, OwnedSession>>;
export type SessionOwnerFields = Readonly<{ owner: "megabrain"; tmuxServer: string; tmuxSession: string } | { owner: "external" }>;

export function ownedSessionName(agent: string, id: string): string {
  return `mb-${agent}-${id.slice(0, 8)}`;
}

export function resumeCommand(agent: OwnableAgent, id: string, model?: string): string {
  if (agent === "codex") return `codex resume ${id} --dangerously-bypass-approvals-and-sandbox`;
  return `claude --resume ${id} --dangerously-skip-permissions${model === undefined ? "" : ` --model ${model}`}`;
}

// Every tmux call for an owned session names the server; the default server is never addressed.
export function ownedTmuxProcess(process: ProcessAdapter): ProcessAdapter {
  return {
    ...process,
    run: (command, args, options) => process.run(command, command === "tmux" ? ["-L", OWNED_TMUX_SERVER, ...args] : args, options),
  };
}

function ownershipFile(stateDir: string): string {
  return join(stateDir, "owned-sessions.json");
}

export function readOwnedSessions(stateDir: string): OwnedSessions {
  try {
    const value = JSON.parse(readFileSync(ownershipFile(stateDir), "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as OwnedSessions : {};
  } catch { return {}; }
}

export function writeOwnedSessions(stateDir: string, sessions: OwnedSessions): void {
  const file = ownershipFile(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function sessionOwnerFields(owned: OwnedSessions | undefined, sessionKey: string): SessionOwnerFields {
  const entry = owned?.[sessionKey];
  return entry === undefined ? { owner: "external" } : { owner: "megabrain", tmuxServer: entry.tmuxServer, tmuxSession: entry.tmuxSession };
}
