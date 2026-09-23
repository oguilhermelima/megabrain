import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { failed, ok, type Result } from "../../core/result.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { resolveStateDirectory } from "../../core/state.js";
import { childMessageUsage, classifyQueueMail, nextMessageSequence, parseChildMessage, recipientForQueueMessage } from "../../core/queue-write.js";
import { hasCallerIdentity, resolveCallerIdentity, type CallerEnvironment, type CallerIdentity } from "../../core/context.js";
import { dispatchPath } from "../../adapters/dispatch-store.js";
import { getHost } from "../../hosts/index.js";
import { getTmux, sendTmuxPair } from "../../hosts/tmux.js";
import { submitKey } from "../../agents/index.js";
import { checkDispatchTransition } from "../../core/dispatch-states.js";

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

// The one caller-identity resolver (core/context.js), reached through the same env-var mapping
// from every command that needs to know who is running it — no verb hand-rolls its own chain.
export function callerEnvironment(environment: QueueEnvironment): CallerEnvironment {
  return {
    megabrainSessionId: environment.MEGABRAIN_SESSION_ID,
    megabrainSessionHost: environment.MEGABRAIN_SESSION_HOST,
    claudeCodeSessionId: environment.CLAUDE_CODE_SESSION_ID,
    codexThreadId: environment.CODEX_THREAD_ID,
    supersetTerminalId: environment.SUPERSET_TERMINAL_ID,
    orcaTerminalHandle: environment.ORCA_TERMINAL_HANDLE,
    orcaStructuredSession: environment.ORCA_STRUCTURED_SESSION,
    tmux: environment.TMUX,
    tmuxPane: environment.TMUX_PANE,
  };
}

async function tmuxSessionNameFor(pane: string, processAdapter: ProcessAdapter): Promise<string | undefined> {
  const result = await getTmux().sessionForPane(pane, processAdapter);
  return result.kind === "ok" ? result.value : undefined;
}

