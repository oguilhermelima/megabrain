import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { failed, ok, type Result } from "../../core/result.js";
import { parsePruneArgs, pruneDecision, pruneStates, type PruneOptions } from "../../core/orchestrate-prune.js";
import { reconcileDecision } from "../../core/orchestrate-reconcile.js";
import { dispatchArchiveDirectory, dispatchArchiveParentDirectory, liveDispatchDirectories } from "../../adapters/dispatch-store.js";
import { resolveStateDirectory } from "../../core/state.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { atomicJson } from "./queue-write.js";

type RecordValue = Record<string, unknown>;
type Environment = Readonly<Record<string, string | undefined>>;
type Entry = Readonly<{ id: string; meta: RecordValue; directory: string }>;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function text(value: unknown): string { return typeof value === "string" ? value : ""; }

function normalizeMetadata(meta: RecordValue): RecordValue {
  const state = text(meta.state);
  if (state !== "stalled" && state !== "timeout") return meta;
  return {
    ...meta,
    state: "running",
    ...(meta.processState === undefined ? { processState: "running" } : {}),
  };
}

function containsTerminal(value: unknown, host: string, id: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsTerminal(item, host, id));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, item]) => (host === "orca" && key === "handle" && item === id) || (host === "superset" && key === "terminalId" && item === id) || containsTerminal(item, host, id));
}

async function terminalStatus(meta: RecordValue, process: ProcessAdapter): Promise<"proven" | "missing" | "unknown"> {
  if (text(meta.runtime) !== "tmux") return "unknown";
  const session = await process.run("tmux", ["has-session", "-t", text(meta.tmuxSession)]);
  if (session.kind !== "ok") return "missing";
  const panes = await process.run("tmux", ["list-panes", "-t", text(meta.tmuxSession), "-F", "#{pane_id}"]);
  if (panes.kind !== "ok") return "unknown";
  return panes.value.stdout.split("\n").includes(text(meta.tmuxPane)) ? "proven" : "missing";
}

async function childIdentityProof(directory: string): Promise<boolean> {
  const names = await readdir(`${directory}/messages`).catch(() => []);
  return names.some((name) => name.includes("-child-"));
}

async function reconcileEntry(entry: Entry, process: ProcessAdapter): Promise<RecordValue> {
  const state = text(entry.meta.state);
  const processState = text(entry.meta.processState);
  const terminalState = text(entry.meta.terminalState);
  const needsReconcile = ["spawning", "running", "waiting_for_reply"].includes(state) &&
    (terminalState === "retained" || ["start-unproven", "stop-unproven", "abandoned", "exited"].includes(processState));
  if (!needsReconcile) return entry.meta;
  const terminal = await terminalStatus(entry.meta, process);
  const proven = terminal === "proven" || await childIdentityProof(entry.directory);
  let parent: "alive" | "gone" | "unknown" = "unknown";
  const parentSession = text(entry.meta.parentTmuxSession);
  if (proven && parentSession !== "") parent = (await process.run("tmux", ["has-session", "-t", parentSession])).kind === "ok" ? "alive" : "gone";
  const decision = reconcileDecision(entry.meta, proven ? "proven" : terminal, parent);
  if (decision.outcome === "unchanged") return entry.meta;
  const next: RecordValue = { ...entry.meta, ...decision.updates, reconcileOutcome: decision.outcome, updatedAt: new Date().toISOString() };
  await atomicJson(`${entry.directory}/meta.json`, next);
  return next;
}

function hostTerminalArgs(meta: RecordValue): { readonly command: string; readonly args: readonly string[]; readonly host: string } | undefined {
  const host = text(meta.childHost);
  if (host === "orca") return { command: "orca", args: ["terminal", "list", "--json"], host };
  if (host === "superset") return { command: "megabrain_superset", args: ["terminals", "list", "--workspace", text(meta.workspaceId), "--json"], host };
  return undefined;
}

