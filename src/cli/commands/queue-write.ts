import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { failed, ok, type Result } from "../../core/result.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { resolveStateDirectory } from "../../core/state.js";
import { classifyQueueMail, nextMessageSequence, parseChildMessage, recipientForQueueMessage } from "../../core/queue-write.js";
import { dispatchPath } from "../../adapters/dispatch-store.js";

export type QueueEnvironment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;
type Session = {
  readonly host: string;
  readonly id: string;
  readonly tmuxSession?: string;
  readonly tmuxPane?: string;
};

type NotificationResult = {
  readonly outcome: string;
  readonly reason: string;
};

export async function readJson(path: string): Promise<JsonRecord | undefined> {
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
  const directMeta = direct !== undefined && /^[A-Za-z0-9._-]+$/.test(direct) ? await readJson(await dispatchPath(root, direct, "meta.json")) : undefined;
  const directDispatch = direct !== undefined && directMeta?.dispatchId === direct ? direct : undefined;
  const dispatches = directDispatch !== undefined ? [directDispatch] : await readdir(`${root}/dispatches`).catch(() => []);
  const matches: string[] = [];
  for (const dispatch of dispatches) {
    const meta = await readJson(await dispatchPath(root, dispatch, "meta.json"));
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

export async function atomicJson(path: string, value: JsonRecord): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value)}\n`); await rename(temporary, path); } catch (error: unknown) { await rm(temporary, { force: true }); throw error; }
}

async function readParentTmuxChannel(meta: JsonRecord, processAdapter: ProcessAdapter): Promise<{ readonly session: string; readonly pane: string } | undefined> {
  const session = typeof meta.parentTmuxSession === "string" ? meta.parentTmuxSession : undefined;
  const pane = typeof meta.parentTmuxPane === "string" ? meta.parentTmuxPane : undefined;
  if (session === undefined || session === "" || pane === undefined || pane === "") return undefined;
  const hasSession = await processAdapter.run("tmux", ["has-session", "-t", session]);
  if (hasSession.kind !== "ok") return undefined;
  const panes = await processAdapter.run("tmux", ["list-panes", "-t", session, "-F", "#{pane_id}"]);
  if (panes.kind !== "ok" || !panes.value.stdout.split("\n").some((value) => value === pane)) return undefined;
  return { session, pane };
}

async function parentContextMatches(root: string, meta: JsonRecord, processAdapter: ProcessAdapter): Promise<boolean> {
  const channel = await readParentTmuxChannel(meta, processAdapter);
  if (channel === undefined) return true;
  const context = await processAdapter.run("tmux", ["show-environment", "-t", channel.session, "MEGABRAIN_STATE_DIR"]);
  if (context.kind === "ok") {
    const value = context.value.stdout.trim().replace(/^MEGABRAIN_STATE_DIR=/, "");
    if (value !== "") {
      const [current, parent] = await Promise.all([realpath(root).catch(() => root), realpath(value).catch(() => value)]);
      if (parent !== current) return false;
    }
  }
  return true;
}

async function waiterIsActive(root: string, dispatch: string): Promise<boolean> {
  const path = await dispatchPath(root, dispatch, "waiter.json");
  const waiter = await readJson(path);
  const pid = typeof waiter?.pid === "number" ? waiter.pid : typeof waiter?.pid === "string" ? Number(waiter.pid) : NaN;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { await rm(path, { force: true }); return false; }
}

async function appendNotificationOutcome(root: string, dispatch: string, pointer: string, outcome: string, reason: string): Promise<void> {
  const directory = await dispatchPath(root, dispatch, "");
  const path = `${directory}/nudge.log`;
  const lock = `${directory}/.nudge.lock`;
  const cleanReason = reason.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "unspecified";
  while (true) {
    try { await mkdir(lock); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  try { await writeFile(path, `${pointer} outcome=${outcome} reason=${cleanReason}\n`, { flag: "a" }); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

async function notifyParent(root: string, meta: JsonRecord, dispatch: string, processAdapter: ProcessAdapter): Promise<NotificationResult> {
  const pointer = `mail: megabrain orchestrate watch ${dispatch}`;
  if (!(await parentContextMatches(root, meta, processAdapter))) {
    return { outcome: "suppressed", reason: "state-directory-mismatch" };
  }
  if (await waiterIsActive(root, dispatch)) {
    return { outcome: "suppressed", reason: "active-waiter" };
  }
  const channel = await readParentTmuxChannel(meta, processAdapter);
  const host = channel === undefined && typeof meta.parentHost === "string" ? meta.parentHost : channel === undefined ? "" : "tmux";
  let result;
  if (host === "tmux") {
    const pane = channel?.pane ?? "";
    const affordance = meta.parentAgent === "codex" || meta.agent === "codex" ? "Tab" : "Enter";
    result = await processAdapter.run("tmux", ["send-keys", "-t", pane, "-l", pointer]);
    if (result.kind === "ok") result = await processAdapter.run("tmux", ["send-keys", "-t", pane, affordance]);
  } else if (host === "orca") {
    const terminal = typeof meta.parentSessionId === "string" ? meta.parentSessionId : "";
    result = await processAdapter.run("orca", ["terminal", "send", "--terminal", terminal, "--text", pointer, "--enter", "--json"]);
  } else if (host === "superset") {
    const workspace = typeof meta.parentWorkspaceId === "string" ? meta.parentWorkspaceId : "";
    const terminal = typeof meta.parentSessionId === "string" ? meta.parentSessionId : "";
    result = await processAdapter.run("superset", ["terminals", "send", "--workspace", workspace, "--terminal", terminal, "--text", pointer, "--json"]);
  } else {
    return { outcome: "failed", reason: `unsupported parent host: ${host}` };
  }
  return result.kind === "ok" ? { outcome: "delivered", reason: "parent-notified" } : { outcome: "failed", reason: result.error };
}

export async function notifyChild(root: string, meta: JsonRecord, dispatch: string, processAdapter: ProcessAdapter): Promise<NotificationResult> {
  const pointer = `[megabrain] reply available; run megabrain check`;
  const host = typeof meta.childHost === "string" ? meta.childHost : "";
  const runtime = typeof meta.runtime === "string" ? meta.runtime : "host";
  let result;
  if (runtime === "tmux") {
    const pane = typeof meta.tmuxPane === "string" ? meta.tmuxPane : "";
    const session = typeof meta.tmuxSession === "string" ? meta.tmuxSession : "";
    if (pane === "" || session === "") return { outcome: "failed", reason: "tmux dispatch metadata has no session or pane" };
    const affordance = meta.agent === "codex" ? "Tab" : "Enter";
    result = await processAdapter.run("tmux", ["send-keys", "-t", pane, "-l", pointer]);
    if (result.kind === "ok") result = await processAdapter.run("tmux", ["send-keys", "-t", pane, affordance]);
  } else if (host === "orca") {
    const terminal = typeof meta.terminalId === "string" ? meta.terminalId : "";
    result = await processAdapter.run("orca", ["terminal", "send", "--terminal", terminal, "--text", pointer, "--enter", "--json"]);
  } else if (host === "superset") {
    const workspace = typeof meta.workspaceId === "string" ? meta.workspaceId : "";
    const terminal = typeof meta.terminalId === "string" ? meta.terminalId : "";
    result = await processAdapter.run("superset", ["terminals", "send", "--workspace", workspace, "--terminal", terminal, "--text", pointer, "--json"]);
  } else {
    return { outcome: "failed", reason: `unsupported child host: ${host}` };
  }
  return result.kind === "ok" ? { outcome: "delivered", reason: "child-notified" } : { outcome: "failed", reason: result.error };
}

export async function acquireLock(path: string, environment: QueueEnvironment): Promise<Result<void>> {
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

export async function appendMessage(root: string, dispatch: string, from: string, type: string, text: string, sessionId: string, environment: QueueEnvironment, processAdapter: ProcessAdapter, lockHeld = false): Promise<Result<number>> {
  const messages = await dispatchPath(root, dispatch, "messages");
  const deliveries = await dispatchPath(root, dispatch, "deliveries");
  await mkdir(messages, { recursive: true }); await mkdir(deliveries, { recursive: true });
  const lock = `${messages}/.lock`;
  const acquired = lockHeld ? ok(undefined) : await acquireLock(lock, environment);
  if (acquired.kind !== "ok") return acquired;
  try {
    const names = await readdir(messages);
    const seq = nextMessageSequence(names);
    const path = `${messages}/${String(seq).padStart(4, "0")}-${from}-${type}.json`;
    const now = new Date().toISOString();
    const value: JsonRecord = { seq, from, type, text, createdAt: now, sessionId };
    await atomicJson(path, value);
    const priorDone = names.some((name) => name.endsWith("-child-done.json"));
    const classification = classifyQueueMail(from, type, priorDone);
    const recipient = recipientForQueueMessage(from, type, priorDone);
    if (recipient !== undefined) {
      const deliveryId = `delivery-${now.replace(/[-:.TZ]/g, "")}-${process.pid}-${randomUUID().slice(0, 8)}`;
      await atomicJson(`${deliveries}/${deliveryId}.json`, { id: deliveryId, dispatchId: dispatch, recipient, messageSeqs: [seq], status: "outstanding", createdAt: now, updatedAt: now, acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null });
      if (recipient === "parent" && classification === "actionable") {
        const meta = await readJson(await dispatchPath(root, dispatch, "meta.json"));
        if (meta !== undefined) {
          try {
            const notification = await notifyParent(root, meta, dispatch, processAdapter);
            await appendNotificationOutcome(root, dispatch, `mail: megabrain orchestrate watch ${dispatch}`, notification.outcome, notification.reason);
          } catch (error: unknown) {
            const reason = error instanceof Error ? error.message : "notification failed";
            try { await appendNotificationOutcome(root, dispatch, `mail: megabrain orchestrate watch ${dispatch}`, "failed", reason); } catch { /* notification is best effort */ }
          }
        } else {
          try { await appendNotificationOutcome(root, dispatch, `mail: megabrain orchestrate watch ${dispatch}`, "skipped", "metadata-unavailable"); } catch { /* notification is best effort */ }
        }
      }
    }
    return ok(seq);
  } finally { if (!lockHeld) await rm(lock, { recursive: true, force: true }); }
}

async function updateMeta(root: string, dispatch: string, type: string): Promise<Result<void>> {
  const path = await dispatchPath(root, dispatch, "meta.json");
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
