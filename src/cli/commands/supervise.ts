import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { ownedGrokLeaders, sweepGrokLeaders } from "../../agents/grok-leader.js";
import { getDispatch, listDispatches, listLeases, listMessages, listOutboxForDispatch, listDeliveries, listPendingOutboxPeerVerifications, listChildAnsweredDispatches, resourceHistoryEnabled, readOnlyStateDatabase } from "../../adapters/state-db.js";
import { findClaudeTranscript, findCodexRollout } from "../../core/context-meter.js";
import { classifyLiveness } from "../../core/liveness.js";
import { agyLogRecord, backgroundTasks, claudeActiveWork, classifyRecordedError, classifySupervision, hasOpenDispatches, isLiveProcessState, mayAutoRecover, recommendationFor, shouldNotifyFinding, type PreviousFinding, type SupervisionFinding } from "../../core/supervise.js";
import { usageMessage, usageText } from "../../core/usage.js";
import { resolveStateDirectory } from "../../core/state.js";
import { formatDispatchMessage } from "../../core/chat-message-format.js";
import { failed, ok, type Result } from "../../core/result.js";
import { APP_TMUX_SERVER, DISPATCH_TMUX_SERVER, getTmux, verifyTmuxPane } from "../../hosts/tmux.js";
import { readDeliveryScreen } from "./delivery-screen.js";
import { classifyPromptState, promptFinding, type PromptState } from "./prompt-state.js";
import { collectResources } from "./resources.js";
import { notifyAdmissionStatus } from "./admission-notify.js";
import { selfInvocation } from "../../core/self-invocation.js";
import { classifyQueueMail } from "../../core/queue-write.js";
import { callStateOwner } from "../../db/state-owner.js";
import { dispatchAutoCloseEnabled, mayAutoCloseDispatch, tmuxClientsViewedSinceDone, type TmuxViewerClient } from "../../core/dispatch-auto-close.js";
import { executeOrchestrateClose } from "./orchestrate-close.js";

type Environment = Readonly<Record<string, string | undefined>>;
type RecordValue = Record<string, unknown>;
const LEASE_KEY = "supervise";
const DEFAULT_INTERVAL_SECONDS = 60;
const LEASE_PADDING_SECONDS = 15;
const PASTE_END_MARKER = "\u001b[201~";
const AUTO_CLOSE_TMUX_SERVERS = [DISPATCH_TMUX_SERVER, APP_TMUX_SERVER] as const;
const AUTO_CLOSE_CLIENT_FORMAT = "#{client_tty}|#{client_pid}|#{client_created}|#{client_activity}|#{client_flags}";

function object(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : undefined;
}

function string(value: unknown): string | undefined { return typeof value === "string" && value !== "" ? value : undefined; }

