import { rm } from "node:fs/promises";
import { failed, ok, type Result } from "../../core/result.js";
import { parsePruneArgs, pruneDecision, pruneStates, type PruneOptions } from "../../core/orchestrate-prune.js";
import { reconcileDecision } from "../../core/orchestrate-reconcile.js";
import { dispatchArchiveDirectory } from "../../adapters/dispatch-store.js";
import { resolveStateDirectory } from "../../core/state.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { tmuxCallerPaneSession } from "./queue-write.js";
import { getHost } from "../../hosts/index.js";
import { getTmux } from "../../hosts/tmux.js";
import { hostCloseReason, isHostTerminalAbsent } from "../../core/orchestrate-close.js";
import { usageText } from "../../core/usage.js";
import { stateDatabase, listDispatches, listMessages, mutateDispatch, archiveDispatch, deleteDispatch, transcriptPath } from "../../adapters/state-db.js";
import type { DatabaseHandle } from "../../db/db.js";

type RecordValue = Record<string, unknown>;
type Environment = Readonly<Record<string, string | undefined>>;
type Entry = Readonly<{ id: string; meta: RecordValue }>;
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
  const session = await getTmux().sessionExists(text(meta.tmuxSession), process);
  if (session.kind !== "ok") return "missing";
  const panes = await getTmux().panesForSession(text(meta.tmuxSession), process);
  if (panes.kind !== "ok") return "unknown";
  return panes.value.includes(text(meta.tmuxPane)) ? "proven" : "missing";
}

function childIdentityProof(handle: DatabaseHandle, dispatchId: string): boolean {
  const messages = listMessages(handle, dispatchId);
  return messages.kind === "ok" && messages.value.some((message) => message.from === "child");
}

async function reconcileEntry(handle: DatabaseHandle, entry: Entry, process: ProcessAdapter): Promise<RecordValue> {
  const state = text(entry.meta.state);
  const processState = text(entry.meta.processState);
  const terminalState = text(entry.meta.terminalState);
  const needsReconcile = ["spawning", "running", "waiting_for_reply"].includes(state) &&
    (terminalState === "retained" || ["start-unproven", "stop-unproven", "abandoned", "exited"].includes(processState));
  if (!needsReconcile) return entry.meta;
  const terminal = await terminalStatus(entry.meta, process);
  const proven = terminal === "proven" || childIdentityProof(handle, entry.id);
  let parent: "alive" | "gone" | "unknown" = "unknown";
  const parentSession = text(entry.meta.parentTmuxSession);
  if (proven && parentSession !== "") parent = (await getTmux().sessionExists(parentSession, process)).kind === "ok" ? "alive" : "gone";
  const decision = reconcileDecision(entry.meta, proven ? "proven" : terminal, parent);
  if (decision.outcome === "unchanged") return entry.meta;
  const next: RecordValue = { ...entry.meta, ...decision.updates, reconcileOutcome: decision.outcome, updatedAt: new Date().toISOString() };
  const updated = mutateDispatch(handle, entry.id, () => next);
  return updated.kind === "ok" ? updated.value : entry.meta;
}

function hostTerminalArgs(meta: RecordValue): { readonly command: string; readonly args: readonly string[]; readonly host: string } | undefined {
  const host = text(meta.childHost);
  const call = getHost(host)?.list({ workspaceId: text(meta.workspaceId) || null });
  return call?.kind === "ok" ? { ...call.value, host } : undefined;
}

type ReleaseResult = { readonly kind: "gone" } | { readonly kind: "unproven"; readonly reason: string } | { readonly kind: "blocked"; readonly reason: string };
const gone: ReleaseResult = { kind: "gone" };
const unproven = (reason: string): ReleaseResult => ({ kind: "unproven", reason });
const blocked = (reason: string): ReleaseResult => ({ kind: "blocked", reason });

