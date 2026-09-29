import { readdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { failed, ok, type Result } from "../../core/result.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { resolveStateDirectory } from "../../core/state.js";
import { childMessageUsage, classifyQueueMail, nextMessageSequence, parseChildMessage, recipientForQueueMessage } from "../../core/queue-write.js";
import { hasCallerIdentity, resolveCallerIdentity, type CallerEnvironment, type CallerIdentity } from "../../core/context.js";
import { getHost, runHostSend } from "../../hosts/index.js";
import { getTmux, sendTmuxPair } from "../../hosts/tmux.js";
import { submitKey } from "../../agents/index.js";
import { checkDispatchTransition } from "../../core/dispatch-states.js";
import { appendMessage as appendDatabaseMessage, claimOutbox, finishNotification, getDispatch, listDispatches, stateDatabase, getWaiter, deleteWaiter, mutateDispatch, noDispatchChange } from "../../adapters/state-db.js";

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
  const matchesTerminal = meta?.runtime !== "tmux" && meta?.terminalId === current.id && meta?.childHost === current.host;
  const matchesTmux = current.host === "tmux" &&
    meta?.runtime === "tmux" &&
    current.tmuxSession !== undefined && current.tmuxPane !== undefined &&
    meta?.tmuxPane === current.tmuxPane &&
    (typeof meta?.tmuxSessionId === "string"
      ? current.tmuxSessionId !== undefined && meta.tmuxSessionId === current.tmuxSessionId
      : meta?.tmuxSession === current.tmuxSession);
  return matchesTerminal || matchesTmux;
}

export async function findChild(root: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<{ dispatch: string; session: Session } | Result<never>> {
  const current = await session(environment, processAdapter);
  if (current === undefined) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME });
  if (database.kind !== "ok") return database;
  const direct = environment.MEGABRAIN_DISPATCH_ID;
  const directRecord = direct !== undefined && /^[A-Za-z0-9._-]+$/.test(direct) ? getDispatch(database.value, direct) : undefined;
  const directMeta = directRecord?.kind === "ok" ? directRecord.value : undefined;
  // The fast path only short-circuits the scan for a dispatch that actually belongs to the
  // current caller. A stale MEGABRAIN_DISPATCH_ID (inherited by a process from a different
  // dispatch's environment) still names a real database row, so checking existence alone
  // locked the candidate list to a dispatch that then failed its own ownership check. Falling
  // back to the identity scan here matches the retired shell implementation.
  const directDispatch = direct !== undefined && directMeta?.dispatchId === direct && callerOwnsDispatch(directMeta, current) ? direct : undefined;
  const listed = directDispatch !== undefined ? undefined : listDispatches(database.value);
  if (listed?.kind === "failed") return listed;
  const dispatches = directDispatch !== undefined ? [directDispatch] : listed?.kind === "ok" ? listed.value.map((record) => record.dispatchId) : [];
  const matches: string[] = [];
  for (const dispatch of dispatches) {
    const record = getDispatch(database.value, dispatch);
    const meta = record.kind === "ok" ? record.value : undefined;
    if (meta?.dispatchId === dispatch && callerOwnsDispatch(meta, current)) matches.push(dispatch);
  }
  if (matches.length > 1) return failed(`terminal identity matches multiple dispatches for ${current.host}/${current.id}: ${matches[0]}, ${matches[1]}`);
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
export async function waiterIsActive(root: string, dispatch: string): Promise<boolean> {
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return false;
  const result = getWaiter(database.value, dispatch);
  const waiter = result.kind === "ok" ? result.value : undefined;
  const pid = waiter?.pid ?? NaN;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { deleteWaiter(database.value, dispatch); return false; }
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
      terminalId: typeof meta.parentTerminalId === "string" && meta.parentTerminalId !== "" ? meta.parentTerminalId : typeof meta.parentSessionId === "string" ? meta.parentSessionId : "",
      text: pointer,
    });
    if (call.kind !== "ok") return { outcome: "failed", reason: call.error };
    result = await runHostSend(host, processAdapter, call.value);
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
    result = await runHostSend(host, processAdapter, call.value);
  }
  return result.kind === "ok" ? { outcome: "delivered", reason: "child-notified" } : { outcome: "failed", reason: result.error };
}

