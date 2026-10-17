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
import { stateDatabase, getInstallState, listTmuxSessions, getTmuxSession, getTmuxSessionByStableId, deleteTmuxSession, putTmuxSession, listDispatches, createDispatch, getDispatch, mutateDispatch, listMessages, appendMessage as appendDatabaseMessage, acquireLease, releaseLease } from "../../adapters/state-db.js";
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

import { resultError } from "./orchestrate-spawn-state.js";
import { runSpawn } from "./orchestrate-spawn-run.js";
import { forgetTmuxSession, type SpawnTrace } from "./orchestrate-spawn-state.js";
import { type SpawnEnvironment, type SpawnDependencies } from "./orchestrate-spawn-options.js";
export async function executeSpawn(args: readonly string[], environment: SpawnEnvironment, process: ProcessAdapter, dependencies: SpawnDependencies = {}): Promise<Result<string>> {
  const trace: SpawnTrace = {};
  if (args.includes("-h") || args.includes("--help")) {
    return runSpawn(args, environment, process, dependencies, trace);
  }
  const policy = environment.MEGABRAIN_STATE_DIR === undefined && environment.HOME === undefined
    ? undefined : await readAdmissionPolicy(environment);
  const database = policy === undefined ? undefined : stateDatabase(environment);
  if (database?.kind === "failed") return failed(database.error, database.exitCode);
  const holder = `admission-${globalThis.process.pid}-${randomUUID()}`;
  let leased = false;
  if (database?.kind === "ok") {
    for (let attempt = 0; attempt < 300 && !leased; attempt += 1) {
      const acquired = acquireLease(database.value, "resource-admission", holder, 300);
      if (acquired.kind !== "ok") return acquired;
      leased = acquired.value;
      if (!leased) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!leased) return failed("resource admission is busy; retry the spawn", 1);
  }
  let result: Result<string>;
  try { result = await runSpawn(args, environment, process, dependencies, trace); }
  finally {
    if (leased && database?.kind === "ok") releaseLease(database.value, "resource-admission", holder);
    // The pane's shell read the brief when it launched the agent, and a failed spawn never will.
    if (trace.promptFile !== undefined) await rm(trace.promptFile, { force: true });
  }
  if (result.kind !== "ok" && trace.sessionCreatedBySpawn && !trace.sessionCleanupAttempted && trace.tmuxSession !== undefined) {
    const cleanup = await getTmux().killSession(trace.tmuxSession, process);
    trace.sessionCleanupAttempted = true;
    if (cleanup.kind === "ok") forgetTmuxSession(resolveStateDirectory(environment), trace.tmuxSession);
    if (cleanup.kind !== "ok") {
      const primary = result.kind === "failed" ? result.error : result.reason;
      result = failed(`${primary}; cleanup failed: tmux kill-session --target ${trace.tmuxSession}: ${resultError(cleanup, "could not kill tmux session")}`, result.kind === "failed" ? result.exitCode : undefined);
    }
  }
  // An argument error leaves trace.json unset: the flag is then read straight from the arguments.
  if (result.kind === "ok" || !(trace.json ?? args.includes("--json"))) return result;
  const error = result.kind === "failed" ? result.error : result.reason;
  const body = {
    status: "failed",
    reason: trace.reason ?? "spawn-failed",
    error,
    ...(trace.dispatchId === undefined ? {} : { dispatchId: trace.dispatchId }),
    ...(trace.terminalId === undefined ? {} : { terminalId: trace.terminalId }),
    ...(trace.pane === undefined ? {} : { tmuxPane: trace.pane }),
  };
  return failed(error, result.exitCode, `${JSON.stringify(body)}\n`);
}