// The tmux session the CURRENT process is physically running in, right now — independent of any
// caller-identity override or agent-session id. For "am I running in this pane/session right
// now" safety checks (orchestrate prune, install-doctor's leaked-session count), never for
// identity or ownership: unlike resolveCaller, a MEGABRAIN_SESSION_ID/HOST override or a
// superset/orca terminal handle set alongside a genuine tmux pane must never suppress this probe
// — the caller really is in that pane regardless of which identity it also carries. MEASURED
// regression (tests/test-dispatch-transcript.sh): a caller with SUPERSET_TERMINAL_ID set who was
// also physically in a tmux pane had that pane wrongly treated as prunable, because resolveCaller
// let the override skip the probe entirely.
export async function tmuxCallerPaneSession(environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<string | undefined> {
  if (environment.TMUX === undefined || environment.TMUX === "" || environment.TMUX_PANE === undefined || environment.TMUX_PANE === "") return undefined;
  return tmuxSessionNameFor(environment.TMUX_PANE, processAdapter);
}

// Resolves the current caller's identity, probing the tmux session name only when nothing of
// higher precedence (an explicit override, or a superset/orca terminal handle) already answers
// the host — the same guard the old close.ts caller() used, now shared by every verb instead of
// each one hand-rolling it.
export async function resolveCaller(environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<CallerIdentity> {
  const fields = callerEnvironment(environment);
  const needsTmuxProbe = fields.megabrainSessionHost === undefined
    && fields.supersetTerminalId === undefined
    && fields.orcaTerminalHandle === undefined
    && fields.tmux !== undefined && fields.tmux.length > 0
    && fields.tmuxPane !== undefined && fields.tmuxPane.length > 0;
  const tmuxSessionName = needsTmuxProbe ? await tmuxSessionNameFor(fields.tmuxPane as string, processAdapter) : undefined;
  return resolveCallerIdentity(fields, { tmuxSessionName });
}

// The child's own identity, for matching against the dispatch record spawn wrote for it
// (meta.terminalId / meta.childHost, or meta.tmuxSession / meta.tmuxPane): spawn only ever hands
// a child a terminal-based identity, never a synthetic session id, so the terminal handle is
// preferred over a stable agent-session id here even though ownership checks prefer the reverse.
// Historically this looked up a tmux pane's session via `tmux list-panes -a`, not the
// `display-message`-based probe resolveCaller shares with every other verb — some deployments'
// tmux only answers the former. MEASURED regression (tests/test-queue-write-cli.sh): a child
// with only TMUX/TMUX_PANE set (no override, no terminal handle) could no longer find its own
// dispatch once this went through resolveCaller alone. The override/superset/orca/agent-session
// precedence is still resolveCaller's; list-panes is only a fallback for the plain-tmux case it
// could not resolve.
async function tmuxSessionViaListPanes(pane: string, processAdapter: ProcessAdapter): Promise<string | undefined> {
  const result = await processAdapter.run("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_id}"]);
  if (result.kind !== "ok") return undefined;
  const match = result.value.stdout.split("\n").map((line) => line.split("\t")).find((parts) => parts[1] === pane);
  return match?.[0];
}

async function session(environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Session | undefined> {
  const caller = await resolveCaller(environment, processAdapter);
  if (hasCallerIdentity(caller)) {
    return {
      host: caller.host,
      id: caller.terminalId ?? caller.id,
      ...(caller.tmuxSession !== null ? { tmuxSession: caller.tmuxSession } : {}),
      ...(caller.tmuxPane !== null ? { tmuxPane: caller.tmuxPane } : {}),
    };
  }
  if (environment.TMUX !== undefined && environment.TMUX !== "" && environment.TMUX_PANE !== undefined && environment.TMUX_PANE !== "") {
    const sessionName = await tmuxSessionViaListPanes(environment.TMUX_PANE, processAdapter);
    if (sessionName !== undefined) return { host: "tmux", id: `${sessionName}:${environment.TMUX_PANE}`, tmuxSession: sessionName, tmuxPane: environment.TMUX_PANE };
  }
  return undefined;
}

// Exported for the turn-end hook (src/cli/commands/hook-turn-end.js), which asks the identical
// "is the current terminal itself a managed dispatch's child" question megabrain_dispatch_find_child
// answered in the shell — same MEGABRAIN_DISPATCH_ID fast path, same terminal/tmux matching, same
// ambiguity and not-found errors.
export async function findChild(root: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<{ dispatch: string; session: Session } | Result<never>> {
  const current = await session(environment, processAdapter);
  if (current === undefined) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  const direct = environment.MEGABRAIN_DISPATCH_ID;
  const directMeta = direct !== undefined && /^[A-Za-z0-9._-]+$/.test(direct) ? await readJson(await dispatchPath(root, direct, "meta.json")) : undefined;
  const directDispatch = direct !== undefined && directMeta?.dispatchId === direct ? direct : undefined;
  const dispatches = directDispatch !== undefined ? [directDispatch] : await readdir(`${root}/dispatches`).catch(() => []);
  const matches: string[] = [];
  for (const dispatch of dispatches) {
    const meta = await readJson(await dispatchPath(root, dispatch, "meta.json"));
    // A tmux-runtime record is never matched by terminalId/childHost, even one written before
    // orchestrate-spawn.ts recorded the child's own identity there (when both fields held
    // whatever caller happened to spawn it) — only a caller actually running in that exact
    // tmuxSession/tmuxPane can ever be this dispatch's child.
    const matchesTerminal = meta?.runtime !== "tmux" && meta?.terminalId === current.id && meta.childHost === current.host;
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
  const hasSession = await getTmux().sessionExists(session, processAdapter);
  if (hasSession.kind !== "ok") return undefined;
  const panes = await getTmux().panesForSession(session, processAdapter);
  if (panes.kind !== "ok" || !panes.value.includes(pane)) return undefined;
  return { session, pane };
}

// Exported for the turn-end hook, which runs the same state-directory/tmux-context check
// (megabrain_parent_notify_context_matches) before nudging a parent it found by scanning dispatches.
export async function parentContextMatches(root: string, meta: JsonRecord, processAdapter: ProcessAdapter): Promise<boolean> {
  const channel = await readParentTmuxChannel(meta, processAdapter);
  if (channel === undefined) return true;
  const context = await getTmux().showEnvironment(channel.session, "MEGABRAIN_STATE_DIR", processAdapter);
  if (context.kind === "ok") {
    const value = context.value.trim().replace(/^MEGABRAIN_STATE_DIR=/, "");
    if (value !== "") {
      const [current, parent] = await Promise.all([realpath(root).catch(() => root), realpath(value).catch(() => value)]);
      if (parent !== current) return false;
    }
  }
  return true;
}

// Exported for the turn-end hook, which suppresses its own parent nudges the same way
// (megabrain_parent_notify_waiter_active) when a live `megabrain orchestrate watch` is already polling.
export async function waiterIsActive(root: string, dispatch: string): Promise<boolean> {
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

// The channel-resolution-and-send tail of megabrain_parent_notify: given a pointer line, find the
// parent's tmux pane or host terminal and deliver it there. No suppression checks here — those
// (context match, active waiter) are the caller's concern, since megabrain_parent_notify itself
// carried none either; megabrain_parent_notify_dispatch layered them on for the actionable-mail
// path, and the turn-end hook's own parent-notify scan layers them on again for its own dispatches.
// Exported so the hook can reuse this exact delivery mechanism for its own pointer text (a batched
// "N dispatches finished" line) instead of the fixed "mail: megabrain orchestrate watch" one below.
export async function sendParentPointer(root: string, meta: JsonRecord, pointer: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<NotificationResult> {
  const channel = await readParentTmuxChannel(meta, processAdapter);
  const host = channel === undefined && typeof meta.parentHost === "string" ? meta.parentHost : channel === undefined ? "" : "tmux";
  let result;
  if (host === "tmux") {
    const pane = channel?.pane ?? "";
    const parentAgent = typeof meta.parentAgent === "string" && meta.parentAgent !== "" ? meta.parentAgent : typeof meta.agent === "string" ? meta.agent : "";
    const affordance = submitKey(parentAgent);
    if (affordance.kind !== "ok") return { outcome: "failed", reason: affordance.error };
    const sent = await sendTmuxPair(root, pane, pointer, affordance.value, environment, processAdapter);
    if (sent.kind !== "ok") return { outcome: "failed", reason: sent.kind === "unknown" ? sent.reason : sent.error };
    result = sent;
  } else {
    const provider = getHost(host);
    if (provider === undefined) return { outcome: "failed", reason: `unsupported parent host: ${host}` };
    const call = provider.send({
      workspaceId: typeof meta.parentWorkspaceId === "string" ? meta.parentWorkspaceId : null,
      terminalId: typeof meta.parentSessionId === "string" ? meta.parentSessionId : "",
      text: pointer,
    });
    if (call.kind !== "ok") return { outcome: "failed", reason: call.error };
    result = await processAdapter.run(call.value.command, call.value.args);
  }
  return result.kind === "ok" ? { outcome: "delivered", reason: "parent-notified" } : { outcome: "failed", reason: result.error };
}

async function notifyParent(root: string, meta: JsonRecord, dispatch: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<NotificationResult> {
  const pointer = `mail: megabrain orchestrate watch ${dispatch}`;
  if (!(await parentContextMatches(root, meta, processAdapter))) {
    return { outcome: "suppressed", reason: "state-directory-mismatch" };
  }
  if (await waiterIsActive(root, dispatch)) {
    return { outcome: "suppressed", reason: "active-waiter" };
  }
  return sendParentPointer(root, meta, pointer, environment, processAdapter);
}

export async function notifyChild(root: string, meta: JsonRecord, dispatch: string, processAdapter: ProcessAdapter, environment: QueueEnvironment = {}): Promise<NotificationResult> {
  const pointer = `[megabrain] reply available; run megabrain check`;
  const host = typeof meta.childHost === "string" ? meta.childHost : "";
  const runtime = typeof meta.runtime === "string" ? meta.runtime : "host";
  let result;
  if (runtime === "tmux") {
    const pane = typeof meta.tmuxPane === "string" ? meta.tmuxPane : "";
    const session = typeof meta.tmuxSession === "string" ? meta.tmuxSession : "";
    if (pane === "" || session === "") return { outcome: "failed", reason: "tmux dispatch metadata has no session or pane" };
    const affordance = submitKey(typeof meta.agent === "string" ? meta.agent : "");
    if (affordance.kind !== "ok") return { outcome: "failed", reason: affordance.error };
    const sent = await sendTmuxPair(root, pane, pointer, affordance.value, environment, processAdapter);
    if (sent.kind !== "ok") return { outcome: "failed", reason: sent.kind === "unknown" ? sent.reason : sent.error };
    result = sent;
  } else {
    const provider = getHost(host);
    if (provider === undefined) return { outcome: "failed", reason: `unsupported child host: ${host}` };
    const call = provider.send({
      workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null,
      terminalId: typeof meta.terminalId === "string" ? meta.terminalId : "",
      text: pointer,
    });
    if (call.kind !== "ok") return { outcome: "failed", reason: call.error };
    result = await processAdapter.run(call.value.command, call.value.args);
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
            const notification = await notifyParent(root, meta, dispatch, environment, processAdapter);
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
  if (type === "done") {
    const transition = checkDispatchTransition("dispatch", state, nextState);
    if (transition.kind !== "ok") return transition;
  }
  const updated: JsonRecord = { ...meta, state: nextState, processState: nextProcess, updatedAt: new Date().toISOString() };
  if (type === "received") { updated.promptReceipt = "received"; updated.promptState = "confirmed"; }
  await atomicJson(path, updated);
  return ok(undefined);
}

export async function executeQueueWrite(type: "received" | "ask" | "done", args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(childMessageUsage(type));
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
