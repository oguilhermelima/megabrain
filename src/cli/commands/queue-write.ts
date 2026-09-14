import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { failed, ok, type Result } from "../../core/result.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { resolveStateDirectory } from "../../core/state.js";
import { classifyQueueMail, nextMessageSequence, parseChildMessage, recipientForQueueMessage } from "../../core/queue-write.js";

export type QueueEnvironment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;
type Session = {
  readonly host: string;
  readonly id: string;
  readonly tmuxSession?: string;
  readonly tmuxPane?: string;
};

async function readJson(path: string): Promise<JsonRecord | undefined> {
  try { const value: unknown = JSON.parse(await readFile(path, "utf8")); return typeof value === "object" && value !== null ? value as JsonRecord : undefined; } catch { return undefined; }
}

async function session(environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Session | undefined> {
  if (environment.TMUX && environment.TMUX_PANE) {
    const result = await processAdapter.run("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_id}"]);
    const pane = result.kind === "ok" ? result.value.stdout.split("\n").map((line) => line.split("\t")).find((parts) => parts[1] === environment.TMUX_PANE) : undefined;
    if (pane?.[0]) return { host: "tmux", id: `${pane[0]}:${environment.TMUX_PANE}`, tmuxSession: pane[0], tmuxPane: environment.TMUX_PANE };
    return { host: "tmux", id: "" };
  }
  if (environment.SUPERSET_TERMINAL_ID) return { host: "superset", id: environment.SUPERSET_TERMINAL_ID };
  if (environment.ORCA_TERMINAL_HANDLE) return { host: "orca", id: environment.ORCA_TERMINAL_HANDLE };
  return undefined;
}

