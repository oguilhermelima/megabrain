import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { getAgent } from "../../agents/index.js";
import { decideSpawnStep, resolveAutoSpawnRuntime, type SpawnDecisionInput, type SpawnFailure, type SpawnPlan, type SpawnRuntime, type SpawnState, type SpawnStep, type WorktreeOwnership } from "../../core/spawn-plan.js";
import { checkDispatchTransition } from "../../core/dispatch-states.js";
import { classifyLiveness, startupDialogCause, waitForStableIdle } from "../../core/liveness.js";
import { failed, ok, unknown, type Result } from "../../core/result.js";
import type { DatabaseHandle } from "../../db/db.js";
import { callStateOwner } from "../../db/state-owner.js";
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
import { getInstallState, listTmuxSessions, getTmuxSession, getTmuxSessionByStableId, deleteTmuxSession, putTmuxSession, listDispatches, createDispatch, getDispatch, mutateDispatch, listMessages, acquireLease, releaseLease } from "../../adapters/state-db.js";
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

export async function waitForTmuxReadiness(agentId: string, pane: string, timeoutMs: number, process: ProcessAdapter, argvBrief: boolean): Promise<Readonly<{ result: Result<void>; lastFrame: string; trustAnswered: boolean }>> {
  let lastFrame = "";
  let trustAnswered = false;
  const result = await waitForStableIdle(
    agentId,
    timeoutMs,
    async () => {
      const captured = await getTmux().capturePane(pane, 200, process);
      lastFrame = captured.kind === "ok" ? captured.value : `pane capture failed: ${captured.error}`;
      return captured;
    },
    `tmux pane ${pane} did not become ready within ${timeoutMs}ms`,
    () => {
      return getTmux().sendKey(pane, getAgent(agentId)?.firstRunDialogKey ?? "Enter", process).then((answer) => {
        if (agentId === "grok" && answer.kind === "ok") trustAnswered = true;
        return answer;
      });
    },
    // An agent launched with its brief may be working on it before its composer ever idles.
    argvBrief ? (frame) => argvBriefStarted(agentId, frame) : undefined,
  );
  return { result, lastFrame, trustAnswered };
}

export const READINESS_FRAME_MAX_LINES = 60;

export async function recordFrame(root: string, id: string, type: string, text: string): Promise<void> {
  await callStateOwner(root, { operation: "append-message", dispatchId: id, message: { from: "megabrain", type, text, createdAt: new Date().toISOString(), sessionId: "" } });
}

// The frame readiness rejected is the only evidence of why a spawn that retries fine failed once,
// so it is kept in the dispatch's own messages rather than lost with the pane.
export async function recordRejectedReadinessFrame(root: string, id: string, agent: string, timeoutMs: number, frame: string): Promise<void> {
  const shown = frame.split("\n").slice(-READINESS_FRAME_MAX_LINES).join("\n").trimEnd();
  const status = startupDialogCause(agent, frame) ?? classifyLiveness(agent, frame).status;
  await recordFrame(root, id, "readiness-frame", `readiness never saw a stable idle ${agent} frame within ${timeoutMs}ms (last classified: ${status}); last frame:\n${shown}`);
}

