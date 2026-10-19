import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { getAgent } from "../../agents/index.js";
import { decideSpawnStep, resolveAutoSpawnRuntime, type SpawnDecisionInput, type SpawnFailure, type SpawnPlan, type SpawnRuntime, type SpawnState, type SpawnStep, type WorktreeOwnership } from "../../core/spawn-plan.js";
import { checkDispatchTransition } from "../../core/dispatch-states.js";
import { classifyLiveness, waitForStableIdle } from "../../core/liveness.js";
import { failed, ok, unknown, type Result } from "../../core/result.js";
import type { DatabaseHandle } from "../../db/db.js";
import { resolveStateDirectory } from "../../core/state.js";
import { CALLER_IDENTITY_ENV_VARS, type CallerIdentity } from "../../core/context.js";
import { appendMessage, resolveCaller, type QueueEnvironment } from "./queue-write.js";
import { repoFromOrca } from "./repository-selector.js";
import { executeWorktreeCreate } from "./worktree-write.js";
import { getHost, runHostSend, type HostCommand, type HostProvider } from "../../hosts/index.js";
import { createTmuxSession, dispatchTmuxProcess, getTmux, onAppTmuxServer, sendTmuxPair, splitTmuxWorktreePane, verifyTmuxPane, waitForTmuxSession } from "../../hosts/tmux.js";
import { decideTmuxPlacement, tmuxWorktreeSessionName } from "../../core/tmux-placement.js";
import { usageText } from "../../core/usage.js";
import { PROMPT_BUDGET_TMUX_BYTES, promptByteLength } from "../../core/prompt-budget.js";
import { readOnlyStateDatabase, getInstallState, listTmuxSessions, getTmuxSession, getTmuxSessionByStableId, listDispatches, createDispatch, getDispatch, mutateDispatch, listMessages, appendMessage as appendDatabaseMessage } from "../../adapters/state-db.js";
import { callStateOwner } from "../../db/state-owner.js";
import { resolveAgentDescriptor } from "../../agents/index.js";
import { findClaudeSessionPid } from "../../agents/claude-session.js";
import { grokLeaderSocket } from "../../agents/grok-leader.js";
import { agyParentKey, recordAgyLanguageServer } from "../../agents/agy-ls.js";
import { setTmuxChatPane } from "../../core/chat-pane.js";
import { hasCompactThreshold, parseContextThreshold, thresholdFields, validateContextPolicy, type ContextPolicy } from "../../core/context-policy.js";
import { argvBriefStarted, awaitArgvPrompt, transportTmuxPrompt, type PromptTransportOutcome } from "./spawn-prompt.js";
import { startSupervisorWorker } from "./supervise.js";
import { notifyAdmissionStatus } from "./admission-notify.js";
import { checkTerminalFlag, openViewer, viewerLine } from "./terminal-open.js";
import { resolveGrokSessionId } from "../../core/context-meter.js";
import { join } from "node:path";
import { decideAdmission, DEFAULT_AGENT_COST_BYTES } from "../../core/admission.js";
import { readAdmissionPolicy, estimateTypicalRssByAgent } from "../../adapters/state-db.js";
import { readMachineResources } from "../../core/resources.js";
import { registerMegabrainRepository } from "../../core/project-registry.js";

import { type SpawnEnvironment, type SpawnOptions, type SpawnWorktree, type RecordValue, stringValue, shellQuote, TERMINAL_CREATE_MAX_ATTEMPTS, TERMINAL_CREATE_DEADLINE_MS, TERMINAL_CREATE_BACKOFF_MS, TERMINAL_CREATE_TIMEOUT_MS } from "./orchestrate-spawn-options.js";
import { resultError } from "./orchestrate-spawn-state.js";
async function runGit(process: ProcessAdapter, args: readonly string[]): Promise<Result<string>> {
  const result = await process.run("git", args);
  return result.kind === "ok" ? ok(result.value.stdout.trim()) : failed(result.kind === "failed" ? result.error : result.reason, result.exitCode);
}

function existingWorktreeError(options: SpawnOptions): string | undefined {
  const flags = [options.base === undefined ? undefined : "--base", options.name === undefined ? undefined : "--name"].filter((flag): flag is string => flag !== undefined);
  return flags.length === 0 ? undefined : `worktree already exists; ${flags.join(" and ")} cannot be applied`;
}