async function findChild(root: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<{ dispatch: string; session: Session } | Result<never>> {
  const current = await session(environment, processAdapter);
  if (current === undefined) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  const direct = environment.MEGABRAIN_DISPATCH_ID;
  const directMeta = direct !== undefined && /^[A-Za-z0-9._-]+$/.test(direct) ? await readJson(`${root}/dispatches/${direct}/meta.json`) : undefined;
  const directDispatch = direct !== undefined && directMeta?.dispatchId === direct ? direct : undefined;
  const dispatches = directDispatch !== undefined ? [directDispatch] : await readdir(`${root}/dispatches`).catch(() => []);
  const matches: string[] = [];
  for (const dispatch of dispatches) {
    const meta = await readJson(`${root}/dispatches/${dispatch}/meta.json`);
    const matchesTerminal = meta?.terminalId === current.id && meta.childHost === current.host;
    const matchesTmux = current.host === "tmux" &&
      meta?.runtime === "tmux" &&
      current.tmuxSession !== undefined && current.tmuxPane !== undefined &&
      meta.tmuxSession === current.tmuxSession && meta.tmuxPane === current.tmuxPane;
    if (meta?.dispatchId === dispatch && (matchesTerminal || matchesTmux)) matches.push(dispatch);
  }
  if (matches.length > 1) return failed(`terminal identity matches multiple dispatches for ${current.host}/${current.id}: ${matches[0]}, ${matches[1]}`);
  if (matches.length === 0) {
    if (current.host === "tmux") return failed(`no managed dispatch belongs to tmux session ${current.id ? current.id.split(":")[0] : "unknown"} pane ${environment.TMUX_PANE ?? "unknown"}`);
    return failed(`no managed dispatch belongs to ${current.host}/${current.id}`);
  }
  return { dispatch: matches[0], session: current };
}

async function atomicJson(path: string, value: JsonRecord): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value)}\n`); await rename(temporary, path); } catch (error: unknown) { await rm(temporary, { force: true }); throw error; }
}

async function notifyParent(meta: JsonRecord, dispatch: string, processAdapter: ProcessAdapter): Promise<void> {
  const pane = typeof meta.parentTmuxPane === "string" ? meta.parentTmuxPane : undefined;
  if (pane === undefined) return;
  await processAdapter.run("tmux", ["send-keys", "-t", pane, "-l", `mail: megabrain orchestrate watch ${dispatch}`]);
  await processAdapter.run("tmux", ["send-keys", "-t", pane, "Enter"]);
}

async function acquireLock(path: string, environment: QueueEnvironment): Promise<Result<void>> {
  const waitSeconds = Number(environment.MEGABRAIN_LOCK_WAIT_SECONDS ?? "15");
  const staleSeconds = Number(environment.MEGABRAIN_LOCK_STALE_SECONDS ?? "30");
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  while (true) {
    try { await mkdir(path); return ok(undefined); } catch {
      try { const age = (Date.now() - (await stat(path)).mtimeMs) / 1000; if (age >= staleSeconds) { await rm(path, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() >= deadline) return failed(`mailbox lock is held by another writer: ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function appendMessage(root: string, dispatch: string, from: string, type: string, text: string, sessionId: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<number>> {
  const messages = `${root}/dispatches/${dispatch}/messages`;
  const deliveries = `${root}/dispatches/${dispatch}/deliveries`;
  await mkdir(messages, { recursive: true }); await mkdir(deliveries, { recursive: true });
  const lock = `${messages}/.lock`;
  const acquired = await acquireLock(lock, environment);
  if (acquired.kind !== "ok") return acquired;
  try {
    const names = await readdir(messages);
    const seq = nextMessageSequence(names);
    const path = `${messages}/${String(seq).padStart(4, "0")}-${from}-${type}.json`;
    const now = new Date().toISOString();
    const value: JsonRecord = { seq, from, type, text, createdAt: now, sessionId };
    await atomicJson(path, value);
    const priorDone = names.some((name) => name.endsWith("-child-done.json"));
    const recipient = recipientForQueueMessage(from, type, priorDone);
    if (recipient !== undefined) {
      const deliveryId = `delivery-${now.replace(/[-:.TZ]/g, "")}-${process.pid}-${randomUUID().slice(0, 8)}`;
      await atomicJson(`${deliveries}/${deliveryId}.json`, { id: deliveryId, dispatchId: dispatch, recipient, messageSeqs: [seq], status: "outstanding", createdAt: now, updatedAt: now, acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null });
      if (recipient === "parent") {
        const meta = await readJson(`${root}/dispatches/${dispatch}/meta.json`);
        if (meta !== undefined) await notifyParent(meta, dispatch, processAdapter);
      }
    }
    return ok(seq);
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function updateMeta(root: string, dispatch: string, type: string): Promise<Result<void>> {
  const path = `${root}/dispatches/${dispatch}/meta.json`;
  const meta = await readJson(path);
  if (meta === undefined) return failed(`dispatch not found: ${dispatch}`);
  const state = typeof meta.state === "string" ? meta.state : "running";
  const processState = typeof meta.processState === "string" ? meta.processState : "running";
  const nextState = type === "ask" ? "waiting_for_reply" : type === "done" ? "done" : state === "spawning" ? "running" : state;
  const nextProcess = type === "done" ? "succeeded" : processState === "starting" || processState === "start-unproven" ? "running" : processState;
  if (type === "done" && !["spawning", "running", "waiting_for_reply", "done", "orphaned"].includes(state)) return failed(`illegal dispatch state transition: ${state} -> done`);
  const updated: JsonRecord = { ...meta, state: nextState, processState: nextProcess, updatedAt: new Date().toISOString() };
  if (type === "received") { updated.promptReceipt = "received"; updated.promptState = "confirmed"; }
  await atomicJson(path, updated);
  return ok(undefined);
}

export async function executeQueueWrite(type: "received" | "ask" | "done", args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(`Usage: megabrain ${type}${type === "received" ? "" : type === "ask" ? ' "question"' : ' "summary"'}\n`);
  const parsed = parseChildMessage(type, args);
  if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment);
  const child = await findChild(root, environment, processAdapter);
  if ("kind" in child) return child;
  const append = await appendMessage(root, child.dispatch, "child", type, parsed.value, child.session.id, environment, processAdapter);
  if (append.kind !== "ok") return append;
  const updated = await updateMeta(root, child.dispatch, type);
  if (updated.kind !== "ok") return updated;
  return ok(`${type} sent: ${child.dispatch}\n`);
}
