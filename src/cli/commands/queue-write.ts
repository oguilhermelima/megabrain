import { agyParentKey, readAgyLanguageServer, recordAgyLanguageServer } from "../../agents/agy-ls.js";
import { ancestorIdentity, stableAncestor } from "../../adapters/ancestor.js";
import { agentSessionOf } from "../../adapters/agent-session.js";
import { readdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { failed, ok, type Result } from "../../core/result.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { resolveChildStateDirectory } from "../../core/state.js";
import { childMessageUsage, nextMessageSequence, parseChildMessage } from "../../core/queue-write.js";
import { hasCallerIdentity, resolveCallerIdentity, type CallerEnvironment, type CallerIdentity } from "../../core/context.js";
import { getTmux } from "../../hosts/tmux.js";
import { formatDispatchMessage } from "../../core/chat-message-format.js";
import { setTmuxChatPane } from "../../core/chat-pane.js";
import { claimOutbox, finishNotification, getDispatch, isDispatchArchived, listDispatches, readOnlyStateDatabase, getWaiter, setDeliveryTransport } from "../../adapters/state-db.js";
import { callStateOwner, recordChannelResultThroughOwner } from "../../db/state-owner.js";
import { processStartTime } from "../../db/state-owner-runtime.js";
import type { DatabaseHandle } from "../../db/db.js";
import { deliverCodexQueue, findCodexProcess } from "../../core/codex-delivery.js";
import { sendSessionMessage } from "../../core/session-send.js";
import { startDeliveryWorker } from "./delivery-worker.js";

export type QueueEnvironment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;
type Session = {
  readonly host: string;
  readonly id: string;
  readonly tmuxSession?: string;
  readonly tmuxSessionId?: string;
  readonly tmuxPane?: string;
};

type NotificationResult = {
  readonly outcome: string;
  readonly reason: string;
  readonly transport?: "queue" | "typed" | "deferred" | "failed";
};

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
  return resolveSessionCaller(environment, processAdapter);
}

export async function resolveSessionCaller(environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<CallerIdentity> {
  const fields = callerEnvironment(environment);
  const needsTmuxProbe = fields.megabrainSessionHost === undefined
    && fields.supersetTerminalId === undefined
    && fields.orcaTerminalHandle === undefined
    && fields.tmux !== undefined && fields.tmux.length > 0
    && fields.tmuxPane !== undefined && fields.tmuxPane.length > 0;
  const tmuxSessionName = needsTmuxProbe ? await tmuxSessionNameFor(fields.tmuxPane as string, processAdapter) : undefined;
  // Grok and Agy name their session only through the process that runs the command, so the
  // process tree is walked whenever no explicit or Claude/Codex id already answers.
  const named = [fields.megabrainSessionId, fields.claudeCodeSessionId, fields.codexThreadId].some((value) => value !== undefined && value !== "");
  const ancestor = named ? undefined : await stableAncestor(process.ppid, processAdapter);
  const agentSessionId = ancestor === undefined ? undefined : await agentSessionOf(ancestor, environment, processAdapter);
  const identity = resolveCallerIdentity(fields, { tmuxSessionName, agentSessionId });
  if (identity.id !== "" || identity.host !== "local" || needsTmuxProbe) return identity;
  return resolveCallerIdentity(fields, { tmuxSessionName, shellIdentity: ancestor === undefined ? await ttyIdentity(processAdapter) : ancestorIdentity(ancestor) });
}

// A caller with no agent session, no explicit id and no terminal is identified by the nearest
// stable ancestor process (see adapters/ancestor.ts), then by the controlling tty of its parent
// shell. With neither it has no identity and the verb refuses.
async function ttyIdentity(processAdapter: ProcessAdapter): Promise<string> {
  const result = await processAdapter.run("ps", ["-o", "tty=", "-p", String(process.ppid)]);
  const tty = result.kind === "ok" ? result.value.stdout.trim() : "";
  return /^[A-Za-z0-9/]+$/.test(tty) && !/^\?+$/.test(tty) ? `shell:${tty.replace(/\//g, "-")}` : "";
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
  const result = await processAdapter.run("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{session_id}\t#{pane_id}"]);
  if (result.kind !== "ok") return undefined;
  const match = result.value.stdout.split("\n").map((line) => line.split("\t")).find((parts) => (parts[2] ?? parts[1]) === pane);
  return match?.[0];
}