export async function defaultResolveWorktree(target: string | undefined, options: SpawnOptions, environment: SpawnEnvironment, process: ProcessAdapter): Promise<Result<SpawnWorktree>> {
  const direct = target === undefined ? undefined : await realpath(target).catch(() => undefined);
  if (direct !== undefined) {
    const top = await runGit(process, ["-C", direct, "rev-parse", "--show-toplevel"]);
    if (top.kind !== "ok") return failed(`worktree path is not a Git directory: ${target}`);
    const existingError = existingWorktreeError(options);
    if (existingError !== undefined) return failed(existingError);
    const branch = await runGit(process, ["-C", direct, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    return ok({ path: direct, branch: branch.kind === "ok" && branch.value !== "" ? branch.value : "detached", ownership: "existing", workspaceId: environment.MEGABRAIN_WORKSPACE_ID ?? environment.SUPERSET_WORKSPACE_ID ?? null });
  }
  if (options.repo === undefined) return failed("--repo is required to resolve a worktree by name");
  const repository = await repoFromOrca(process, options.repo, environment);
  if (repository.kind !== "ok") return repository;
  const listed = await runGit(process, ["-C", repository.value, "worktree", "list", "--porcelain"]);
  if (listed.kind === "ok") {
    let path = "";
    for (const line of listed.value.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      const listedBranch = line.startsWith("branch refs/heads/") ? line.slice(18) : undefined;
      const matches = target === undefined
        ? listedBranch === options.branch
        : listedBranch === target || (line.startsWith("worktree ") && basename(path) === target);
      if (matches) {
        const existingError = existingWorktreeError(options);
        if (existingError !== undefined) return failed(existingError);
        return ok({ path, branch: listedBranch ?? target ?? "detached", ownership: "existing", workspaceId: environment.MEGABRAIN_WORKSPACE_ID ?? environment.SUPERSET_WORKSPACE_ID ?? null });
      }
    }
  }
  if (options.repo === undefined || options.branch === undefined) return failed(`worktree not found: ${target}`);
  const createArgs = ["--repo", options.repo, "--branch", options.branch, "--json"];
  if (options.base !== undefined) createArgs.push("--base", options.base);
  if (options.name !== undefined) createArgs.push("--name", options.name);
  const created = await executeWorktreeCreate(createArgs, environment, process);
  if (created.kind !== "ok") return created;
  try {
    const value = JSON.parse(created.value) as RecordValue;
    const path = stringValue(value.worktree);
    const branch = stringValue(value.branch);
    if (path === "" || branch === "") return failed("worktree creation returned no path or branch");
    return ok({ path, branch, ownership: "created", workspaceId: environment.MEGABRAIN_WORKSPACE_ID ?? environment.SUPERSET_WORKSPACE_ID ?? null });
  } catch {
    return failed("worktree creation returned invalid JSON");
  }
}

export async function defaultRemoveWorktree(path: string, process: ProcessAdapter): Promise<Result<void>> {
  const result = await process.run("git", ["worktree", "remove", "--force", path]);
  return result.kind === "ok" ? ok(undefined) : failed(result.kind === "failed" ? result.error : result.reason, result.exitCode);
}

export function describeHostCall(call: HostCommand): string {
  const text = call.args.indexOf("--text");
  const json = call.args.indexOf("--json");
  const end = text === -1 ? json : json === -1 ? text : Math.min(text, json);
  const args = end === -1 ? call.args : call.args.slice(0, end);
  return [call.command, ...args].join(" ");
}

export function failureForCall(call: HostCommand | undefined, result: Result<unknown>, fallbackCall: string): SpawnFailure {
  return {
    call: call === undefined ? fallbackCall : describeHostCall(call),
    detail: result.kind === "ok" ? "call failed" : result.error,
  };
}

type HostTerminalCreation = Readonly<{
  readonly terminalId: string;
  readonly attempts: number;
}>;

function terminalCreateFailure(call: HostCommand, response: Result<unknown>, attempts: number, elapsedMs: number): Result<HostTerminalCreation> {
  const failure = failureForCall(call, response, "terminal create");
  return failed(`${failure.call}: ${failure.detail} after ${attempts} attempts in ${elapsedMs}ms`, response.kind === "ok" ? 1 : response.exitCode);
}

export async function createHostTerminal(host: Pick<HostProvider, "terminalIdentity">, call: HostCommand, process: ProcessAdapter): Promise<Result<HostTerminalCreation>> {
  const started = Date.now();
  for (let attempts = 1; attempts <= TERMINAL_CREATE_MAX_ATTEMPTS; attempts += 1) {
    const response = await process.run(call.command, call.args, { timeoutMs: TERMINAL_CREATE_TIMEOUT_MS });
    if (response.kind === "ok") {
      const terminalId = host.terminalIdentity(JSON.parse(response.value.stdout || "{}")) ?? "";
      if (terminalId === "") return failed("terminal create returned no terminal identity");
      return ok({ terminalId, attempts });
    }
    const elapsed = Date.now() - started;
    if (attempts === TERMINAL_CREATE_MAX_ATTEMPTS || elapsed >= TERMINAL_CREATE_DEADLINE_MS) return terminalCreateFailure(call, response, attempts, elapsed);
    const waitMs = Math.min(TERMINAL_CREATE_BACKOFF_MS, TERMINAL_CREATE_DEADLINE_MS - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const retryElapsed = Date.now() - started;
    if (retryElapsed >= TERMINAL_CREATE_DEADLINE_MS) return terminalCreateFailure(call, response, attempts, retryElapsed);
  }
  return failed("terminal create retry deadline expired");
}

type TmuxWorktreeSession = Readonly<{
  readonly session: string;
  readonly record: RecordValue;
}>;

export async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

async function stableTmuxSessionId(session: string, process: ProcessAdapter): Promise<string | null> {
  const result = await process.run("tmux", ["display-message", "-p", "-t", session, "#{session_id}"]);
  const id = result.kind === "ok" ? result.value.stdout.trim() : "";
  return /^\$\d+$/.test(id) ? id : null;
}

export async function removeStaleStableSession(root: string, handle: DatabaseHandle, session: string, stableSessionId: string, process: ProcessAdapter): Promise<Result<void>> {
  const indexed = getTmuxSessionByStableId(handle, stableSessionId);
  if (indexed.kind !== "ok") return indexed;
  const priorSession = stringValue(indexed.value?.tmuxSession);
  if (priorSession === "" || priorSession === session) return ok(undefined);

  const live = await process.run("tmux", ["display-message", "-p", "-t", priorSession, "#{session_id}"]);
  if (live.kind === "ok" && live.value.stdout.trim() === stableSessionId) return ok(undefined);
  if (live.kind !== "ok" && !/can't find session|session not found|no such session/i.test(live.error)) return ok(undefined);

  try {
    await callStateOwner(root, { operation: "tmux-session-write", action: "remove", session: priorSession });
    return ok(undefined);
  } catch (cause: unknown) {
    return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export async function existingTmuxSessionForWorktree(root: string, worktreePath: string, process: ProcessAdapter): Promise<TmuxWorktreeSession | undefined> {
  const target = await canonicalPath(worktreePath);
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return undefined;
  const sessions = listTmuxSessions(database.value);
  if (sessions.kind !== "ok") return undefined;
  for (const record of sessions.value) {
    const session = stringValue(record?.tmuxSession);
    const directory = stringValue(record?.workingDirectory);
    if (session === "" || directory === "" || await canonicalPath(directory) !== target) continue;
    if ((await getTmux().sessionExists(session, process)).kind !== "ok") continue;
    const panes = await getTmux().panesForSession(session, process);
    const recordedPane = stringValue(record?.tmuxPane);
    if (panes.kind !== "ok" || panes.value.length === 0 || (recordedPane !== "" && !panes.value.includes(recordedPane))) continue;
    return { session, record: record ?? {} };
  }
  const dispatches = listDispatches(database.value);
  if (dispatches.kind !== "ok") return undefined;
  for (const meta of dispatches.value) {
    const state = stringValue(meta?.state);
    const session = stringValue(meta?.tmuxSession);
    const pane = stringValue(meta?.tmuxPane);
    if (stringValue(meta?.runtime) !== "tmux" || ["failed", "orphaned", "closed"].includes(state) || session === "" || pane === "") continue;
    const directory = stringValue(meta?.worktreePath);
    if (directory === "" || await canonicalPath(directory) !== target) continue;
    if ((await getTmux().sessionExists(session, process)).kind !== "ok") continue;
    const panes = await getTmux().panesForSession(session, process);
    if (panes.kind !== "ok" || !panes.value.includes(pane)) continue;
    const record = getTmuxSession(database.value, session);
    return { session, record: { ...meta, ...(record.kind === "ok" ? record.value ?? {} : {}) } };
  }
  return undefined;
}

async function acquireWorktreeSessionLock(root: string, worktreePath: string): Promise<Result<() => Promise<void>>> {
  const key = createHash("sha256").update(worktreePath).digest("hex");
  const lock = `tmux-sessions/${key}`;
  const holder = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 10000;
  while (true) {
    let acquired: unknown;
    try { acquired = await callStateOwner(root, { operation: "acquire-lease", key: lock, holder, seconds: 120 }); }
    catch (cause: unknown) { return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
    if (acquired === true) return ok(async () => { await callStateOwner(root, { operation: "release-lease", key: lock, holder }); });
    if (Date.now() >= deadline) return failed(`timed out waiting for tmux session lock for ${worktreePath}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function attachHostToWorktreeSession(
  root: string,
  session: string,
  record: RecordValue,
  worktree: SpawnWorktree,
  parentContext: CallerIdentity,
  parentWorkspace: string | null,
  options: SpawnOptions,
  process: ProcessAdapter,
): Promise<Result<Readonly<{ terminalId: string | null; host: string | null; warning: string | null }>>> {
  let terminalId = stringValue(record.hostTerminalId) || stringValue(record.tmuxHostTerminalId) || null;
  let host = stringValue(record.hostTerminalHost) || stringValue(record.tmuxHostTerminalHost) || null;
  let warning: string | null = null;
  if ((parentContext.host === "orca" || parentContext.host === "superset") && terminalId === null) {
    const provider = getHost(parentContext.host);
    if (provider === undefined) warning = `tmux attach terminal was not opened: ${parentContext.host} host is unavailable`;
    else {
      const command = `tmux attach -t ${shellQuote(session)}`;
      const call = provider.create({ workspaceId: worktree.workspaceId ?? parentWorkspace, worktreePath: worktree.path, title: `${options.agent} ${worktree.path}`, command });
      if (call.kind !== "ok") warning = `tmux attach terminal was not opened: ${call.kind === "failed" ? call.error : call.reason}`;
      else {
        const created = await createHostTerminal(provider, call.value, process);
        if (created.kind !== "ok") warning = `tmux attach terminal was not opened: ${created.error}`;
        else {
          terminalId = created.value.terminalId;
          host = parentContext.host;
        }
      }
    }
  }
  // The caller persists this record after it has removed any stale stable-session mapping.
  return ok({ terminalId, host, warning });
}

type TmuxTarget = Readonly<{
  readonly session: string;
  readonly pane: string;
  readonly sessionOwned: boolean;
  readonly sessionCreated: boolean;
  readonly hostTerminalId: string | null;
  readonly hostTerminalHost: string | null;
  readonly warning: string | null;
}>;

export async function openWorktreeTmuxTarget(
  root: string,
  worktree: SpawnWorktree,
  parentContext: CallerIdentity,
  parentWorkspace: string | null,
  options: SpawnOptions,
  process: ProcessAdapter,
): Promise<Result<TmuxTarget>> {
  const acquired = await acquireWorktreeSessionLock(root, await canonicalPath(worktree.path));
  if (acquired.kind !== "ok") return acquired;
  try {
    const existing = await existingTmuxSessionForWorktree(root, worktree.path, process);
    if (existing !== undefined) {
      const split = await splitTmuxWorktreePane(existing.session, worktree.path, process);
      if (split.kind !== "ok") return split;
      const attached = await attachHostToWorktreeSession(root, existing.session, existing.record, worktree, parentContext, parentWorkspace, options, process);
      if (attached.kind !== "ok") return attached;
      return ok({
        session: existing.session,
        pane: split.value,
        sessionOwned: existing.record.megabrainOwned === true || existing.record.tmuxSessionOwned === true || existing.session === `megabrain-${stringValue(existing.record.dispatchId)}`,
        sessionCreated: false,
        hostTerminalId: attached.value.terminalId,
        hostTerminalHost: attached.value.host,
        warning: attached.value.warning,
      });
    }

    const session = tmuxWorktreeSessionName(await canonicalPath(worktree.path));
    const created = await createTmuxSession(session, worktree.path, undefined, process, false);
    if (created.kind !== "ok") return created;
    const waited = await waitForTmuxSession(session, process);
    if (waited.kind !== "ok") {
      const killed = await getTmux().killSession(session, process);
      return killed.kind === "ok" ? waited : failed(`${resultError(waited, "tmux session did not become ready")}; cleanup failed: tmux kill-session --target ${session}: ${resultError(killed, "could not kill tmux session")}`);
    }
    const panes = await getTmux().panesForSession(session, process);
    if (panes.kind !== "ok" || panes.value[0] === undefined) {
      const failure = panes.kind === "ok" ? failed(`tmux session ${session} has no pane`) : panes;
      const killed = await getTmux().killSession(session, process);
      return killed.kind === "ok" ? failure : failed(`${resultError(failure, `tmux session ${session} has no pane`)}; cleanup failed: tmux kill-session --target ${session}: ${resultError(killed, "could not kill tmux session")}`);
    }

    const record: RecordValue = {
      tmuxSession: session,
      workingDirectory: await canonicalPath(worktree.path),
      megabrainOwned: true,
      createdAt: new Date().toISOString(),
      stableSessionId: await stableTmuxSessionId(session, process),
    };
    const attached = await attachHostToWorktreeSession(root, session, record, worktree, parentContext, parentWorkspace, options, process);
    if (attached.kind !== "ok") return attached;
    return ok({ session, pane: panes.value[0], sessionOwned: true, sessionCreated: true, hostTerminalId: attached.value.terminalId, hostTerminalHost: attached.value.host, warning: attached.value.warning });
  } finally {
    await acquired.value();
  }
}

