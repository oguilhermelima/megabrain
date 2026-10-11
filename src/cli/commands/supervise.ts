import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { appendMessage, getDispatch, listDispatches, listLeases, listMessages, mutateDispatch, releaseLease, stateDatabase } from "../../adapters/state-db.js";
import { findClaudeTranscript, findCodexRollout } from "../../core/context-meter.js";
import { classifyLiveness } from "../../core/liveness.js";
import { acquireSupervisorLease, backgroundTasks, classifyRecordedError, classifySupervision, hasOpenDispatches, mayAutoRecover, recommendationFor, shouldNotifyFinding, type SupervisionFinding } from "../../core/supervise.js";
import { usageMessage, usageText } from "../../core/usage.js";
import { resolveStateDirectory } from "../../core/state.js";
import { formatDispatchMessage } from "../../core/chat-message-format.js";
import { failed, ok, type Result } from "../../core/result.js";
import { getTmux, verifyTmuxPane } from "../../hosts/tmux.js";
import { startDeliveryWorker } from "./delivery-worker.js";
import { deliveryComposer, readDeliveryScreen } from "./delivery-screen.js";

type Environment = Readonly<Record<string, string | undefined>>;
type RecordValue = Record<string, unknown>;
const LEASE_KEY = "supervise";
const DEFAULT_INTERVAL_SECONDS = 60;
const LEASE_PADDING_SECONDS = 15;

function object(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : undefined;
}

function string(value: unknown): string | undefined { return typeof value === "string" && value !== "" ? value : undefined; }

