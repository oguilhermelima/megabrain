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
import { readOnlyStateDatabase, getInstallState, listTmuxSessions, getTmuxSession, getTmuxSessionByStableId, listDispatches, createDispatch, getDispatch, listMessages, appendMessage as appendDatabaseMessage, acquireLease, releaseLease } from "../../adapters/state-db.js";
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
import { callStateOwner } from "../../db/state-owner.js";

import { type SpawnEnvironment, type SpawnOptions, type SpawnWorktree, type SpawnDependencies, type RecordValue, stringValue } from "./orchestrate-spawn-options.js";
import { defaultRemoveWorktree, describeHostCall, failureForCall } from "./orchestrate-spawn-worktree.js";
export function resultError(result: Result<unknown>, fallback: string): string {
  return result.kind === "ok" ? fallback : result.error;
}

export function hasReceipt(root: string, id: string): boolean {
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return false;
  const messages = listMessages(database.value, id);
  return messages.kind === "ok" && messages.value.some((message) => message.from === "child" && message.type === "received");
}

// A host terminal gives no proof of whether a turn started, so nothing is resent there. A receipt
// already in the queue settles it; otherwise the dispatch stays awaiting one.
export function settleHostReceipt(root: string, id: string): PromptTransportOutcome {
  return hasReceipt(root, id) ? { kind: "prompt-transport", status: "delivered" } : { kind: "prompt-transport", status: "awaiting-receipt" };
}