function intervalSeconds(environment: Environment): number {
  const value = Number(environment.MEGABRAIN_SUPERVISE_INTERVAL_SECONDS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_INTERVAL_SECONDS;
}

function leaseSeconds(interval: number): number { return Math.max(30, interval + LEASE_PADDING_SECONDS); }

async function logSupervisorExit(root: string, reason: string): Promise<void> {
  try { await appendFile(resolve(root, "supervise.log"), `${JSON.stringify({ at: new Date().toISOString(), event: "worker-exit", reason })}\n`, { encoding: "utf8", mode: 0o600 }); }
  catch { /* The state directory may have been removed while the worker was running. */ }
}

const CLAUDE_TAIL_BYTES = 16 * 1024 * 1024;

// The tail is enough for work started in the recent past; a first line cut by the window fails to parse and is skipped.
async function claudeActiveSince(meta: RecordValue, environment: Environment): Promise<number> {
  const home = environment.HOME;
  const session = string(meta.agentSessionId);
  if (home === undefined || session === undefined || string(meta.agent) !== "claude") return 0;
  const path = await findClaudeTranscript(home, session);
  if (path === undefined) return 0;
  let file;
  try {
    file = await open(path, "r");
    const info = await file.stat();
    const start = Math.max(0, info.size - CLAUDE_TAIL_BYTES);
    const buffer = Buffer.alloc(info.size - start);
    await file.read(buffer, 0, buffer.length, start);
    return claudeActiveWork(buffer.toString("utf8"));
  } catch { return 0; }
  finally { await file?.close(); }
}

function readLatestLine<T>(path: string): Promise<T | undefined> {
  return (async () => {
    let file;
    try {
      file = await open(path, "r");
      const info = await file.stat();
      const start = Math.max(0, info.size - 1024 * 1024);
      const buffer = Buffer.alloc(info.size - start);
      await file.read(buffer, 0, buffer.length, start);
      for (const line of buffer.toString("utf8").split(/\r?\n/).reverse()) {
        try { return JSON.parse(line) as T; } catch { /* ignore an incomplete tail line */ }
      }
    } catch { return undefined; }
    finally { await file?.close(); }
    return undefined;
  })();
}

// glog lines carry no year: read them as this year unless that lands in the future.
async function agyRecord(logFile: string | undefined): Promise<unknown> {
  if (logFile === undefined) return undefined;
  let file;
  try {
    file = await open(logFile, "r");
    const info = await file.stat();
    const start = Math.max(0, info.size - 1024 * 1024);
    const buffer = Buffer.alloc(info.size - start);
    await file.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const year = new Date().getFullYear();
    const record = agyLogRecord(text, year);
    const at = typeof record?.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    return Number.isFinite(at) && at > Date.now() + 86_400_000 ? agyLogRecord(text, year - 1) : record;
  } catch { return undefined; }
  finally { await file?.close(); }
}

async function agentRecord(meta: RecordValue, environment: Environment): Promise<unknown> {
  const home = environment.HOME;
  if (home === undefined) return undefined;
  const agent = string(meta.agent);
  if (agent === "agy") return agyRecord(string(meta.agyLogFile));
  const path = agent === "codex" && string(meta.agentThreadId) !== undefined
    ? await findCodexRollout(home, string(meta.agentThreadId) as string)
    : agent === "claude" && string(meta.agentSessionId) !== undefined
      ? await findClaudeTranscript(home, string(meta.agentSessionId) as string)
      : undefined;
  return path === undefined ? undefined : readLatestLine(path);
}

async function recoveredSince(database: Parameters<typeof getDispatch>[0], dispatch: string, meta: RecordValue, environment: Environment, notifiedAt: number): Promise<boolean> {
  const messages = listMessages(database, dispatch);
  if (messages.kind === "ok" && messages.value.some((message) => message.from === "child" && ["received", "ask", "done"].includes(message.type) && Date.parse(message.createdAt) > notifiedAt)) return true;
  const event = object(await agentRecord(meta, environment));
  const timestamp = event?.timestamp ?? event?.created_at;
  return typeof timestamp === "string" && Date.parse(timestamp) > notifiedAt;
}

async function promptText(database: Parameters<typeof getDispatch>[0], dispatch: string): Promise<string | undefined> {
  const messages = listMessages(database, dispatch);
  if (messages.kind !== "ok") return undefined;
  return messages.value.find((message) => message.from === "parent" && message.type === "prompt")?.text;
}

function childAnswered(database: Parameters<typeof getDispatch>[0], meta: RecordValue, dispatch: string, answeredDispatches?: ReadonlySet<string>): boolean {
  if (string(meta.promptReceipt) === "received") return true;
  if (answeredDispatches !== undefined) return answeredDispatches.has(dispatch);
  const messages = listMessages(database, dispatch);
  return messages.kind === "ok" && messages.value.some((message) => message.from === "child" && (message.type === "received" || message.type === "ask" || message.type === "done"));
}

// Codex sets the pane title through OSC 0 with a braille spinner while a turn runs; tmux keeps it as pane_title.
async function paneTitle(meta: RecordValue, process: ProcessAdapter): Promise<string | undefined> {
  if (meta.runtime !== "tmux" || string(meta.tmuxPane) === undefined) return undefined;
  const result = await process.run("tmux", ["display-message", "-p", "-t", String(meta.tmuxPane), "#{pane_title}"]);
  return result.kind === "ok" ? result.value.stdout.trim() : undefined;
}

// The visible screen is not enough to call a prompt lost: a long finished turn has scrolled it away. Lost is
// only judged after the scrollback was searched for the prompt as well.
async function judgePrompt(database: Parameters<typeof getDispatch>[0], dispatch: string, meta: RecordValue, frame: string, process: ProcessAdapter, answeredDispatches?: ReadonlySet<string>): Promise<PromptState> {
  const prompt = await promptText(database, dispatch);
  if (prompt === undefined) return "unknown";
  const input = { agent: string(meta.agent) ?? "", frame, prompt, received: childAnswered(database, meta, dispatch, answeredDispatches), title: await paneTitle(meta, process) };
  const first = classifyPromptState(input).state;
  if (first !== "lost" || meta.runtime !== "tmux" || string(meta.tmuxPane) === undefined) return first;
  const history = await getTmux().capturePane(String(meta.tmuxPane), 5000, process, false, string(meta.tmuxSessionId));
  return history.kind === "ok" ? classifyPromptState({ ...input, history: history.value }).state : "unknown";
}

async function paneExists(meta: RecordValue, process: ProcessAdapter): Promise<boolean | undefined> {
  if (meta.runtime !== "tmux") return undefined;
  const pane = string(meta.tmuxPane);
  if (pane === undefined) return false;
  const sessionId = string(meta.tmuxSessionId);
  const verified = await verifyTmuxPane(pane, process, sessionId);
  return verified.kind === "ok" ? verified.value : undefined;
}

async function processAlive(meta: RecordValue, process: ProcessAdapter): Promise<boolean | undefined> {
  const pid = Number(meta.agentPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const result = await process.run("ps", ["-p", String(pid), "-o", "stat="]);
  if (result.kind === "ok") return isLiveProcessState(result.value.stdout);
  // ps exits 1 with no output when the pid is gone.
  if (result.kind === "failed" && result.exitCode === 1 && (result.stdout ?? "").trim() === "") return false;
  return undefined;
}

async function deadPaneExitCode(meta: RecordValue, process: ProcessAdapter): Promise<number | undefined> {
  if (meta.runtime !== "tmux" || typeof meta.tmuxPane !== "string") return undefined;
  const result = await process.run("tmux", ["display-message", "-p", "-t", meta.tmuxPane, "#{pane_dead_status}"]);
  if (result.kind !== "ok") return undefined;
  const code = Number(result.value.stdout.trim());
  return Number.isSafeInteger(code) && code >= 0 ? code : undefined;
}

async function changedFiles(meta: RecordValue, process: ProcessAdapter): Promise<string[]> {
  const worktree = string(meta.worktreePath);
  if (worktree === undefined) return [];
  const result = await process.run("git", ["-C", worktree, "status", "--short", "--untracked-files=all"]);
  if (result.kind !== "ok") return [];
  return result.value.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
}

function previousFinding(meta: RecordValue): PreviousFinding | undefined {
  const previous = object(meta.superviseFinding);
  if (previous === undefined || typeof previous.cause !== "string" || typeof previous.notifiedAt !== "number") return undefined;
  const evidence = ["resetAt", "errorCode", "errorText", "exitCode", "lastLines", "paneId", "worktreePath", "dirtyFiles"]
    .flatMap((key) => previous[key] === undefined ? [] : [[key, previous[key]] as const]);
  return { cause: previous.cause as SupervisionFinding["cause"], ...Object.fromEntries(evidence), notifiedAt: previous.notifiedAt } as PreviousFinding;
}

function screenErrorCause(frame: string): SupervisionFinding | undefined {
  if (/(?:you['’]ve hit your usage limit|usage limit reached)/i.test(frame)) {
    const match = /(?:try again|reset(?:s)?)(?: at| after)?\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i.exec(frame);
    return { cause: "usage-limit", resetAt: match?.[1] ?? "unknown reset time" };
  }
  if (/\b429\b|429 Too Many Requests/i.test(frame)) return { cause: "rate-limited", errorCode: "429" };
  const server = /(?:API Error:\s*|unexpected status\s+)(5\d\d)\b/i.exec(frame);
  if (server !== null || /overloaded_error|\bOverloaded\b|Internal Server Error/i.test(frame)) return { cause: "server-error", ...(server?.[1] === undefined ? {} : { errorCode: server[1] }) };
  if (/Request timed out|Connection error|stream disconnected/i.test(frame)) return { cause: "network", errorCode: /timed out/i.test(frame) ? "timeout" : /stream disconnected/i.test(frame) ? "stream disconnected" : "connection error" };
  if (/authentication required|unauthorized|token[^\n]{0,50}revoked|not logged in/i.test(frame)) return { cause: "auth-required" };
  return undefined;
}

function findingSentence(finding: SupervisionFinding): string {
  const cause = finding.cause;
  const detail = finding.cause === "usage-limit" ? `; resets at ${finding.resetAt ?? "unknown time"}`
    : finding.errorCode === undefined ? "" : `; error ${finding.errorCode}`;
  return `${cause}${detail}`;
}

async function recoverPrompt(database: Parameters<typeof getDispatch>[0], meta: RecordValue, finding: SupervisionFinding, frame: string, dispatch: string, process: ProcessAdapter): Promise<string | undefined> {
  if (!mayAutoRecover(finding) || meta.runtime !== "tmux" || typeof meta.tmuxPane !== "string") return undefined;
  const existing = object(meta.superviseFinding);
  if (typeof existing?.autoRecoveryAttemptedAt === "number") return "previous automatic submission was already attempted";
  const verified = await verifyTmuxPane(meta.tmuxPane, process, string(meta.tmuxSessionId));
  if (verified.kind !== "ok" || !verified.value) return "submission was not attempted because the pane could not be verified";
  if (await judgePrompt(database, dispatch, meta, frame, process) !== "unsubmitted") return "submission was not attempted because the prompt is no longer in the composer";
  // A composer left inside an unterminated bracketed paste takes Enter as a newline; the end marker closes it first.
  const closed = await getTmux().sendText(meta.tmuxPane, PASTE_END_MARKER, process, string(meta.tmuxSessionId));
  if (closed.kind !== "ok") return `submission failed: ${closed.kind === "failed" ? closed.error : closed.reason}`;
  const sent = await getTmux().sendKey(meta.tmuxPane, "Enter", process, string(meta.tmuxSessionId));
  if (sent.kind !== "ok") return `submission failed: ${sent.kind === "failed" ? sent.error : sent.reason}`;
  const after = await getTmux().capturePane(meta.tmuxPane, 200, process, true, string(meta.tmuxSessionId));
  const confirmed = after.kind === "ok" && await judgePrompt(database, dispatch, meta, after.value, process) !== "unsubmitted";
  return confirmed ? "prompt submission confirmed" : "Enter was sent; submission is not yet confirmed";
}

async function notifyParent(root: string, database: Parameters<typeof getDispatch>[0], dispatch: string, meta: RecordValue, finding: SupervisionFinding, process: ProcessAdapter, now: number, recovery?: string): Promise<void> {
  const recommendation = recommendationFor(finding, dispatch);
  if (recommendation === undefined) return;
  const agent = string(meta.agent) ?? "unknown";
  const chat = string(meta.chatName) ?? string(meta.branch) ?? dispatch;
  const text = `${findingSentence(finding)}. ${recovery === undefined ? "" : `Automatic recovery: ${recovery}. `}Recommended: ${recommendation}`;
  const fullMessage = formatDispatchMessage({ dispatchId: dispatch, chatName: chat, agent, type: "supervise", text, direction: "parent-bound" });
  const createdAt = new Date(now).toISOString();
  const idempotencyKey = `${dispatch}:supervise:${finding.cause}:${now}`;
  const outboxId = `supervise-${idempotencyKey.replace(/[^A-Za-z0-9._-]/g, "-")}`;
  await callStateOwner(root, { operation: "append-message", dispatchId: dispatch, message: {
    from: "child", type: "supervise", text, sessionId: string(meta.terminalId) ?? "", createdAt, idempotencyKey,
  }, delivery: { id: `delivery-${outboxId}`, recipient: "parent", status: "outstanding", createdAt, updatedAt: createdAt, acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null },
  outbox: { id: outboxId, targetKind: "parent-pointer", target: string(meta.parentSessionId) ?? dispatch, payload: { meta, dispatchId: dispatch, targetKind: "parent-pointer", pointer: `mail: megabrain orchestrate watch ${dispatch}`, fullMessage } } }).catch(() => undefined);
}

async function inspectDispatch(root: string, database: Parameters<typeof getDispatch>[0], dispatch: string, meta: RecordValue, environment: Environment, process: ProcessAdapter, now: number, answeredDispatches?: ReadonlySet<string>): Promise<SupervisionFinding> {
  const files = await changedFiles(meta, process);
  const panePresent = await paneExists(meta, process);
  if (panePresent === false) return { cause: "pane-gone", paneId: string(meta.tmuxPane), worktreePath: string(meta.worktreePath), dirtyFiles: files };
  const alive = await processAlive(meta, process);
  const screen = await readDeliveryScreen(meta, process);
  if (screen.kind !== "ok" && alive !== false) {
    if (screen.kind === "failed" && /terminal is no longer available|pane .*does not exist/i.test(screen.error)) return { cause: "pane-gone", paneId: string(meta.tmuxPane), worktreePath: string(meta.worktreePath), dirtyFiles: files };
    return { cause: "unknown" };
  }
  const frame = screen.kind === "ok" ? screen.value : "";
  const lastLines = frame.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
  if (alive === false) {
    const base = classifySupervision({ frame, paneExists: true, processAlive: false, promptUnsubmitted: false, ...(string(meta.worktreePath) === undefined ? {} : { worktreePath: string(meta.worktreePath) }), dirtyFiles: files });
    const exitCode = await deadPaneExitCode(meta, process);
    return { ...base, ...(exitCode === undefined ? {} : { exitCode }), ...(lastLines === "" ? {} : { lastLines }) };
  }
  // Running shells or monitors mean the agent is working in the background, not stuck.
  if (backgroundTasks(frame) !== undefined || await claudeActiveSince(meta, environment) > 0) return { cause: "unknown" };
  const agent = string(meta.agent) ?? "";
  // Spawn owns the first prompt until its transport step settles: an agent launched with the brief on
  // its command line may idle at an empty composer for seconds before submitting it.
  const inTransport = meta.state === "spawning" && meta.promptTransport === "pending";
  const promptState = inTransport ? "unknown" : await judgePrompt(database, dispatch, meta, frame, process, answeredDispatches);
  const promptProblem = promptFinding(promptState);
  if (promptProblem.cause !== "unknown") return promptProblem;
  const idle = classifyLiveness(agent, frame).status === "idle";
  const event = await agentRecord(meta, environment);
  const recorded = classifyRecordedError(agent, event, { now, idlePrompt: idle });
  if (recorded.cause !== "unknown") return recorded;
  if (idle) {
    const visibleError = screenErrorCause(frame);
    if (visibleError !== undefined) return visibleError;
  }
  const blocked = classifySupervision({ frame, paneExists: true, processAlive: alive ?? true, promptUnsubmitted: false, ...(string(meta.worktreePath) === undefined ? {} : { worktreePath: string(meta.worktreePath) }), dirtyFiles: files });
  return blocked.cause === "dialog-waiting" ? blocked : { cause: "unknown" };
}

async function retryPendingChildReplies(root: string, database: Parameters<typeof getDispatch>[0], dispatch: string): Promise<void> {
  const outbox = listOutboxForDispatch(database, dispatch);
  const deliveries = listDeliveries(database, dispatch);
  const messages = listMessages(database, dispatch);
  if (outbox.kind !== "ok" || deliveries.kind !== "ok" || messages.kind !== "ok") return;
  const pendingReplies = outbox.value.filter((item) => item.targetKind === "child-delivery" && item.status === "pending");
  for (const item of pendingReplies) {
    const payload = object(item.payload);
    const sequence = Number(payload?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) continue;
    const message = messages.value.find((candidate) => candidate.seq === sequence);
    if (message?.from !== "parent" || message.type !== "reply") continue;
    const delivery = deliveries.value.find((candidate) => Array.isArray(candidate.messageSeqs) && candidate.messageSeqs.includes(sequence));
    if (delivery?.status !== "outstanding") continue;
    await callStateOwner(root, { operation: "resume-outbox", id: item.id }).catch(() => false);
  }
}

async function retryPendingParentPointers(root: string, database: Parameters<typeof getDispatch>[0], dispatch: string): Promise<void> {
  const outbox = listOutboxForDispatch(database, dispatch);
  const deliveries = listDeliveries(database, dispatch);
  const messages = listMessages(database, dispatch);
  if (outbox.kind !== "ok" || deliveries.kind !== "ok" || messages.kind !== "ok") return;
  for (const item of outbox.value) {
    if (item.targetKind !== "parent-pointer" || item.status !== "pending") continue;
    const payload = object(item.payload);
    const sequence = Number(payload?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) continue;
    const message = messages.value.find((candidate) => candidate.seq === sequence);
    if (message?.from !== "child") continue;
    if (classifyQueueMail(message.from, message.type, false) !== "actionable") continue;
    const delivery = deliveries.value.find((candidate) => candidate.recipient === "parent" && Array.isArray(candidate.messageSeqs) && candidate.messageSeqs.includes(sequence));
    if (delivery?.status !== "outstanding") continue;
    await callStateOwner(root, { operation: "resume-outbox", id: item.id }).catch(() => false);
  }
}

async function settleImplicitChildReads(root: string, database: Parameters<typeof getDispatch>[0], dispatch: string): Promise<void> {
  const deliveries = listDeliveries(database, dispatch);
  const messages = listMessages(database, dispatch);
  if (deliveries.kind !== "ok" || messages.kind !== "ok") return;
  for (const delivery of deliveries.value) {
    if (delivery.recipient !== "child" || !Array.isArray(delivery.messageSeqs)) continue;
    if (delivery.transport !== "checked" && delivery.transportReason !== "full-direction") continue;
    const lastSequence = Math.max(0, ...delivery.messageSeqs);
    if (!messages.value.some((message) => message.from === "child" && message.seq > lastSequence)) continue;
    await callStateOwner(root, { operation: "ack-implicit-delivery", dispatchId: dispatch, deliveryId: delivery.id, recipient: "child" });
  }
}

function clientListUnavailable(reason: string): boolean {
  return /no server running|can't find session|no such session|no current client/i.test(reason);
}

async function tmuxClientViewedSinceDone(session: string, doneAt: string, viewerClients: readonly TmuxViewerClient[], process: ProcessAdapter): Promise<boolean | undefined> {
  for (const server of AUTO_CLOSE_TMUX_SERVERS) {
    const result = await process.run("tmux", ["-L", server, "list-clients", "-t", session, "-F", AUTO_CLOSE_CLIENT_FORMAT]);
    if (result.kind !== "ok") {
      const reason = result.kind === "failed" ? result.error : result.reason;
      if (clientListUnavailable(reason)) continue;
      return undefined;
    }
    const viewed = tmuxClientsViewedSinceDone(result.value.stdout, doneAt, viewerClients, server);
    if (viewed !== false) return viewed;
  }
  return false;
}

async function closeUnviewedDoneTmuxDispatches(
  root: string,
  database: Parameters<typeof getDispatch>[0],
  dispatches: readonly RecordValue[],
  environment: Environment,
  process: ProcessAdapter,
  now: number,
): Promise<boolean> {
  if (!await dispatchAutoCloseEnabled({ ...environment, MEGABRAIN_STATE_DIR: root })) return false;
  let pending = false;
  for (const raw of dispatches) {
    const dispatch = string(raw.dispatchId);
    const session = string(raw.tmuxSession);
    if (dispatch === undefined || session === undefined || raw.state !== "done" || raw.runtime !== "tmux" || raw.keepOpen === true || raw.autoCloseViewedAt !== undefined) continue;
    if (raw.autoCloseViewerIdentityUnknown === true) { pending = true; continue; }
    const messages = listMessages(database, dispatch);
    const deliveries = listDeliveries(database, dispatch);
    if (messages.kind !== "ok" || deliveries.kind !== "ok") { pending = true; continue; }
    const doneMessage = messages.value.filter((message) => message.from === "child" && message.type === "done").at(-1);
    if (doneMessage === undefined) { pending = true; continue; }
    const delivery = deliveries.value.find((item) => item.recipient === "parent" && Array.isArray(item.messageSeqs) && item.messageSeqs.includes(doneMessage.seq));
    if (delivery?.status !== "acknowledged" || typeof delivery.acknowledgedAt !== "string") { pending = true; continue; }
    const doneTime = Date.parse(doneMessage.createdAt);
    const acknowledgedTime = Date.parse(delivery.acknowledgedAt);
    if (!Number.isFinite(doneTime) || !Number.isFinite(acknowledgedTime) || acknowledgedTime < doneTime) { pending = true; continue; }
    const viewerClients = Array.isArray(raw.autoCloseViewerClients)
      ? raw.autoCloseViewerClients.filter((client): client is TmuxViewerClient => {
        if (typeof client !== "object" || client === null) return false;
        const identity = client as Record<string, unknown>;
        return typeof identity.server === "string" && typeof identity.tty === "string" && Number.isSafeInteger(identity.pid);
      })
      : [];
    const viewed = await tmuxClientViewedSinceDone(session, doneMessage.createdAt, viewerClients, process);
    if (viewed === undefined) { pending = true; continue; }
    if (viewed) {
      await callStateOwner(root, { operation: "dispatch-patch", dispatchId: dispatch, expectedState: "done", patch: { autoCloseViewedAt: new Date(now).toISOString() } }).catch(() => undefined);
      continue;
    }
    const mayClose = mayAutoCloseDispatch({
      state: String(raw.state), runtime: String(raw.runtime), keepOpen: false, enabled: true,
      acknowledgedAt: delivery.acknowledgedAt, now, viewedSinceDone: false,
    });
    if (!mayClose) { pending = true; continue; }
    const closed = await executeOrchestrateClose([dispatch], { ...environment, MEGABRAIN_STATE_DIR: root }, process);
    if (closed.kind !== "ok") pending = true;
  }
  return pending;
}

export async function superviseOnce(root: string, database: Parameters<typeof getDispatch>[0], environment: Environment, process: ProcessAdapter, now = Date.now()): Promise<{ open: boolean; findings: number }> {
  try { await callStateOwner(root, { operation: "settle-closed-parent-backlog" }); }
  catch { return { open: true, findings: 0 }; }
  let pendingPeerVerifications = false;
  let verificationCursor: { createdAt: string; id: string } | undefined;
  do {
    const page = listPendingOutboxPeerVerifications(database, { after: verificationCursor, limit: 100 });
    if (page.kind !== "ok") break;
    pendingPeerVerifications ||= page.value.rows.length > 0;
    for (const item of page.value.rows) {
      if (now - item.record.acceptedAt < 5 * 60 * 1000) continue;
      const scheduled = await callStateOwner(root, { operation: "schedule-verification-resume", id: item.id, now }).catch(() => undefined) as { scheduled?: boolean } | undefined;
      if (scheduled?.scheduled === true) await callStateOwner(root, { operation: "resume-verification", id: item.id }).catch(() => undefined);
    }
    verificationCursor = page.value.nextCursor;
  } while (verificationCursor !== undefined);
  const listed = listDispatches(database);
  if (listed.kind !== "ok") return { open: false, findings: 0 };
  await sweepGrokLeaders(root, ownedGrokLeaders(listed.value), process);
  const autoClosePending = await closeUnviewedDoneTmuxDispatches(root, database, listed.value, environment, process, now);
  const openDispatches = listed.value.filter((record) => ["queued", "spawning", "running", "waiting_for_reply", "orphaned"].includes(String(record.state)));
  if (!hasOpenDispatches(openDispatches.map((record) => String(record.state)))) return { open: pendingPeerVerifications || autoClosePending, findings: 0 };
  const answerState = listChildAnsweredDispatches(database, openDispatches.map((record) => String(record.dispatchId)));
  const answeredDispatches = answerState.kind === "ok" ? answerState.value : undefined;
  let findings = 0;
  for (const queued of openDispatches.filter((record) => (record.state === "queued" || record.state === "spawning") && record.admissionQueueEntry === true)) {
    const dispatch = queued.dispatchId;
    const spawnArgs = Array.isArray(queued.queuedSpawnArgs) ? queued.queuedSpawnArgs.filter((value): value is string => typeof value === "string") : [];
    const { executeSpawn } = await import("./orchestrate-spawn.js");
    const started = await executeSpawn(spawnArgs, { ...environment, MEGABRAIN_STATE_DIR: root, MEGABRAIN_SPAWN_DISPATCH_ID: dispatch }, process);
    const after = getDispatch(database, dispatch);
    if (started.kind === "ok" && after.kind === "ok" && after.value !== undefined && !["queued", "failed", "closed", "done"].includes(String(after.value.state))) {
      await notifyAdmissionStatus(root, database, dispatch, after.value as RecordValue, "started", "", process, undefined, now);
      findings += 1;
    } else if (after.kind === "ok" && after.value?.state === "queued") {
      if (started.kind !== "ok") {
        await callStateOwner(root, { operation: "dispatch-patch", dispatchId: dispatch, expectedState: "queued", patch: { state: "failed", reason: started.kind === "failed" ? started.error : started.reason } });
        continue;
      }
      break;
    } else if (started.kind !== "ok") {
      await callStateOwner(root, { operation: "dispatch-patch", dispatchId: dispatch, expectedState: "spawning", patch: { state: "failed", processState: "failed", reason: started.kind === "failed" ? started.error : started.reason } });
    }
  }
  for (const item of openDispatches) {
    if (item.state === "queued" || item.admissionQueueEntry === true) continue;
    const dispatch = string(item.dispatchId);
    if (dispatch === undefined) continue;
    const current = getDispatch(database, dispatch);
    if (current.kind !== "ok" || current.value === undefined) continue;
    const meta = current.value as RecordValue;
    await settleImplicitChildReads(root, database, dispatch);
    await retryPendingParentPointers(root, database, dispatch);
    const finding = await inspectDispatch(root, database, dispatch, meta, environment, process, now, answeredDispatches);
    const screen = finding.cause === "unknown" ? await readDeliveryScreen(meta, process) : undefined;
    const running = screen?.kind === "ok" ? backgroundTasks(screen.value) : undefined;
    if (screen?.kind === "ok") await retryPendingChildReplies(root, database, dispatch);
    const recordedPrevious = previousFinding(meta);
    const recovered = recordedPrevious !== undefined && await recoveredSince(database, dispatch, meta, environment, recordedPrevious.notifiedAt);
    const previous = recovered ? undefined : recordedPrevious;
    const shouldNotify = shouldNotifyFinding(previous, finding, now);
    let recovery: string | undefined;
    if (finding.cause === "prompt-unsubmitted") {
      const screen = await readDeliveryScreen(meta, process);
      if (screen.kind === "ok") recovery = await recoverPrompt(database, meta, finding, screen.value, dispatch, process);
    }
    if (shouldNotify) {
      await notifyParent(root, database, dispatch, meta, finding, process, now, recovery);
      findings += 1;
    }
    await callStateOwner(root, { operation: "dispatch-patch", dispatchId: dispatch, patch: {
      superviseLastCheck: new Date(now).toISOString(),
      ...(running === undefined ? {} : { backgroundTasks: running }),
      superviseFinding: finding.cause === "unknown"
        ? { cause: "unknown", lastSeenAt: new Date(now).toISOString() }
        : { ...finding, cause: finding.cause, lastSeenAt: new Date(now).toISOString(), notifiedAt: shouldNotify ? now : previous?.notifiedAt ?? now, ...(recovery === undefined ? {} : { autoRecoveryAttemptedAt: now, autoRecoveryResult: recovery }) },
    } });
  }
  const historyEnvironment = { ...environment, MEGABRAIN_STATE_DIR: root };
  if (await resourceHistoryEnabled(historyEnvironment)) {
    const snapshot = await collectResources(historyEnvironment, process, true, false);
    await callStateOwner(root, { operation: "resource-samples", samples: snapshot.dispatches.flatMap((item) => item.resources === undefined ? [] : [{ dispatchId: item.dispatchId, agent: item.agent, rssBytes: item.resources.rssBytes, cpuPercent: item.resources.cpuPercent }]), now });
  }
  return { open: true, findings };
}

export async function startSupervisorWorker(root: string, environment: Environment, process: ProcessAdapter): Promise<"started" | "already-running" | "no-open-dispatches" | "failed"> {
  const database = readOnlyStateDatabase({ ...environment, MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return "failed";
  const listed = listDispatches(database.value);
  if (listed.kind !== "ok") return "failed";
  const peerVerifications = listPendingOutboxPeerVerifications(database.value, { limit: 1 });
  const hasPendingPeerVerification = peerVerifications.kind === "ok" && peerVerifications.value.rows.length > 0;
  const autoCloseEnabled = await dispatchAutoCloseEnabled({ ...environment, MEGABRAIN_STATE_DIR: root });
  const hasAutoCloseCandidate = autoCloseEnabled && listed.value.some((record) => record.state === "done" && record.runtime === "tmux" && typeof record.tmuxSession === "string" && record.keepOpen !== true && record.autoCloseViewedAt === undefined);
  if (!hasOpenDispatches(listed.value.map((record) => String(record.state))) && !hasPendingPeerVerification && !hasAutoCloseCandidate) return "no-open-dispatches";
  const holder = `${globalThis.process.pid}-${randomUUID()}`;
  const lease = await callStateOwner(root, { operation: "acquire-lease", key: LEASE_KEY, holder, seconds: leaseSeconds(intervalSeconds(environment)) }).catch(() => false) as boolean;
  if (!lease) return "already-running";
  const worker = selfInvocation(globalThis.process.execPath, globalThis.process.argv, ["__supervise-worker", holder]);
  const started = await process.startDetached(worker.command, worker.args);
  if (started.kind !== "ok") {
    await callStateOwner(root, { operation: "release-lease", key: LEASE_KEY, holder }).catch(() => undefined);
    return "failed";
  }
  return "started";
}

export async function executeSupervisorWorker(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const starter = args[0];
  if (starter === undefined || !/^\d+-[0-9a-f-]+$/i.test(starter)) return failed("supervisor worker requires its lease holder", 2);
  const root = resolveStateDirectory(environment);
  const database = readOnlyStateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  // The starter's lease names the starter's pid, which has exited; --stop needs the worker's own.
  const holder = `${globalThis.process.pid}-${randomUUID()}`;
  const transferred = await callStateOwner(root, { operation: "transfer-lease", key: LEASE_KEY, from: starter, to: holder }).catch(() => false) as boolean;
  if (!transferred) {
    await logSupervisorExit(root, "lease was taken by another worker");
    return ok("supervisor lease was taken by another worker\n");
  }
  const delay = intervalSeconds(environment) * 1000;
  let running = true;
  let exitReason = "worker exited without a recorded reason";
  const stop = (signal: NodeJS.Signals): void => { exitReason = `received ${signal}`; running = false; };
  const stopTerm = (): void => stop("SIGTERM");
  const stopInt = (): void => stop("SIGINT");
  globalThis.process.once("SIGTERM", stopTerm);
  globalThis.process.once("SIGINT", stopInt);
  try {
    while (running) {
      if (!existsSync(resolve(root, "megabrain.db"))) { exitReason = "state database was removed"; break; }
      const renewed = await callStateOwner(root, { operation: "acquire-lease", key: LEASE_KEY, holder, seconds: leaseSeconds(intervalSeconds(environment)) }).catch(() => false) as boolean;
      if (!renewed) {
        exitReason = "supervisor lease was lost";
        break;
      }
      const status = await superviseOnce(root, database.value, environment, process);
      if (!status.open) { exitReason = "no work remains"; break; }
      for (let elapsed = 0; running && elapsed < delay; elapsed += 250) await new Promise((resolve) => setTimeout(resolve, Math.min(250, delay - elapsed)));
    }
  } finally {
    globalThis.process.off("SIGTERM", stop);
    globalThis.process.off("SIGINT", stop);
    if (existsSync(resolve(root, "megabrain.db"))) await callStateOwner(root, { operation: "release-lease", key: LEASE_KEY, holder }).catch(() => undefined);
    await logSupervisorExit(root, exitReason);
    database.value.close();
  }
  return ok(`supervisor stopped: ${exitReason}\n`);
}

export function supervisorWatcher(database: Parameters<typeof getDispatch>[0]): Readonly<{ running: boolean; pid: number | null }> {
  const leases = listLeases(database);
  const lease = leases.kind === "ok" ? leases.value.find((item) => item.key === LEASE_KEY) : undefined;
  if (lease === undefined) return { running: false, pid: null };
  const pid = Number(lease.holder.split("-", 1)[0]);
  return { running: true, pid: Number.isSafeInteger(pid) && pid > 1 ? pid : null };
}

function formatStatus(root: string, database: Parameters<typeof getDispatch>[0], resourceLines: readonly string[] = [], measured: Awaited<ReturnType<typeof collectResources>>["dispatches"] = []): string {
  const lease = listLeases(database);
  const dispatches = listDispatches(database);
  if (lease.kind !== "ok" || dispatches.kind !== "ok") return "Supervisor status is unavailable.\n";
  const active = lease.value.find((item) => item.key === LEASE_KEY);
  const open = dispatches.value.filter((item) => ["spawning", "running", "waiting_for_reply", "orphaned"].includes(String(item.state)));
  const lines = [...resourceLines, `state directory: ${root}`, `watcher: ${active === undefined ? "stopped" : `running (pid ${active.holder.split("-", 1)[0]})`}`];
  if (open.length === 0) lines.push("dispatches: none open");
  const measuredById = new Map(measured.map((item) => [item.dispatchId, item]));
  for (const item of open) {
    const meta = item as RecordValue;
    const finding = object(meta.superviseFinding);
    const resource = measuredById.get(String(item.dispatchId));
    lines.push(`${String(item.dispatchId)} · last check ${string(meta.superviseLastCheck) ?? "not checked yet"} · finding ${string(finding?.cause) ?? "none"} · RSS ${resource?.resources === undefined ? "n/a" : `${(resource.resources.rssBytes / 1024 / 1024).toFixed(0)} MiB`} · CPU ${resource?.resources?.cpuPercent.toFixed(1) ?? "n/a"}%`);
  }
  return `${lines.join("\n")}\n`;
}

export async function executeSupervise(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("supervise"));
  const root = resolveStateDirectory(environment);
  const database = readOnlyStateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  if (args.length === 1 && args[0] === "--status") {
    const measured = await collectResources({ MEGABRAIN_STATE_DIR: root }, process, true, false);
    const machine = measured.machine;
    const machineLine = machine === null ? "machine: unavailable" : `machine: ${Math.round(machine.availableMemoryBytes / 1024 / 1024)} MiB available / ${Math.round(machine.totalMemoryBytes / 1024 / 1024)} MiB · pressure ${machine.pressure} · swap ${Math.round(machine.swapUsedBytes / 1024 / 1024)} MiB · load ${machine.loadAverage1.toFixed(2)}/${machine.loadAverage5.toFixed(2)} · ${machine.cpuCount} CPUs`;
    return ok(formatStatus(root, database.value, [machineLine], measured.dispatches));
  }
  if (args.length === 1 && args[0] === "--stop") {
    const leases = listLeases(database.value);
    if (leases.kind !== "ok") return failed(leases.error);
    const lease = leases.value.find((item) => item.key === LEASE_KEY);
    if (lease === undefined) return ok("supervisor is already stopped\n");
    const pid = Number(lease.holder.split("-", 1)[0]);
    if (!Number.isSafeInteger(pid) || pid <= 1) return failed("supervisor lease has an invalid process id");
    const stopped = await process.run("kill", ["-TERM", String(pid)]);
    return stopped.kind === "ok" ? ok("supervisor stopping\n") : failed(stopped.error);
  }
  if (args.length !== 0) return failed(usageMessage("supervise"), 2);
  const started = await startSupervisorWorker(root, environment, process);
  if (started === "failed") return failed("could not start the supervisor worker");
  return ok(started === "started" ? "supervisor started\n" : started === "already-running" ? "supervisor already running\n" : "No open dispatches to watch.\n");
}