function intervalSeconds(environment: Environment): number {
  const value = Number(environment.MEGABRAIN_SUPERVISE_INTERVAL_SECONDS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_INTERVAL_SECONDS;
}

function leaseSeconds(interval: number): number { return Math.max(30, interval + LEASE_PADDING_SECONDS); }

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

async function agentRecord(meta: RecordValue, environment: Environment): Promise<unknown> {
  const home = environment.HOME;
  if (home === undefined) return undefined;
  const agent = string(meta.agent);
  const path = agent === "codex" && string(meta.agentThreadId) !== undefined
    ? await findCodexRollout(home, string(meta.agentThreadId) as string)
    : agent === "claude" && string(meta.agentSessionId) !== undefined
      ? await findClaudeTranscript(home, string(meta.agentSessionId) as string)
      : undefined;
  return path === undefined ? undefined : readLatestLine(path);
}

async function promptText(database: Parameters<typeof getDispatch>[0], dispatch: string): Promise<string | undefined> {
  const messages = listMessages(database, dispatch);
  if (messages.kind !== "ok") return undefined;
  return messages.value.find((message) => message.from === "parent" && message.type === "prompt")?.text;
}

function promptIsVisible(meta: RecordValue, dispatch: string, prompt: string | undefined, frame: string, agent: string): boolean {
  if (prompt === undefined || string(meta.promptReceipt) === "received" || !frame.includes(`[megabrain dispatch:`)) return false;
  const tail = prompt.replace(/\s+/g, " ").trim().slice(-80);
  const visible = frame.replace(/\s+/g, " ").trim();
  const hasIdentity = visible.includes(`Dispatch identity: ${dispatch}`);
  const draft = deliveryComposer(agent, frame);
  return hasIdentity && tail.length >= 30 && (visible.includes(tail) || draft?.replace(/\s+/g, " ").includes(tail) === true);
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
  if (result.kind === "ok") return result.value.stdout.trim() !== "";
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

function previousFinding(meta: RecordValue): { cause: SupervisionFinding["cause"]; notifiedAt: number; autoRecoveryAttemptedAt?: number } | undefined {
  const previous = object(meta.superviseFinding);
  if (previous === undefined || typeof previous.cause !== "string" || typeof previous.notifiedAt !== "number") return undefined;
  return { cause: previous.cause as SupervisionFinding["cause"], notifiedAt: previous.notifiedAt, ...(typeof previous.autoRecoveryAttemptedAt === "number" ? { autoRecoveryAttemptedAt: previous.autoRecoveryAttemptedAt } : {}) };
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

async function recoverPrompt(meta: RecordValue, finding: SupervisionFinding, frame: string, dispatch: string, process: ProcessAdapter): Promise<string | undefined> {
  if (!mayAutoRecover(finding) || meta.runtime !== "tmux" || typeof meta.tmuxPane !== "string") return undefined;
  const existing = object(meta.superviseFinding);
  if (typeof existing?.autoRecoveryAttemptedAt === "number") return "previous automatic submission was already attempted";
  const verified = await verifyTmuxPane(meta.tmuxPane, process, string(meta.tmuxSessionId));
  if (verified.kind !== "ok" || !verified.value) return "submission was not attempted because the pane could not be verified";
  if (!frame.includes(`Dispatch identity: ${dispatch}`)) return "submission was not attempted because the prompt identity was not visible";
  const sent = await getTmux().sendKey(meta.tmuxPane, "Enter", process, string(meta.tmuxSessionId));
  if (sent.kind !== "ok") return `submission failed: ${sent.kind === "failed" ? sent.error : sent.reason}`;
  const after = await getTmux().capturePane(meta.tmuxPane, 200, process, true, string(meta.tmuxSessionId), true);
  const confirmed = after.kind === "ok" && !after.value.includes(`Dispatch identity: ${dispatch}`);
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
  const idempotencyKey = `${dispatch}:supervise:${finding.cause}:${Math.floor(now / (30 * 60_000))}`;
  const outboxId = `supervise-${idempotencyKey.replace(/[^A-Za-z0-9._-]/g, "-")}`;
  const appended = appendMessage(database, dispatch, {
    from: "child", type: "supervise", text, sessionId: string(meta.terminalId) ?? "", createdAt,
    idempotencyKey,
  }, {
    delivery: { id: `delivery-${outboxId}`, recipient: "parent", status: "outstanding", createdAt, updatedAt: createdAt, acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null },
    outbox: { id: outboxId, dispatchId: dispatch, targetKind: "parent-pointer", target: string(meta.parentSessionId) ?? dispatch, payload: { meta, dispatchId: dispatch, targetKind: "parent-pointer", pointer: `mail: megabrain orchestrate watch ${dispatch}`, fullMessage } },
  });
  if (appended.kind !== "ok") return;
  await startDeliveryWorker(root, dispatch, outboxId, { ...meta, dispatchId: dispatch, targetKind: "parent-pointer", fullMessage, pointer: `mail: megabrain orchestrate watch ${dispatch}` }, process);
}

async function inspectDispatch(root: string, database: Parameters<typeof getDispatch>[0], dispatch: string, meta: RecordValue, environment: Environment, process: ProcessAdapter, now: number): Promise<SupervisionFinding> {
  const files = await changedFiles(meta, process);
  const panePresent = await paneExists(meta, process);
  if (panePresent === false) return { cause: "pane-gone", worktreePath: string(meta.worktreePath), dirtyFiles: files };
  const alive = await processAlive(meta, process);
  const screen = await readDeliveryScreen(meta, process);
  if (screen.kind !== "ok" && alive !== false) {
    if (screen.kind === "failed" && /terminal is no longer available|pane .*does not exist/i.test(screen.error)) return { cause: "pane-gone", worktreePath: string(meta.worktreePath), dirtyFiles: files };
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
  if (backgroundTasks(frame) !== undefined) return { cause: "unknown" };
  const agent = string(meta.agent) ?? "";
  const prompt = await promptText(database, dispatch);
  const submitted = promptIsVisible(meta, dispatch, prompt, frame, agent);
  if (submitted) return { cause: "prompt-unsubmitted" };
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

async function superviseOnce(root: string, database: Parameters<typeof getDispatch>[0], environment: Environment, process: ProcessAdapter, now = Date.now()): Promise<{ open: boolean; findings: number }> {
  const listed = listDispatches(database);
  if (listed.kind !== "ok") return { open: false, findings: 0 };
  const openDispatches = listed.value.filter((record) => ["spawning", "running", "waiting_for_reply", "orphaned"].includes(String(record.state)));
  if (!hasOpenDispatches(openDispatches.map((record) => String(record.state)))) return { open: false, findings: 0 };
  let findings = 0;
  for (const item of openDispatches) {
    const dispatch = string(item.dispatchId);
    if (dispatch === undefined) continue;
    const current = getDispatch(database, dispatch);
    if (current.kind !== "ok" || current.value === undefined) continue;
    const meta = current.value as RecordValue;
    const finding = await inspectDispatch(root, database, dispatch, meta, environment, process, now);
    const screen = finding.cause === "unknown" ? await readDeliveryScreen(meta, process) : undefined;
    const running = screen?.kind === "ok" ? backgroundTasks(screen.value) : undefined;
    const previous = previousFinding(meta);
    const shouldNotify = shouldNotifyFinding(previous, finding, now);
    let recovery: string | undefined;
    if (finding.cause === "prompt-unsubmitted") {
      const screen = await readDeliveryScreen(meta, process);
      if (screen.kind === "ok") recovery = await recoverPrompt(meta, finding, screen.value, dispatch, process);
    }
    if (shouldNotify) {
      await notifyParent(root, database, dispatch, meta, finding, process, now, recovery);
      findings += 1;
    }
    mutateDispatch(database, dispatch, () => ({
      superviseLastCheck: new Date(now).toISOString(),
      ...(running === undefined ? {} : { backgroundTasks: running }),
      superviseFinding: finding.cause === "unknown"
        ? { cause: "unknown", lastSeenAt: new Date(now).toISOString() }
        : { ...finding, cause: finding.cause, lastSeenAt: new Date(now).toISOString(), notifiedAt: shouldNotify ? now : previous?.notifiedAt ?? now, ...(recovery === undefined ? {} : { autoRecoveryAttemptedAt: now, autoRecoveryResult: recovery }) },
    }));
  }
  return { open: true, findings };
}

export async function startSupervisorWorker(root: string, environment: Environment, process: ProcessAdapter): Promise<"started" | "already-running" | "no-open-dispatches" | "failed"> {
  const database = stateDatabase({ ...environment, MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return "failed";
  const listed = listDispatches(database.value);
  if (listed.kind !== "ok") return "failed";
  if (!hasOpenDispatches(listed.value.map((record) => String(record.state)))) return "no-open-dispatches";
  const holder = `${globalThis.process.pid}-${randomUUID()}`;
  const lease = acquireSupervisorLease(database.value, holder, leaseSeconds(intervalSeconds(environment)));
  if (lease.kind !== "ok") return "failed";
  if (!lease.value) return "already-running";
  const executable = globalThis.process.argv[1] ?? "megabrain";
  const started = await process.startDetached(executable, ["__supervise-worker", holder]);
  if (started.kind !== "ok") {
    releaseLease(database.value, LEASE_KEY, holder);
    return "failed";
  }
  return "started";
}

export async function executeSupervisorWorker(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const holder = args[0];
  if (holder === undefined || !/^\d+-[0-9a-f-]+$/i.test(holder)) return failed("supervisor worker requires its lease holder", 2);
  const root = resolveStateDirectory(environment);
  const database = stateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const delay = intervalSeconds(environment) * 1000;
  let running = true;
  const stop = (): void => { running = false; };
  globalThis.process.once("SIGTERM", stop);
  globalThis.process.once("SIGINT", stop);
  try {
    while (running) {
      const renewed = acquireSupervisorLease(database.value, holder, leaseSeconds(intervalSeconds(environment)));
      if (renewed.kind !== "ok" || !renewed.value) break;
      const status = await superviseOnce(root, database.value, environment, process);
      if (!status.open) break;
      for (let elapsed = 0; running && elapsed < delay; elapsed += 250) await new Promise((resolve) => setTimeout(resolve, Math.min(250, delay - elapsed)));
    }
  } finally {
    globalThis.process.off("SIGTERM", stop);
    globalThis.process.off("SIGINT", stop);
    releaseLease(database.value, LEASE_KEY, holder);
  }
  return ok("supervisor stopped\n");
}

function formatStatus(root: string, database: Parameters<typeof getDispatch>[0]): string {
  const lease = listLeases(database);
  const dispatches = listDispatches(database);
  if (lease.kind !== "ok" || dispatches.kind !== "ok") return "Supervisor status is unavailable.\n";
  const active = lease.value.find((item) => item.key === LEASE_KEY);
  const open = dispatches.value.filter((item) => ["spawning", "running", "waiting_for_reply", "orphaned"].includes(String(item.state)));
  const lines = [`state directory: ${root}`, `watcher: ${active === undefined ? "stopped" : `running (pid ${active.holder.split("-", 1)[0]})`}`];
  if (open.length === 0) lines.push("dispatches: none open");
  for (const item of open) {
    const meta = item as RecordValue;
    const finding = object(meta.superviseFinding);
    lines.push(`${String(item.dispatchId)} · last check ${string(meta.superviseLastCheck) ?? "not checked yet"} · finding ${string(finding?.cause) ?? "none"}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function executeSupervise(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("supervise"));
  const root = resolveStateDirectory(environment);
  const database = stateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  if (args.length === 1 && args[0] === "--status") return ok(formatStatus(root, database.value));
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