export async function updateMeta(root: string, id: string, update: RecordValue, process: ProcessAdapter): Promise<Result<void>> {
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return database;
  try {
    await callStateOwner(root, { operation: "dispatch-patch", dispatchId: id, patch: { ...update, updatedAt: new Date().toISOString() } });
  } catch (cause: unknown) {
    return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const updatedMeta = getDispatch(database.value, id);
  if (updatedMeta.kind === "ok" && updatedMeta.value?.runtime === "tmux" && typeof updatedMeta.value.tmuxPane === "string") {
    await setTmuxChatPane(updatedMeta.value.tmuxPane, String(updatedMeta.value.agent ?? "unknown"), String(updatedMeta.value.chatName ?? updatedMeta.value.branch ?? id), String(updatedMeta.value.state ?? "idle"), process);
  }
  return updatedMeta.kind === "ok" ? ok(undefined) : updatedMeta;
}

export async function coordinatorChatName(environment: SpawnEnvironment, process: ProcessAdapter): Promise<string> {
  const parentDispatchId = environment.MEGABRAIN_DISPATCH_ID;
  if (parentDispatchId !== undefined) {
    const database = readOnlyStateDatabase(environment);
    const parent = database.kind === "ok" ? getDispatch(database.value, parentDispatchId) : database;
    if (parent.kind === "ok" && typeof parent.value?.chatName === "string" && parent.value.chatName !== "") return parent.value.chatName;
  }
  const [repository, branch] = await Promise.all([
    process.run("git", ["rev-parse", "--show-toplevel"]),
    process.run("git", ["branch", "--show-current"]),
  ]);
  const repoName = repository.kind === "ok" ? basename(repository.value.stdout.trim()) : "";
  const branchName = branch.kind === "ok" ? branch.value.stdout.trim() : "";
  return repoName !== "" && branchName !== "" ? `${repoName}/${branchName}` : "megabrain/main";
}

export async function markRunningIfSpawning(root: string, id: string, processAdapter: ProcessAdapter = createProcessAdapter()): Promise<Result<void>> {
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return database;
  const result = getDispatch(database.value, id);
  if (result.kind !== "ok") return result;
  const meta = result.value;
  if (meta === undefined) return failed(`dispatch not found: ${id}`);
  const state = stringValue(meta.state);
  const transition = checkDispatchTransition("dispatch", state, "running");
  if (transition.kind === "unknown") return transition;
  if (state !== "spawning") return ok(undefined);
  if (transition.kind === "failed") return transition;
  return updateMeta(root, id, { state: "running" }, processAdapter);
}

export async function initialMeta(id: string, options: SpawnOptions, worktree: SpawnWorktree, parentContext: CallerIdentity, parentWorkspace: string | null, parentTmux: Readonly<{ tmuxSession: string | null; tmuxPane: string | null }>, runtime: SpawnRuntime, terminalId: string, session: string | null, sessionId: string | null, pane: string | null, parentChatName: string, parentAgentThreadId?: string, parentAgent?: string, parentAgentSessionId?: string, parentAgentPid?: number): Promise<RecordValue> {
  const now = new Date().toISOString();
  return {
    dispatchId: id,
    // The stable owner of this dispatch (D): a caller's own agent-session id when one is
    // available, otherwise its terminal handle. parentTerminalId is recorded separately so a
    // caller whose agent session later changes can still be recognised by the terminal it ran in
    // (see core/context.js ownsDispatch).
    parentSessionId: parentContext.id,
    ...(parentAgentThreadId === undefined ? {} : { parentAgentThreadId }),
    ...(parentAgent === undefined ? {} : { parentAgent }),
    ...(parentAgentSessionId === undefined ? {} : { parentAgentSessionId }),
    ...(parentAgentPid === undefined ? {} : { parentAgentPid }),
    parentHost: parentContext.host,
    parentTerminalId: parentContext.terminalId,
    parentWorkspaceId: parentWorkspace,
    parentTmuxSession: parentTmux.tmuxSession,
    parentTmuxPane: parentTmux.tmuxPane,
    // A tmux dispatch's childHost names its own runtime ("tmux"), not the caller's host — see the
    // WHY comment on terminalId's assignment in executeSpawn's tmux branch above.
    childHost: runtime === "tmux" ? "tmux" : parentContext.host,
    workspaceId: worktree.workspaceId,
    terminalId,
    worktreePath: worktree.path,
    branch: worktree.branch,
    chatName: options.label ?? worktree.branch,
    parentChatName,
    agent: options.agent,
    agentId: options.agent,
    model: options.model ?? "",
    effort: options.effort,
    modelHonored: true,
    modelSubstitution: null,
    runtime,
    spawnRuntime: runtime === "tmux" ? "tmux" : "ide",
    tmuxSession: session,
    tmuxSessionId: sessionId,
    tmuxPane: pane,
    label: options.label ?? worktree.branch,
    chain: null,
    ...(options.contextPolicy === undefined ? {} : {
      contextPolicy: options.contextPolicy,
      contextPolicyState: { ceilingLatched: false, compactLatched: false, loopIterations: 0, actions: [] },
      ...(options.contextPolicy.loop === true || hasCompactThreshold(options.contextPolicy) ? { contextLoopPrompt: options.prompt } : {}),
    }),
    state: "spawning",
    promptDelivered: false,
    promptDelivery: "pending",
    promptDeliveryReason: null,
    promptPublication: "pending",
    promptTransport: "pending",
    promptReceipt: "pending",
    promptState: "awaiting-publication",
    processState: "starting",
    terminalState: "owned",
    terminalReason: null,
    stage: null,
    reason: null,
    reconcileOutcome: null,
    createdAt: now,
    updatedAt: now,
  };
}

// A session that was killed must not stay in the registry, or lists show it as live.
export async function forgetTmuxSession(root: string, session: string): Promise<Result<void>> {
  try {
    await callStateOwner(root, { operation: "tmux-session-write", action: "remove", session });
    return ok(undefined);
  } catch (cause: unknown) {
    return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export async function cleanup(root: string, id: string, worktree: SpawnWorktree, plan: SpawnPlan, process: ProcessAdapter, dependencies: SpawnDependencies, terminalId: string, session: string | null, pane: string | null, sessionOwned: boolean): Promise<readonly string[]> {
  if (plan.cleanup.kind !== "required") return [];
  const failures: string[] = [];
  if (plan.cleanup.runtime === "tmux" && session !== null) {
    const call = sessionOwned ? `tmux kill-session --target ${session}` : `tmux kill-pane --target ${pane ?? ""}`;
    const result = sessionOwned ? await getTmux().killSession(session, process) : pane === null ? undefined : await getTmux().killPane(pane, process);
    if (result !== undefined && result.kind !== "ok") failures.push(`${call}: ${result.error}`);
    if (sessionOwned && result?.kind === "ok") {
      const forgotten = await forgetTmuxSession(root, session);
      if (forgotten.kind !== "ok") failures.push(forgotten.error);
    }
  }
  if (plan.cleanup.runtime === "host") {
    const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
    const stored = database.kind === "ok" ? getDispatch(database.value, id) : database;
    const meta = stored.kind === "ok" ? stored.value : undefined;
    const provider = getHost(stringValue(meta?.childHost));
    const workspaceId = stringValue(meta?.workspaceId) || null;
    if (provider !== undefined && terminalId !== "") {
      const call = provider.close({ workspaceId, terminalId });
      if (call.kind === "ok") {
        const result = await process.run(call.value.command, call.value.args);
        if (result.kind !== "ok") failures.push(`${describeHostCall(call.value)}: ${result.error}`);
      } else {
        failures.push(`${provider.id} terminal close --terminal ${terminalId}: ${call.error}`);
      }
    }
  }
  if (plan.cleanup.worktree === "remove") {
    const result = await (dependencies.removeWorktree ?? defaultRemoveWorktree)(worktree.path, process);
    if (result.kind !== "ok") failures.push(`git worktree remove --force ${worktree.path}: ${result.error}`);
  }
  return failures;
}

export function failureResult(plan: SpawnPlan, detail?: string, cleanupFailures: readonly string[] = []): Result<string> {
  const primary = plan.failure === null ? detail : `${plan.failure.call}: ${plan.failure.detail}`;
  const message = [plan.reason ?? "spawn failed", primary].filter((part): part is string => part !== undefined).join(": ");
  const cleanup = cleanupFailures.map((failure) => `cleanup failed: ${failure}`).join("; ");
  return failed(cleanup === "" ? message : `${message}; ${cleanup}`, plan.exitCode);
}

// What a failed spawn knows about itself, so --json can describe it however far it got.
export type SpawnTrace = {
  json?: boolean;
  dispatchId?: string;
  terminalId?: string;
  pane?: string;
  reason?: string;
  tmuxSession?: string;
  sessionCreatedBySpawn?: boolean;
  sessionCleanupAttempted?: boolean;
  promptFile?: string;
};

