import { basename } from "node:path";
import type { ProcessAdapter } from "./proc.js";

// A command runtime that spawns a fresh shell for every command gives each megabrain call a
// different parent pid, so the parent shell cannot name a caller. The stable owner is the nearest
// ancestor that is not a shell or wrapper, tied to its start time so a reused pid never matches.
const transient = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "env", "login", "nohup", "sudo", "tmux", "megabrain"]);
const interpreters = new Set(["node", "bun"]);
const maxDepth = 32;

type Row = Readonly<{ ppid: number; lstart: string; command: string }>;

// One ps call per hop: parent pid, the five-token start time ("Mon Oct 12 01:08:48 2026"), then
// the full command line.
async function processRow(pid: number, processAdapter: ProcessAdapter): Promise<Row | undefined> {
  const result = await processAdapter.run("ps", ["-o", "ppid=", "-o", "lstart=", "-o", "command=", "-p", String(pid)]);
  if (result.kind !== "ok") return undefined;
  const tokens = result.value.stdout.trim().split(/\s+/);
  const ppid = Number(tokens[0]);
  if (!Number.isSafeInteger(ppid) || tokens.length < 7) return undefined;
  return { ppid, lstart: tokens.slice(1, 6).join(" "), command: tokens.slice(6).join(" ") };
}

function isTransient(command: string): boolean {
  const words = command.split(/\s+/);
  const name = basename(words[0] ?? "").replace(/^-/, "").replace(/:$/, "");
  if (transient.has(name)) return true;
  return interpreters.has(name) && /megabrain/.test(command);
}

export async function startTimeOf(pid: number, processAdapter: ProcessAdapter): Promise<string | undefined> {
  const result = await processAdapter.run("ps", ["-o", "lstart=", "-p", String(pid)]);
  const text = result.kind === "ok" ? result.value.stdout.trim() : "";
  return text === "" ? undefined : text;
}

export async function stableAncestorIdentity(startPid: number, processAdapter: ProcessAdapter): Promise<string | undefined> {
  let pid = startPid;
  for (let depth = 0; depth < maxDepth && pid > 1; depth += 1) {
    const row = await processRow(pid, processAdapter);
    if (row === undefined) return undefined;
    if (!isTransient(row.command)) return `proc:${pid}:${row.lstart}`;
    pid = row.ppid;
  }
  return undefined;
}