async function releaseBeforePrune(meta: RecordValue, process: ProcessAdapter): Promise<Result<void>> {
  const terminalState = text(meta.terminalState);
  if (terminalState === "released" || terminalState === "missing") return ok(undefined);
  if (terminalState === "retained") return failed("terminal identity is unproven");
  if (text(meta.runtime) === "tmux") {
    const session = await process.run("tmux", ["has-session", "-t", text(meta.tmuxSession)]);
    if (session.kind !== "ok") return ok(undefined);
    const panes = await process.run("tmux", ["list-panes", "-t", text(meta.tmuxSession), "-F", "#{pane_id}"]);
    if (panes.kind !== "ok") return failed("terminal identity is unproven");
    return panes.value.stdout.split("\n").includes(text(meta.tmuxPane)) ? failed("terminal identity is unproven") : ok(undefined);
  }
  const listing = hostTerminalArgs(meta);
  if (listing === undefined) return failed("terminal identity is unproven");
  const terminals = await process.run(listing.command, listing.args);
  if (terminals.kind !== "ok") return failed("terminal identity is unproven");
  let parsed: unknown;
  try { parsed = JSON.parse(terminals.value.stdout); } catch { return failed("terminal identity is unproven"); }
  if (!containsTerminal(parsed, listing.host, text(meta.terminalId))) return ok(undefined);
  const closeCommand = listing.host === "orca" ? "orca" : "megabrain_superset";
  const closeArgs = listing.host === "orca" ? ["terminal", "close", "--terminal", text(meta.terminalId), "--json"] : ["terminals", "close", "--workspace", text(meta.workspaceId), "--terminal", text(meta.terminalId), "--json"];
  const closed = await process.run(closeCommand, closeArgs);
  if (closed.kind === "ok" || /not found|does not exist|no such|already closed|already gone|already deleted|404/i.test(closed.error)) return ok(undefined);
  return failed("could not release dispatch terminal");
}

async function entries(root: string): Promise<Entry[]> {
  const result: Entry[] = [];
  for (const directory of await liveDispatchDirectories(root)) {
    try {
      const parsed = JSON.parse(await readFile(`${directory}/meta.json`, "utf8")) as RecordValue;
      const meta = normalizeMetadata(parsed);
      if (meta !== parsed) await atomicJson(`${directory}/meta.json`, meta);
      if (typeof meta.dispatchId === "string") result.push({ id: meta.dispatchId, meta, directory });
    } catch { /* shell ignores unreadable metadata */ }
  }
  return result;
}

export async function executeOrchestratePrune(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate prune [--older-than <days>] [--state <list>] [--archive|--delete] [--dry-run] [--json]\n");
  const parsed = parsePruneArgs(args); if (parsed.kind !== "ok") return parsed;
  const options: PruneOptions = parsed.value; const root = resolveStateDirectory(environment); const now = new Date(); const month = now.toISOString().slice(0, 7);
  const archived: Array<{ dispatchId: string; path: string }> = []; const deleted: string[] = []; const skipped: Array<{ dispatchId: string; state: string | null; reason: string }> = [];
  for (const entry of await entries(root)) {
    let meta = entry.meta;
    try { meta = await reconcileEntry(entry, process); } catch { skipped.push({ dispatchId: entry.id, state: text(meta.state) || null, reason: "could not reconcile dispatch" }); continue; }
    const decision = pruneDecision(meta, options, now);
    if (!decision.eligible) { skipped.push({ dispatchId: entry.id, state: typeof entry.meta.state === "string" ? entry.meta.state : null, reason: decision.reason ?? "not eligible" }); continue; }
    if (!options.dryRun) {
      const released = await releaseBeforePrune(meta, process);
      if (released.kind !== "ok") { skipped.push({ dispatchId: entry.id, state: text(meta.state) || null, reason: released.error }); continue; }
    }
    if (options.mode === "archive") {
      const target = dispatchArchiveDirectory(root, month, entry.id); archived.push({ dispatchId: entry.id, path: target });
      if (!options.dryRun) { try { await mkdir(dispatchArchiveParentDirectory(root, month), { recursive: true }); await rename(entry.directory, target); } catch { archived.pop(); skipped.push({ dispatchId: entry.id, state: typeof entry.meta.state === "string" ? entry.meta.state : null, reason: "could not archive dispatch" }); } }
    } else { deleted.push(entry.id); if (!options.dryRun) { try { await rm(entry.directory, { recursive: true, force: true }); } catch { deleted.pop(); skipped.push({ dispatchId: entry.id, state: typeof entry.meta.state === "string" ? entry.meta.state : null, reason: "could not delete dispatch" }); } } }
  }
  const result = { mode: options.mode, dryRun: options.dryRun, olderThanDays: options.olderThan, archived, deleted, skipped };
  if (options.json) return ok(json({ ...result, archived: archived.length, deleted: deleted.length, skipped: skipped.length, archivedDispatches: archived, deletedDispatches: deleted, skippedDispatches: skipped }));
  const lines = [`mode: ${options.mode}`, `dry-run: ${options.dryRun}`, `older-than-days: ${options.olderThan}`];
  for (const item of options.mode === "archive" ? archived : deleted.map((dispatchId) => ({ dispatchId }))) lines.push(`${options.dryRun ? "would" : ""} ${options.mode}: ${item.dispatchId}`.replace(/^ /, ""));
  lines.push(`skipped: ${skipped.length}`, ...skipped.map((item) => `skipped: ${item.dispatchId} (${item.reason})`)); return ok(`${lines.join("\n")}\n`);
}