async function releaseBeforePrune(meta: RecordValue, environment: Environment, process: ProcessAdapter, dryRun: boolean): Promise<ReleaseResult> {
  const terminalState = text(meta.terminalState);
  if (terminalState === "released" || terminalState === "missing") return gone;
  if (terminalState === "retained") return blocked(text(meta.terminalReason) || "terminal identity is unproven");
  if (text(meta.runtime) === "tmux") {
    const session = await getTmux().sessionExists(text(meta.tmuxSession), process);
    if (session.kind === "ok" && !session.value) return gone;
    // Close treats a tmux session it cannot query as already absent and proceeds. Keep prune's
    // behavior aligned with that established close contract; pane-list failures remain unproven.
    if (session.kind !== "ok") return gone;
    const panes = await getTmux().panesForSession(text(meta.tmuxSession), process);
    if (panes.kind !== "ok") return blocked("terminal identity is unproven");
    if (!panes.value.includes(text(meta.tmuxPane))) return gone;
    const sessionName = text(meta.tmuxSession);
    const shared = sessionName === text(meta.parentTmuxSession);
    let callerSession: string | undefined;
    if (environment.TMUX && environment.TMUX_PANE) {
      callerSession = await tmuxCallerSession(environment, process);
      if (callerSession === sessionName && environment.TMUX_PANE === text(meta.tmuxPane)) return blocked("terminal is the calling tmux pane");
    }
    if (dryRun) return gone;
    const paneIds = panes.value;
    const released = shared || callerSession === sessionName || paneIds.length > 1
      ? await getTmux().killPane(text(meta.tmuxPane), process)
      : await getTmux().killSession(sessionName, process);
    return released.kind === "ok" ? gone : blocked("could not release dispatch terminal");
  }
  const listing = hostTerminalArgs(meta);
  if (listing === undefined) return blocked("terminal identity is unproven");
  const terminals = await process.run(listing.command, listing.args);
  if (terminals.kind !== "ok") return blocked("terminal identity is unproven");
  let parsed: unknown;
  try { parsed = JSON.parse(terminals.value.stdout); } catch { return blocked("terminal identity is unproven"); }
  const listed = containsTerminal(parsed, listing.host, text(meta.terminalId));
  if (!listed && dryRun) return unproven("terminal is absent from the host listing");
  if (dryRun) return gone;
  const close = getHost(listing.host)?.close({ workspaceId: text(meta.workspaceId) || null, terminalId: text(meta.terminalId) });
  if (close === undefined || close.kind !== "ok") return listed ? blocked("could not release dispatch terminal") : unproven("terminal is absent from the host listing");
  const closed = await process.run(close.value.command, close.value.args);
  if (closed.kind === "ok") return gone;
  const closeOutput = closed.kind === "failed" && closed.stdout?.trim() ? closed.stdout : closed.error;
  const reason = hostCloseReason(closeOutput);
  if (isHostTerminalAbsent(reason)) return gone;
  return listed ? blocked("could not release dispatch terminal") : unproven("terminal is absent from the host listing");
}

// The tmux session this caller is itself physically running in — used only to avoid pruning the
// pane the operator is typing into. This is a physical question, not an identity one: an
// override (MEGABRAIN_SESSION_ID/HOST, a terminal handle) must never suppress the probe, so this
// goes through queue-write.js tmuxCallerPaneSession (the raw probe), not resolveCaller.
export async function tmuxCallerSession(environment: Environment, process: ProcessAdapter): Promise<string | undefined> {
  return tmuxCallerPaneSession(environment, process);
}

function entries(handle: DatabaseHandle): Entry[] {
  const records = listDispatches(handle);
  if (records.kind !== "ok") return [];
  return records.value.map((record) => {
    const meta = normalizeMetadata(record as RecordValue);
    if (meta !== record) {
      const updated = mutateDispatch(handle, record.dispatchId, () => meta);
      if (updated.kind === "ok") return { id: record.dispatchId, meta: updated.value as RecordValue };
    }
    return { id: record.dispatchId, meta };
  });
}