export async function appendMessage(root: string, dispatch: string, from: string, type: string, text: string, sessionId: string, environment: QueueEnvironment, processAdapter: ProcessAdapter, lockHeld = false): Promise<Result<number>> {
  void lockHeld;
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME });
  if (database.kind !== "ok") return database;
  const metaResult = getDispatch(database.value, dispatch);
  if (metaResult.kind !== "ok") return metaResult;
  if (metaResult.value === undefined) return failed("dispatch not found: " + dispatch);
  const metaRecord = metaResult.value;
  const now = new Date().toISOString();
  const pointer = "mail: megabrain orchestrate watch " + dispatch;
  let outboxId: string | undefined;
  const appended = appendDatabaseMessage(database.value, dispatch, { from, type, text, createdAt: now, sessionId }, {
    derive: (previous) => {
      const priorDone = previous.some((message) => message.from === "child" && message.type === "done");
      const classification = classifyQueueMail(from, type, priorDone);
      const recipient = recipientForQueueMessage(from, type, priorDone);
      const deliveryId = recipient === undefined ? undefined : `delivery-${now.replace(/[-:.TZ]/g, "")}-${process.pid}-${randomUUID().slice(0, 8)}`;
      outboxId = recipient === "parent" && classification === "actionable" ? "parent-pointer-" + randomUUID() : undefined;
      return {
        ...(deliveryId === undefined ? {} : {
          delivery: {
            id: deliveryId, recipient, messageSeqs: [], status: "outstanding",
            createdAt: now, updatedAt: now, acknowledgedAt: null, fencedAt: null,
            consumer: null, consumerGeneration: null,
          },
        }),
        ...(outboxId === undefined ? {} : {
          outbox: {
            id: outboxId, dispatchId: dispatch, targetKind: "parent-pointer",
            target: typeof metaRecord.parentSessionId === "string" ? metaRecord.parentSessionId : dispatch,
            payload: { meta: metaRecord, pointer },
          },
        }),
      };
    },
  });
  if (appended.kind !== "ok") return appended;
  if (outboxId !== undefined) {
    try {
      const claim = claimOutbox(database.value, outboxId, process.pid + ":" + randomUUID(), 30);
      if (claim.kind === "ok" && claim.value !== undefined) {
        const payload = claim.value.payload;
        const record = typeof payload === "object" && payload !== null ? payload as JsonRecord : {};
        const meta = typeof record.meta === "object" && record.meta !== null ? record.meta as JsonRecord : metaRecord;
        let notification: NotificationResult;
        if (!(await parentContextMatches(root, meta, processAdapter))) notification = { outcome: "suppressed", reason: "state-directory-mismatch" };
        else if (await waiterIsActive(root, dispatch)) notification = { outcome: "suppressed", reason: "active-waiter" };
        else notification = await sendParentPointer(root, meta, typeof record.pointer === "string" ? record.pointer : pointer, environment, processAdapter);
        const status = notification.outcome === "delivered" ? "sent" : notification.outcome === "suppressed" ? "suppressed" : "failed";
        finishNotification(database.value, outboxId, status, { dispatchId: dispatch, pointer, outcome: notification.outcome, reason: notification.reason });
      }
    } catch {
      // Queue writes are durable even when the best-effort pointer transport fails.
    }
  }
  return ok(appended.value.seq);
}

export async function updateMeta(root: string, dispatch: string, type: string): Promise<Result<void>> {
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return database;
  let refused: Result<void> | undefined;
  const updated = mutateDispatch(database.value, dispatch, (current) => {
    const state = typeof current.state === "string" ? current.state : "running";
    const processState = typeof current.processState === "string" ? current.processState : "running";
    const nextState = type === "ask" ? "waiting_for_reply" : type === "done" ? "done" : state === "spawning" ? "running" : state;
    const nextProcess = type === "done" ? "succeeded" : processState === "starting" || processState === "start-unproven" ? "running" : processState;
    if (type === "done") {
      const transition = checkDispatchTransition("dispatch", state, nextState);
      if (transition.kind !== "ok") { refused = transition; return noDispatchChange; }
    }
    return {
      state: nextState, processState: nextProcess, updatedAt: new Date().toISOString(),
      ...(type === "received" ? { promptReceipt: "received", promptState: "confirmed" } : {}),
    };
  });
  if (refused !== undefined) return refused;
  if (updated.kind !== "ok") return updated;
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