async function tmuxSessionIdForPane(pane: string, processAdapter: ProcessAdapter): Promise<string | undefined> {
  const result = await processAdapter.run("tmux", ["display-message", "-p", "-t", pane, "#{session_id}"]);
  if (result.kind !== "ok") return undefined;
  const sessionId = result.value.stdout.trim();
  return /^\$\d+$/.test(sessionId) ? sessionId : undefined;
}

async function session(environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Session | undefined> {
  const caller = await resolveCaller(environment, processAdapter);
  if (hasCallerIdentity(caller)) {
    return {
      host: caller.host,
      id: caller.terminalId ?? caller.id,
      ...(caller.tmuxSession !== null ? { tmuxSession: caller.tmuxSession } : {}),
      ...(caller.host === "tmux" && caller.tmuxPane !== null
        ? { tmuxSessionId: await tmuxSessionIdForPane(caller.tmuxPane, processAdapter) }
        : {}),
      ...(caller.tmuxPane !== null ? { tmuxPane: caller.tmuxPane } : {}),
    };
  }
  if (environment.TMUX !== undefined && environment.TMUX !== "" && environment.TMUX_PANE !== undefined && environment.TMUX_PANE !== "") {
    const sessionName = await tmuxSessionViaListPanes(environment.TMUX_PANE, processAdapter);
    if (sessionName !== undefined) return { host: "tmux", id: `${sessionName}:${environment.TMUX_PANE}`, tmuxSession: sessionName, tmuxSessionId: await tmuxSessionIdForPane(environment.TMUX_PANE, processAdapter), tmuxPane: environment.TMUX_PANE };
  }
  return undefined;
}

// Exported for the turn-end hook (src/cli/commands/hook-turn-end.js), which asks the identical
// "is the current terminal itself a managed dispatch's child" question megabrain_dispatch_find_child
// answered in the shell — same MEGABRAIN_DISPATCH_ID fast path, same terminal/tmux matching, same
// ambiguity and not-found errors.
// A tmux-runtime record is never matched by terminalId/childHost, even one written before
// orchestrate-spawn.ts recorded the child's own identity there (when both fields held whatever
// caller happened to spawn it) — only a caller actually running in that exact tmuxSession/tmuxPane
// can ever be this dispatch's child. Shared by the identity scan below and by the
// MEGABRAIN_DISPATCH_ID fast path, which must apply the identical ownership rule rather than
// trusting the named dispatch's existence alone.
function callerOwnsDispatch(meta: JsonRecord | undefined, current: Session): boolean {
  const matchesAgentSession = (typeof meta?.agentSessionId === "string" && current.id === `claude:${meta.agentSessionId}`)
    || (typeof meta?.agentThreadId === "string" && current.id === `codex:${meta.agentThreadId}`)
    || (typeof meta?.agentSessionId === "string" && current.id === meta.agentSessionId)
    || (typeof meta?.agentThreadId === "string" && current.id === meta.agentThreadId);
  const matchesTerminal = meta?.runtime !== "tmux" && meta?.terminalId === current.id && meta?.childHost === current.host;
  const matchesTmux = current.host === "tmux" &&
    meta?.runtime === "tmux" &&
    current.tmuxSession !== undefined && current.tmuxPane !== undefined &&
    meta?.tmuxPane === current.tmuxPane &&
    (typeof meta?.tmuxSessionId === "string"
      ? current.tmuxSessionId !== undefined && meta.tmuxSessionId === current.tmuxSessionId
      : meta?.tmuxSession === current.tmuxSession);
  return matchesTerminal || matchesTmux || matchesAgentSession;
}

function hasRecordedChildIdentity(meta: JsonRecord | undefined): boolean {
  return meta?.runtime === "tmux"
    || typeof meta?.terminalId === "string"
    || typeof meta?.agentSessionId === "string"
    || typeof meta?.agentThreadId === "string"
    || typeof meta?.tmuxSession === "string"
    || typeof meta?.tmuxSessionId === "string"
    || typeof meta?.tmuxPane === "string";
}

function isLiveDispatch(meta: JsonRecord | undefined): boolean {
  return meta?.state === "running" || meta?.state === "waiting_for_reply" || meta?.state === "spawning";
}

function dispatchIsActive(database: DatabaseHandle, dispatch: string, meta: JsonRecord | undefined): Result<boolean> {
  if (!isLiveDispatch(meta)) return ok(false);
  const archived = isDispatchArchived(database, dispatch);
  if (archived.kind !== "ok") return archived;
  return ok(!archived.value);
}

export async function findChild(root: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<{ dispatch: string; session: Session } | Result<never>> {
  const current = await session(environment, processAdapter);
  if (current === undefined) return failed("this command cannot tell who is running it: no agent session and no shell were found; set MEGABRAIN_SESSION_ID to name this caller");
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME });
  if (database.kind !== "ok") return database;
  const direct = environment.MEGABRAIN_DISPATCH_ID;
  const directRecord = direct !== undefined && /^[A-Za-z0-9._-]+$/.test(direct) ? getDispatch(database.value, direct) : undefined;
  const directMeta = directRecord?.kind === "ok" ? directRecord.value : undefined;
  // A dispatch id supplied by spawn is authoritative when its record has no child identity
  // to contradict it. If the record carries a different child identity, or the id is stale,
  // use the session scan so an inherited id cannot route mail to another child.
  let directDispatch: string | undefined;
  if (direct !== undefined && directMeta?.dispatchId === direct) {
    const active = dispatchIsActive(database.value, direct, directMeta);
    if (active.kind !== "ok") return active;
    if (active.value && (!hasRecordedChildIdentity(directMeta) || callerOwnsDispatch(directMeta, current))) directDispatch = direct;
  }
  if (directDispatch !== undefined) return { dispatch: directDispatch, session: current };
  const listed = listDispatches(database.value);
  if (listed.kind !== "ok") return listed;
  const dispatches = listed.value.map((record) => record.dispatchId);
  const matches: string[] = [];
  for (const dispatch of dispatches) {
    const record = getDispatch(database.value, dispatch);
    const meta = record.kind === "ok" ? record.value : undefined;
    if (meta?.dispatchId !== dispatch) continue;
    const active = dispatchIsActive(database.value, dispatch, meta);
    if (active.kind !== "ok") return active;
    if (active.value && callerOwnsDispatch(meta, current)) matches.push(dispatch);
  }
  if (matches.length > 1) return failed(`terminal identity matches multiple dispatches for ${current.host}/${current.id}${current.tmuxPane === undefined ? "" : ` pane ${current.tmuxPane}`}: ${matches[0]}, ${matches[1]}`);
  if (matches.length === 0) {
    if (current.host === "tmux") return failed(`no managed dispatch belongs to tmux session ${current.id ? current.id.split(":")[0] : "unknown"} pane ${environment.TMUX_PANE ?? "unknown"}`);
    return failed(`no managed dispatch belongs to ${current.host}/${current.id}`);
  }
  return { dispatch: matches[0], session: current };
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
export async function waiterIsActive(root: string, dispatch: string, processStartedAt: (pid: number) => number | undefined = processStartTime): Promise<boolean> {
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return false;
  const result = getWaiter(database.value, dispatch);
  const waiter = result.kind === "ok" ? result.value : undefined;
  const pid = waiter?.pid ?? NaN;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const startedAt = processStartedAt(pid);
  const registeredAt = waiter === undefined ? Number.NaN : Date.parse(waiter.createdAt);
  if (startedAt !== undefined && Number.isFinite(registeredAt) && startedAt <= registeredAt + 2_000) {
    try { process.kill(pid, 0); return true; } catch { /* the registered process has exited */ }
  }
  await callStateOwner(root, { operation: "delete-waiter", dispatchId: dispatch, pid, createdAt: waiter?.createdAt }).catch(() => undefined);
  return false;
}

// The channel-resolution-and-send tail of megabrain_parent_notify: given a pointer line, find the
// parent's tmux pane or host terminal and deliver it there. No suppression checks here — those
// (context match, active waiter) are the caller's concern, since megabrain_parent_notify itself
// carried none either; megabrain_parent_notify_dispatch layered them on for the actionable-mail
// path, and the turn-end hook's own parent-notify scan layers them on again for its own dispatches.
// Exported so the hook can reuse this exact delivery mechanism for its own pointer text (a batched
// "N dispatches finished" line) instead of the fixed "mail: megabrain orchestrate watch" one below.
// A channel into the parent that needs no terminal: Claude's peer-message socket, the leader a Grok
// parent runs under, or an agy parent's language server.
async function parentHasDirectChannel(root: string, dispatch: string, meta: JsonRecord): Promise<boolean> {
  if (meta.parentAgent === "claude") return typeof meta.parentAgentSessionId === "string";
  if (meta.parentAgent === "grok") return typeof meta.parentGrokLeaderSocket === "string" && typeof meta.parentGrokSessionId === "string";
  if (meta.parentAgent === "agy") return (await readAgyLanguageServer(root, agyParentKey(dispatch))) !== undefined;
  return false;
}

export async function sendParentPointer(root: string, meta: JsonRecord, pointer: string, environment: QueueEnvironment, processAdapter: ProcessAdapter, fullMessage = pointer, messageId = `${String(meta.dispatchId ?? "parent")}:${pointer}`): Promise<NotificationResult> {
  if (typeof meta.parentAgentThreadId === "string") {
    const found = await findCodexProcess(meta.parentAgentThreadId, {
      runtime: typeof meta.parentTmuxPane === "string" ? "tmux" : "host",
      host: meta.parentHost, terminalId: meta.parentTerminalId ?? meta.parentSessionId,
      workspaceId: meta.parentWorkspaceId, tmuxPane: meta.parentTmuxPane, tmuxSessionId: meta.parentTmuxSessionId,
    }, processAdapter);
    const result = await sendSessionMessage({ caller: "parent-notice", messageId, target: { agent: "codex", id: String(meta.parentAgentThreadId) }, text: fullMessage, channels: {
      "codex-queue": async () => {
        if (!("pid" in found)) return { delivered: false, detail: found.reason };
        return (await deliverCodexQueue(meta.parentAgentThreadId as string, found.pid, fullMessage, processAdapter)).kind === "queued";
      },
    }, recordChannel: async (channel) => { await recordChannelResultThroughOwner(root, { agent: "codex", channel, agentVersion: "unknown", ok: true }); } });
    return result.delivered ? { outcome: "delivered", reason: "parent-notified", transport: "queue" } : { outcome: "deferred", reason: `${result.detail ?? "Codex queue unavailable"}; terminal delivery worker will retry`, transport: "deferred" };
  }
  void root; void environment;
  return { outcome: "deferred", reason: `no direct parent channel; terminal delivery worker will retry: ${pointer}`, transport: "deferred" };
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

export async function notifyChild(root: string, meta: JsonRecord, dispatch: string, processAdapter: ProcessAdapter, environment: QueueEnvironment = {}, fullMessage = `[megabrain] reply available; run megabrain check`, messageId = `${dispatch}:${fullMessage}`) : Promise<NotificationResult> {
  void root; void dispatch; void environment;
  if (typeof meta.agentThreadId === "string") {
    const found = await findCodexProcess(meta.agentThreadId, meta, processAdapter);
    if ("pid" in found) {
      try {
        await callStateOwner(root, { operation: "dispatch-patch", dispatchId: dispatch, patch: { agentPid: found.pid, updatedAt: new Date().toISOString() } });
      } catch (cause: unknown) {
        return { outcome: "deferred", reason: `state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`, transport: "deferred" };
      }
    }
    const result = await sendSessionMessage({ caller: "reply", messageId, target: { agent: "codex", id: String(meta.agentThreadId) }, text: fullMessage, channels: {
      "codex-queue": async () => "pid" in found ? (await deliverCodexQueue(meta.agentThreadId as string, found.pid, fullMessage, processAdapter)).kind === "queued" : { delivered: false, detail: found.reason },
    }, recordChannel: async (channel) => { await recordChannelResultThroughOwner(root, { agent: "codex", channel, agentVersion: "unknown", ok: true }); } });
    return result.delivered ? { outcome: "delivered", reason: "child-notified", transport: "queue" } : { outcome: "deferred", reason: `${result.detail ?? "Codex queue unavailable"}; terminal delivery worker will retry`, transport: "deferred" };
  }
  return { outcome: "deferred", reason: "no direct child channel; terminal delivery worker will retry", transport: "deferred" };
}

export async function appendMessage(root: string, dispatch: string, from: string, type: string, text: string, sessionId: string, environment: QueueEnvironment, processAdapter: ProcessAdapter, lockHeld = false, childReport?: Readonly<{ type: "ask" | "done"; agent?: string; claudeSessionId?: string }>): Promise<Result<number>> {
  void lockHeld;
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME });
  if (database.kind !== "ok") return database;
  const metaResult = getDispatch(database.value, dispatch);
  if (metaResult.kind !== "ok") return metaResult;
  if (metaResult.value === undefined) return failed("dispatch not found: " + dispatch);
  const metaRecord = metaResult.value;
  const now = new Date().toISOString();
  let appended: { sequence: number; outboxId?: string };
  try {
    appended = await callStateOwner(root, { operation: "append-queue-message", dispatchId: dispatch, message: { from, type, text, createdAt: now, sessionId, idempotencyKey: randomUUID() }, dispatch: metaRecord, ...(from === "child" && childReport !== undefined ? { childReport } : {}) }) as typeof appended;
  } catch (cause: unknown) {
    return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (from === "child" && type === "stalled" && metaRecord.runtime === "tmux" && typeof metaRecord.tmuxPane === "string") {
    await setTmuxChatPane(metaRecord.tmuxPane, String(metaRecord.agent ?? "unknown"), String(metaRecord.chatName ?? metaRecord.branch ?? dispatch), "stalled", processAdapter);
  }
  if (childReport !== undefined && from === "child" && metaRecord.runtime === "tmux" && typeof metaRecord.tmuxPane === "string") {
    await setTmuxChatPane(metaRecord.tmuxPane, String(metaRecord.agent ?? "unknown"), String(metaRecord.chatName ?? metaRecord.branch ?? dispatch), type === "ask" ? "waiting_for_reply" : "done", processAdapter);
  }
  return ok(appended.sequence);
}

export async function updateMeta(root: string, dispatch: string, type: string, environment: QueueEnvironment, processAdapter: ProcessAdapter, tmuxPane?: string): Promise<Result<void>> {
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return database;
  const agentThreadId = type === "received" && typeof environment.CODEX_THREAD_ID === "string" ? environment.CODEX_THREAD_ID : undefined;
  const current = getDispatch(database.value, dispatch);
  const agent = current.kind === "ok" ? current.value?.agent : undefined;
  const scope: Record<string, unknown> = current.kind === "ok" && current.value !== undefined ? current.value : {};
  const codexProcess = agentThreadId === undefined ? undefined : await findCodexProcess(agentThreadId, scope, processAdapter);
  let agentPid = codexProcess !== undefined && "pid" in codexProcess ? codexProcess.pid : undefined;
  if (agentPid === undefined && type === "received" && agent === "claude" && tmuxPane !== undefined) {
    const panePid = await getTmux().panePid(tmuxPane, processAdapter);
    if (panePid.kind === "ok" && /^\d+$/.test(panePid.value.trim())) agentPid = Number(panePid.value.trim());
  }
  // Every megabrain verb an agy child runs comes from a tool shell that names its language server;
  // the latest one is kept so a restarted agy is reachable again on its next report.
  if (agent === "agy") await recordAgyLanguageServer(root, dispatch, environment).catch(() => undefined);
  try {
    await callStateOwner(root, {
      operation: "child-report", dispatchId: dispatch,
      type: type as "received" | "ask" | "done" | "stalled",
      ...(typeof agent === "string" ? { agent } : {}),
      ...(agentThreadId === undefined ? {} : { agentThreadId }),
      ...(agentPid === undefined ? {} : { agentPid }),
      ...(typeof environment.CLAUDE_CODE_SESSION_ID === "string" ? { claudeSessionId: environment.CLAUDE_CODE_SESSION_ID } : {}),
    });
  } catch (cause: unknown) {
    if (cause instanceof Error) {
      const refusal = cause.message.match(/illegal dispatch state transition:[^;]*/)?.[0];
      if (refusal !== undefined) return failed(refusal);
    }
    return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (scope.runtime === "tmux" && typeof scope.tmuxPane === "string") {
    const chatState = type === "ask" ? "waiting_for_reply" : type === "done" ? "done" : type === "stalled" ? "stalled" : "running";
    await setTmuxChatPane(scope.tmuxPane, String(agent ?? "unknown"), String(scope.chatName ?? scope.branch ?? dispatch), chatState, processAdapter);
  }
  return ok(undefined);
}

export async function executeQueueWrite(type: "received" | "ask" | "done", args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(childMessageUsage(type));
  const parsed = parseChildMessage(type, args);
  if (parsed.kind !== "ok") return parsed;
  const root = resolveChildStateDirectory(environment);
  const child = await findChild(root, environment, processAdapter);
  if ("kind" in child) return child;
  const childReport = type === "ask" || type === "done"
    ? { type, ...(typeof environment.CLAUDE_CODE_SESSION_ID === "string" ? { claudeSessionId: environment.CLAUDE_CODE_SESSION_ID } : {}) } as const
    : undefined;
  const append = await appendMessage(root, child.dispatch, "child", type, parsed.value, child.session.id, environment, processAdapter, false, childReport);
  if (append.kind !== "ok") return append;
  if (childReport !== undefined) return ok(`${type} sent: ${child.dispatch}\n`);
  const updated = await updateMeta(root, child.dispatch, type, environment, processAdapter, child.session.tmuxPane);
  if (updated.kind !== "ok") return updated;
  return ok(`${type} sent: ${child.dispatch}\n`);
}