export async function executeOrchestratePrune(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-prune"));
  const parsed = parsePruneArgs(args); if (parsed.kind !== "ok") return parsed;
  const options: PruneOptions = parsed.value; const root = resolveStateDirectory(environment); const now = new Date(); const month = now.toISOString().slice(0, 7);
  const opened = stateDatabase(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  const handle = opened.value;
  const archived: Array<{ dispatchId: string; path: string }> = []; const deleted: string[] = []; const skipped: Array<{ dispatchId: string; state: string | null; reason: string }> = []; const terminalNotProvenGone: Array<{ dispatchId: string; reason: string }> = [];
  for (const entry of entries(handle)) {
    let meta = entry.meta;
    try { meta = await reconcileEntry(handle, entry, process); } catch { skipped.push({ dispatchId: entry.id, state: text(meta.state) || null, reason: "could not reconcile dispatch" }); continue; }
    const decision = pruneDecision(meta, options, now);
    if (!decision.eligible) { skipped.push({ dispatchId: entry.id, state: typeof entry.meta.state === "string" ? entry.meta.state : null, reason: decision.reason ?? "not eligible" }); continue; }
    const released = await releaseBeforePrune(meta, environment, process, options.dryRun);
    if (released.kind === "unproven") {
      terminalNotProvenGone.push({ dispatchId: entry.id, reason: released.reason });
      if (!options.dryRun) mutateDispatch(handle, entry.id, () => ({
        ...meta,
        terminalState: "retained",
        terminalReason: released.reason,
        updatedAt: new Date().toISOString(),
      }));
      continue;
    }
    if (released.kind === "blocked") { skipped.push({ dispatchId: entry.id, state: text(meta.state) || null, reason: released.reason }); continue; }
    if (options.mode === "archive") {
      const target = dispatchArchiveDirectory(root, month, entry.id); archived.push({ dispatchId: entry.id, path: target });
      if (!options.dryRun) {
        const result = archiveDispatch(handle, entry.id, now.toISOString());
        if (result.kind !== "ok" || !result.value) { archived.pop(); skipped.push({ dispatchId: entry.id, state: text(meta.state) || null, reason: "could not archive dispatch" }); }
      }
    } else {
      if (options.dryRun) deleted.push(entry.id);
      else {
        const result = deleteDispatch(handle, entry.id);
        if (result.kind !== "ok" || !result.value) skipped.push({ dispatchId: entry.id, state: text(meta.state) || null, reason: "could not delete dispatch" });
        else {
          deleted.push(entry.id);
          const path = transcriptPath(environment, entry.id);
          if (path.kind === "ok") await rm(path.value, { force: true }).catch(() => undefined);
        }
      }
    }
  }
  const result = { mode: options.mode, dryRun: options.dryRun, olderThanDays: options.olderThan, archived, deleted, skipped, terminalNotProvenGone };
  if (options.json) return ok(json({ ...result, archived: archived.length, deleted: deleted.length, skipped: skipped.length, terminalNotProvenGone: terminalNotProvenGone.length, archivedDispatches: archived, deletedDispatches: deleted, skippedDispatches: skipped, terminalNotProvenGoneDispatches: terminalNotProvenGone }));
  const lines = [`mode: ${options.mode}`, `dry-run: ${options.dryRun}`, `older-than-days: ${options.olderThan}`];
  for (const item of options.mode === "archive" ? archived : deleted.map((dispatchId) => ({ dispatchId }))) lines.push(`${options.dryRun ? "would" : ""} ${options.mode}: ${item.dispatchId}`.replace(/^ /, ""));
  if (terminalNotProvenGone.length > 0) lines.push("kept: terminal not proven gone", ...terminalNotProvenGone.map((item) => `kept: ${item.dispatchId} (${item.reason})`));
  lines.push(`skipped: ${skipped.length}`, ...skipped.map((item) => `skipped: ${item.dispatchId} (${item.reason})`)); return ok(`${lines.join("\n")}\n`);
}
