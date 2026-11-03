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
import { createTmuxLauncher, createTmuxSession, dispatchTmuxProcess, getTmux, onAppTmuxServer, respawnTmuxPane, sendTmuxPair, splitTmuxWorktreePane, verifyTmuxPane, waitForTmuxSession } from "../../hosts/tmux.js";
import { decideTmuxPlacement, tmuxWorktreeSessionName } from "../../core/tmux-placement.js";
import { usageText } from "../../core/usage.js";
import { PROMPT_BUDGET_TMUX_BYTES, promptByteLength } from "../../core/prompt-budget.js";
import { stateDatabase, readOnlyStateDatabase, getInstallState, listTmuxSessions, getTmuxSession, getTmuxSessionByStableId, deleteTmuxSession, putTmuxSession, listDispatches, getDispatch, listMessages, appendMessage as appendDatabaseMessage, acquireLease, releaseLease } from "../../adapters/state-db.js";
import { callStateOwner } from "../../db/state-owner.js";
import { recordChannelResultThroughOwner } from "../../db/state-owner.js";
import { sendSessionMessage } from "../../core/session-send.js";
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
import { preflightWorktreeTrust } from "../../agents/worktree-trust.js";
import { join } from "node:path";
import { decideAdmission, DEFAULT_AGENT_COST_BYTES } from "../../core/admission.js";
import { readAdmissionPolicy, estimateTypicalRssByAgent } from "../../adapters/state-db.js";
import { readMachineResources } from "../../core/resources.js";
import { registerMegabrainRepository } from "../../core/project-registry.js";
import { scheduleAgentAutoUpdate } from "../../core/agent-update.js";

import { stringValue, clearCallerIdentityEnv } from "./orchestrate-spawn-options.js";
import { failureForCall } from "./orchestrate-spawn-worktree.js";
import { READINESS_FRAME_MAX_LINES } from "./orchestrate-spawn-readiness.js";
import { type SpawnEnvironment, type SpawnDependencies, type SpawnOptions, type RecordValue, SPAWN_ENVIRONMENT_HELP, parseArgs, dispatchId, tmuxRuntimeInstalled, parentWorkspaceId, parentTmuxChannel, shellQuote, agyLogFile, finalPrompt, validatePromptBudget, writePromptFile, agentReadyTimeoutMs } from "./orchestrate-spawn-options.js";
import { waitForTmuxReadiness, recordFrame, recordRejectedReadinessFrame } from "./orchestrate-spawn-readiness.js";
import { defaultResolveWorktree, defaultRemoveWorktree, createHostTerminal, existingTmuxSessionForWorktree, openWorktreeTmuxTarget, removeStaleStableSession, canonicalPath } from "./orchestrate-spawn-worktree.js";
import { resultError, hasReceipt, settleHostReceipt, updateMeta, coordinatorChatName, markRunningIfSpawning, initialMeta, cleanup, failureResult, type SpawnTrace } from "./orchestrate-spawn-state.js";

export async function runSpawn(args: readonly string[], rawEnvironment: SpawnEnvironment, rawProcess: ProcessAdapter, dependencies: SpawnDependencies, trace: SpawnTrace): Promise<Result<string>> {
  // A coordinator inside an app terminal must not split its pane or share its server with workers:
  // drop its tmux identity and address the dispatch server on every call.
  const fromApp = onAppTmuxServer(rawEnvironment);
  const { TMUX: _tmux, TMUX_PANE: _tmuxPane, ...withoutTmux } = rawEnvironment;
  const environment: SpawnEnvironment = fromApp ? withoutTmux : rawEnvironment;
  const process = fromApp ? dispatchTmuxProcess(rawProcess) : rawProcess;
  if (args.includes("-h") || args.includes("--help")) return ok(`${usageText("orchestrate-spawn")}${SPAWN_ENVIRONMENT_HELP}`);
  const parsed = parseArgs(args);
  if (parsed.kind !== "ok") return parsed;
  const options = parsed.value;
  trace.json = options.json;
  const agent = getAgent(options.agent);
  if (agent === undefined) return unknown(`agent cannot be determined: ${options.agent}`);
  void scheduleAgentAutoUpdate(options.agent as "codex" | "claude" | "grok" | "agy", environment, process, dependencies.agentUpdates).catch(() => undefined);
  if (options.contextPolicy !== undefined) {
    if (hasCompactThreshold(options.contextPolicy) && agent.compactCommand === undefined) return failed(`${options.agent} has no measured context compact command`);
    if (agent.contextSource === undefined) return failed(`${options.agent} has no measured context meter`);
  }
  const agentCommand = agent.commandLine?.({
    model: options.model,
    effort: options.effort,
    browser: options.browser,
    agentArgs: options.agentArgs,
  });
  if (agentCommand === undefined) return unknown(`agent cannot build a command line: ${options.agent}`);
  if (agentCommand.kind !== "ok") return agentCommand;
  // An explicit --tmux always wins; omitted, this follows the shell's auto default exactly (see
  // resolveAutoSpawnRuntime and tmuxRuntimeInstalled) instead of reading MEGABRAIN_SPAWN_RUNTIME,
  // an environment variable nothing in this codebase ever sets.
  const selectedRuntime: SpawnRuntime = options.tmux === null ? resolveAutoSpawnRuntime(await tmuxRuntimeInstalled(environment)) : options.tmux ? "tmux" : "host";
  const id = dispatchId(environment);
  let prompt = finalPrompt(options, id);
  const initialBudget = validatePromptBudget(prompt, selectedRuntime);
  if (initialBudget.kind !== "ok") return initialBudget;
  const worktreeResult = await (dependencies.resolveWorktree ?? defaultResolveWorktree)(options.worktree, options, environment, process);
  if (worktreeResult.kind !== "ok") return worktreeResult;
  const worktree = worktreeResult.value;
  const trust = await preflightWorktreeTrust(options.agent, worktree.path, environment);
  if (trust.kind !== "ok") return trust;
  const registeredRepository = await registerMegabrainRepository(worktree.path, environment, process);
  if (registeredRepository.kind !== "ok" && !registeredRepository.error.startsWith("not a git repository:")) return registeredRepository;
  prompt = finalPrompt(options, id);
  const resolvedPromptBudget = validatePromptBudget(prompt, selectedRuntime);
  if (resolvedPromptBudget.kind !== "ok") return resolvedPromptBudget;
  const callerInTmux = Boolean(environment.TMUX && environment.TMUX_PANE);
  let sameWorktree = false;
  if (callerInTmux) {
    const callerPath = await getTmux().paneCurrentPath?.(environment.TMUX_PANE!, process);
    if (callerPath?.kind === "ok") {
      const [callerRealPath, targetRealPath] = await Promise.all([
        realpath(callerPath.value).catch(() => null),
        realpath(worktree.path).catch(() => null),
      ]);
      sameWorktree = callerRealPath !== null && targetRealPath !== null && callerRealPath === targetRealPath;
    }
  }
  const root = resolve(resolveStateDirectory(environment));
  const existingWorktreeSession = selectedRuntime === "tmux" && !sameWorktree
    ? await existingTmuxSessionForWorktree(root, worktree.path, process)
    : undefined;
  let queuedParent: RecordValue | undefined;
  if (environment.MEGABRAIN_SPAWN_DISPATCH_ID !== undefined) {
    const opened = readOnlyStateDatabase(environment);
    if (opened.kind === "ok") {
      const prior = getDispatch(opened.value, id);
      if (prior.kind === "ok" && prior.value?.admissionQueueEntry === true) queuedParent = prior.value as RecordValue;
    }
  }
  const resolvedParentContext = await resolveCaller(environment, process);
  const parentContext = queuedParent === undefined ? resolvedParentContext : {
    id: stringValue(queuedParent.parentSessionId) ?? resolvedParentContext.id,
    host: stringValue(queuedParent.parentHost) ?? resolvedParentContext.host,
    terminalId: stringValue(queuedParent.parentTerminalId) ?? null,
    tmuxSession: stringValue(queuedParent.parentTmuxSession) ?? null,
    tmuxPane: stringValue(queuedParent.parentTmuxPane) ?? null,
  };
  const placement = decideTmuxPlacement({ callerInTmux, sameWorktree, tmuxRuntimeSelected: selectedRuntime === "tmux", existingSession: existingWorktreeSession !== undefined });
  // A caller under no terminal host (a plain shell, a bare agent session) has no host terminal to
  // open a tab in, so its children always run in tmux.
  const runtime: SpawnRuntime = placement.kind === "host" && getHost(parentContext.host) !== undefined ? "host" : "tmux";
  // Runtime selection depends on same-worktree tmux placement, so budget after resolving it.
  if (runtime !== selectedRuntime) {
    const budget = validatePromptBudget(prompt, runtime);
    if (budget.kind !== "ok") return budget;
  }
  const parentWorkspace = queuedParent === undefined ? parentWorkspaceId(environment) : stringValue(queuedParent.parentWorkspaceId) ?? null;
  const parentTmux = queuedParent === undefined ? parentTmuxChannel(environment) : {
    tmuxSession: stringValue(queuedParent.parentTmuxSession) ?? null,
    tmuxPane: stringValue(queuedParent.parentTmuxPane) ?? null,
  };
  const chatName = options.label ?? worktree.branch;
  // Antigravity names its conversation only in its log; a per-dispatch log lets the context meter find it.
  // A Grok child runs its own leader so a reply can enter its session queue without typing.
  // Without a directory to bind in, the child starts without a leader and replies are typed.
  const candidateSocket = options.agent === "grok" ? grokLeaderSocket(root, id) : undefined;
  const leaderSocket = candidateSocket === undefined ? undefined
    : await mkdir(dirname(candidateSocket), { recursive: true, mode: 0o700 }).then(() => candidateSocket, () => undefined);
  const command = options.agent === "claude" ? `${agentCommand.value} --name ${shellQuote(chatName)}`
    : options.agent === "agy" ? `${agentCommand.value} --log-file ${shellQuote(agyLogFile(root, id))}`
      : leaderSocket !== undefined ? `${agentCommand.value} --leader --leader-socket ${shellQuote(leaderSocket)}`
        : agentCommand.value;
  // An agent that takes an initial prompt on its command line gets the brief there, read from a
  // 0600 file by the pane's shell, so it never has to be typed into a composer. `--` keeps a
  // variadic option in --agent-arg from swallowing it.
  const promptFlag = runtime === "tmux" ? agent.initialPromptFlag : undefined;
  const promptFile = promptFlag === undefined ? undefined : await writePromptFile(root, id, prompt);
  if (promptFile !== undefined) trace.promptFile = promptFile;
  const launch = promptFile === undefined ? command : `${command} ${promptFlag} "$(cat ${shellQuote(promptFile)})"`;
  const readinessTimeoutMs = agentReadyTimeoutMs(environment, options.agent);

  // Admission runs after option/worktree validation but before any terminal or agent is created.
  // The fixed fallback is deliberately conservative and applies when resource history is off or
  // has not yet collected a sample for this agent.
  const policy = await readAdmissionPolicy(environment);
  if (policy !== undefined) {
    const admissionDatabase = readOnlyStateDatabase(environment);
    if (admissionDatabase.kind !== "ok") return failed(admissionDatabase.error, admissionDatabase.exitCode);
    const estimates = estimateTypicalRssByAgent(admissionDatabase.value);
    const machine = await readMachineResources(process);
    const listed = listDispatches(admissionDatabase.value);
    if (listed.kind !== "ok") return listed;
    const active = listed.value.filter((item) => item.dispatchId !== id && ["spawning", "running", "waiting_for_reply", "orphaned"].includes(String(item.state)));
    const admission = decideAdmission({ kind: "spawn", agent: options.agent, estimatedCostBytes: estimates[options.agent] ?? DEFAULT_AGENT_COST_BYTES }, policy, {
      machine, runningAgents: active.length, runningContainerSuites: 0,
    });
    const prior = getDispatch(admissionDatabase.value, id);
    if (prior.kind !== "ok") return prior;
    if (admission.status === "refused") { trace.reason = "admission-refused"; return failed(admission.reason, 1); }
    if (admission.status === "queued") {
      if (options.admission === "fail") { trace.reason = "admission-refused"; return failed(`spawn refused: ${admission.reason}`, 1); }
      if (prior.value?.admissionQueueEntry === true && ["queued", "spawning"].includes(String(prior.value.state))) {
        const updated = await callStateOwner(root, { operation: "dispatch-patch", dispatchId: id, expectedState: ["queued", "spawning"], patch: { state: "queued", admissionReason: admission.reason } }) as RecordValue;
        if (updated.updated === false || updated.state !== "queued") return failed(`queued spawn ${id} was cancelled before it could start`);
      } else {
        const parentChatName = await coordinatorChatName(environment, process);
        const queuedMeta = await initialMeta(id, options, worktree, parentContext, parentWorkspace, parentTmux, runtime, "", null, null, null, parentChatName, environment.CODEX_THREAD_ID, environment.CODEX_THREAD_ID !== undefined ? "codex" : environment.CLAUDE_CODE_SESSION_ID !== undefined ? "claude" : resolveAgentDescriptor(environment.AI_AGENT ?? ""), environment.CLAUDE_CODE_SESSION_ID);
        Object.assign(queuedMeta, {
          state: "queued", processState: "starting", terminalState: "missing", admissionReason: admission.reason,
          queuedSpawnArgs: [...args], queuedAt: new Date().toISOString(), admissionQueueEntry: true,
        });
        await callStateOwner(root, { operation: "dispatch-create", dispatch: queuedMeta });
      }
      const currentQueue = listDispatches(admissionDatabase.value);
      if (currentQueue.kind !== "ok") return currentQueue;
      const queue = currentQueue.value.filter((item) => item.state === "queued").sort((left, right) => String(left.queuedAt ?? left.createdAt).localeCompare(String(right.queuedAt ?? right.createdAt)) || left.dispatchId.localeCompare(right.dispatchId));
      const position = Math.max(1, queue.findIndex((item) => item.dispatchId === id) + 1);
      const queuedRecord = getDispatch(admissionDatabase.value, id);
      if (queuedRecord.kind === "ok" && queuedRecord.value !== undefined) await notifyAdmissionStatus(root, admissionDatabase.value, id, queuedRecord.value as RecordValue, "queued", admission.reason, process, position);
      await startSupervisorWorker(root, environment, process);
      const output = { status: "queued", reason: admission.reason, dispatchId: id, position };
      return ok(options.json ? `${JSON.stringify(output)}\n` : `dispatch: ${id}\nstatus: queued\nposition: ${position}\nreason: ${admission.reason}\n`);
    }
    if (prior.value?.admissionQueueEntry === true) {
      if (prior.value.state === "queued") {
        const claimed = await callStateOwner(root, { operation: "dispatch-patch", dispatchId: id, expectedState: "queued", patch: { state: "spawning", admissionClaimedAt: new Date().toISOString() } }) as RecordValue;
        if (claimed.updated === false || claimed.state !== "spawning" || claimed.admissionQueueEntry !== true) return failed(`queued spawn ${id} was cancelled before it could start`);
      } else if (prior.value.state !== "spawning") return failed(`queued spawn ${id} was cancelled before it could start`);
    }
  }
  let terminalId = "";
  let session: string | null = null;
  let sessionId: string | null = null;
  let pane: string | null = null;
  let sessionOwned = true;
  let sessionCreatedBySpawn = false;
  let hostTerminalId: string | null = null;
  let hostTerminalHost: string | null = null;
  let tmuxHostWarning: string | null = null;
  let readinessError: string | undefined;
  let terminalCreateAttempts: number | undefined;

  if (runtime === "tmux") {
    if (placement.kind === "caller-window" && environment.TMUX_PANE !== undefined) {
      const current = await getTmux().sessionForPane(environment.TMUX_PANE, process);
      if (current.kind === "ok") {
        session = current.value;
        sessionOwned = false;
        const waited = await waitForTmuxSession(session, process);
        if (waited.kind !== "ok") return waited;
        const split = await splitTmuxWorktreePane(session, worktree.path, process, environment.TMUX_PANE);
        if (split.kind !== "ok") return split;
        pane = split.value;
      }
    }
    if (session === null) {
      const target = await openWorktreeTmuxTarget(root, worktree, parentContext, parentWorkspace, options, process);
      if (target.kind !== "ok") return target;
      session = target.value.session;
      pane = target.value.pane;
      sessionOwned = target.value.sessionOwned;
      sessionCreatedBySpawn = target.value.sessionCreated;
      if (sessionCreatedBySpawn) {
        trace.tmuxSession = session;
        trace.sessionCreatedBySpawn = true;
      }
      hostTerminalId = target.value.hostTerminalId;
      hostTerminalHost = target.value.hostTerminalHost;
      tmuxHostWarning = target.value.warning;
    }
    const waited = await waitForTmuxSession(session, process);
    if (waited.kind !== "ok") return waited;
    if (pane === null) {
      const panes = await getTmux().panesForSession(session, process);
      if (panes.kind !== "ok" || panes.value[0] === undefined) return failed(`tmux session ${session} has no pane`);
      pane = panes.value[0];
    }
    const identifiedSession = await process.run("tmux", ["display-message", "-p", "-t", pane, "#{session_id}"]);
    const stableSessionId = identifiedSession.kind === "ok" ? identifiedSession.value.stdout.trim() : "";
    sessionId = /^\$\d+$/.test(stableSessionId) ? stableSessionId : null;
    const registry = readOnlyStateDatabase(environment);
    if (registry.kind !== "ok") return failed(registry.error, registry.exitCode);
    const priorSession = getTmuxSession(registry.value, session);
    if (priorSession.kind !== "ok") return failed(priorSession.error, priorSession.exitCode);
    if (sessionId !== null) {
      const stale = await removeStaleStableSession(root, registry.value, session, sessionId, process);
      if (stale.kind !== "ok") return failed(stale.error, stale.exitCode);
    }
    const sessionRecord = {
      ...(priorSession.value ?? {}),
      tmuxSession: session,
      workingDirectory: await canonicalPath(worktree.path),
      tmuxPane: pane,
      megabrainOwned: sessionOwned || priorSession.value?.megabrainOwned === true,
      createdAt: priorSession.value?.createdAt ?? new Date().toISOString(),
      hostTerminalId: hostTerminalId ?? priorSession.value?.hostTerminalId ?? null,
      hostTerminalHost: hostTerminalHost ?? priorSession.value?.hostTerminalHost ?? null,
      workspaceId: worktree.workspaceId ?? parentWorkspace,
    };
    try {
      await callStateOwner(root, { operation: "tmux-session-write", action: "upsert", record: sessionRecord, stableSessionId: sessionId ?? (stringValue(priorSession.value?.stableSessionId) || null) });
    } catch (cause: unknown) {
      return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    // The CHILD's own identity, never the caller's: session/pane are always the pane this
    // dispatch actually runs in (freshly split or created above), even when the split reuses the
    // caller's own tmux session — the caller's own pane and this dispatch's pane are always
    // different panes. Before this fix terminalId was parentContext.id (the spawning caller's own
    // id), which findChild (queue-write.ts) matches against meta.terminalId === current.id &&
    // meta.childHost === current.host — so a non-tmux-hosted caller that spawned a tmux dispatch
    // matched its own just-spawned dispatch on its very next findChild call (the turn-end hook,
    // on every agent turn; `megabrain done`/`ask`/`received`). See initialMeta below for the
    // matching childHost fix.
    terminalId = `tmux:${session}:${pane}`;
  } else {
    // E: a structured Orca session (ORCA_STRUCTURED_SESSION=1, no ORCA_TERMINAL_HANDLE) now
    // resolves host "orca" here too (C, resolveCaller shares callerEnvironment with every other
    // verb), so this branch already launches such a caller through the orca provider below with
    // no further change. Verified before relying on that: `orca terminal create` takes only
    // --worktree/--title/--command/--focus (`orca terminal create --help`). The orca CLI is not
    // scoped to the caller's own terminal; nothing here needed a parent terminal identity to
    // begin with.
    const host = getHost(parentContext.host);
    if (host === undefined) return failed(`cannot launch agent from unknown orchestration host: ${parentContext.host}`);
    const created = host.create({ workspaceId: worktree.workspaceId ?? parentWorkspace, worktreePath: worktree.path, title: `${options.agent} ${worktree.path}` });
    if (created.kind !== "ok") return created;
    const createdTerminal = await createHostTerminal(host, created.value, process);
    if (createdTerminal.kind !== "ok") return createdTerminal;
    terminalId = createdTerminal.value.terminalId;
    terminalCreateAttempts = createdTerminal.value.attempts;
  }

  // Neither agy nor Grok sets AI_AGENT in its tool shells; each sets its own marker (measured).
  const parentAgent = environment.CODEX_THREAD_ID !== undefined ? "codex" : environment.CLAUDE_CODE_SESSION_ID !== undefined ? "claude"
    : environment.ANTIGRAVITY_AGENT === "1" ? "agy" : environment.GROK_AGENT === "1" ? "grok" : resolveAgentDescriptor(environment.AI_AGENT ?? "");
  const parentAgentSessionId = queuedParent === undefined
    ? parentAgent === "claude" ? environment.CLAUDE_CODE_SESSION_ID : undefined
    : stringValue(queuedParent.parentAgentSessionId);
  const parentAgentPid = queuedParent === undefined && parentAgentSessionId !== undefined && environment.HOME !== undefined
    ? await findClaudeSessionPid(parentAgentSessionId, environment.HOME, process)
    : queuedParent === undefined ? undefined : typeof queuedParent.parentAgentPid === "number" ? queuedParent.parentAgentPid : undefined;
  const parentAgentThreadId = queuedParent === undefined ? environment.CODEX_THREAD_ID : stringValue(queuedParent.parentAgentThreadId);
  const parentChatName = queuedParent === undefined ? await coordinatorChatName(environment, process) : stringValue(queuedParent.parentChatName) ?? await coordinatorChatName(environment, process);
  const meta = await initialMeta(id, options, worktree, parentContext, parentWorkspace, parentTmux, runtime, terminalId, session, sessionId, pane, parentChatName, parentAgentThreadId, queuedParent === undefined ? parentAgent : stringValue(queuedParent.parentAgent) ?? parentAgent, parentAgentSessionId, parentAgentPid);
  if (runtime === "tmux") Object.assign(meta, { tmuxSessionOwned: sessionOwned, tmuxHostTerminalId: hostTerminalId, tmuxHostTerminalHost: hostTerminalHost });
  if (options.agent === "agy") Object.assign(meta, { agyLogFile: agyLogFile(root, id) });
  if (leaderSocket !== undefined) Object.assign(meta, { grokLeaderSocket: leaderSocket });
  // A parent agy or Grok runs this spawn in one of its own tool shells, the one place its inbound
  // channel is known: agy's language server (a secret, so a 0600 file), or the leader a Grok session
  // runs under. A Grok session without a leader has no socket at all, and its mail is typed.
  if (parentAgent === "agy") await recordAgyLanguageServer(root, agyParentKey(id), environment).catch(() => undefined);
  if (parentAgent === "grok" && environment.GROK_LEADER_SOCKET && environment.GROK_SESSION_ID) {
    Object.assign(meta, { parentGrokLeaderSocket: environment.GROK_LEADER_SOCKET, parentGrokSessionId: environment.GROK_SESSION_ID });
  }
  const database = readOnlyStateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const existingDispatch = getDispatch(database.value, id);
  if (existingDispatch.kind !== "ok") return existingDispatch;
  if (existingDispatch.value?.admissionQueueEntry === true && ["queued", "spawning"].includes(String(existingDispatch.value.state))) {
    await callStateOwner(root, { operation: "dispatch-patch", dispatchId: id, patch: { ...meta, dispatchId: id, admissionQueueEntry: false } });
  } else {
    await callStateOwner(root, { operation: "dispatch-create", dispatch: meta });
  }
  trace.dispatchId = id;
  trace.terminalId = terminalId;
  if (pane !== null) trace.pane = pane;
  const callerPane = environment.TMUX_PANE;
  if (callerPane !== undefined && callerPane.trim() !== "") {
    const exists = await verifyTmuxPane(callerPane, process);
    if (exists.kind === "ok" && exists.value) await setTmuxChatPane(callerPane, parentAgent ?? "unknown", parentChatName, undefined, process);
  }
  if (runtime === "tmux" && pane !== null) await setTmuxChatPane(pane, options.agent, chatName, "spawning", process);
  if (runtime === "host" && parentContext.host === "orca") {
    await process.run("orca", ["terminal", "rename", "--terminal", terminalId, "--title", `${options.agent} · ${chatName}`]);
  }
  let receiptMissing: string | null = null;
  let promptChannel: "argv" | "paste" | undefined;
  let state: SpawnState = { dispatch: "spawning", process: "starting", terminal: "owned" };
  let step: SpawnStep = runtime === "tmux" ? "transcript-start" : "prompt-publication";
  const baseInput = (): Omit<SpawnDecisionInput, "step" | "outcome"> => ({ dispatchId: id, runtime, worktree: worktree.ownership, state });

  while (true) {
    let outcome: SpawnDecisionInput["outcome"];
    if (step === "prompt-publication") {
      const appended = await appendMessage(root, id, "parent", "prompt", prompt, parentContext.id, environment, process);
      outcome = appended.kind === "ok" ? { kind: "succeeded" } : { kind: "failed", failure: { call: "dispatch message append", detail: appended.error } };
    } else if (step === "readiness-wait") {
      const host = getHost(parentContext.host);
      const waited = host?.readiness({ workspaceId: worktree.workspaceId ?? parentWorkspace, terminalId }, process, readinessTimeoutMs, options.agent);
      if (waited === undefined) {
        readinessError = `${parentContext.host} terminal ${terminalId} did not become ready within ${readinessTimeoutMs}ms`;
        outcome = { kind: "failed" };
      } else {
        const result = await waited;
        if (result.kind !== "ok") readinessError = result.error;
        outcome = result.kind === "ok" ? { kind: "succeeded" } : { kind: "failed" };
      }
    } else if (step === "command-submission") {
      if (runtime === "tmux") {
        const terminalHost = parentContext.host === "orca" || parentContext.host === "superset" ? `MEGABRAIN_TERMINAL_HOST=${shellQuote(parentContext.host)} ` : "";
        const terminalParent = parentContext.host === "orca" && parentContext.terminalId !== null ? `MEGABRAIN_TERMINAL_PARENT_ID=${shellQuote(parentContext.terminalId)} ` : "";
        const command = `cd ${shellQuote(worktree.path)} && ${clearCallerIdentityEnv} ${terminalHost}${terminalParent}MEGABRAIN_STATE_DIR=${shellQuote(root)} MEGABRAIN_DISPATCH_STATE_DIR=${shellQuote(root)} MEGABRAIN_DISPATCH_ID=${shellQuote(id)} MEGABRAIN_TMUX_SESSION=${shellQuote(session ?? "")} MEGABRAIN_TMUX_PANE=${shellQuote(pane ?? "")} ${launch}`;
        const launcher = await createTmuxLauncher(root, command);
        if (launcher.kind !== "ok") {
          outcome = { kind: "failed", failure: { call: "create tmux launcher", detail: launcher.error } };
        } else {
          const started = await respawnTmuxPane(pane ?? "", launcher.value, process);
          outcome = started.kind === "ok" ? { kind: "succeeded" } : { kind: "failed", failure: { call: `tmux respawn-pane --target ${pane ?? ""}`, detail: started.error } };
        }
      } else {
        const currentDispatch = getDispatch(database.value, id);
        const childHost = stringValue(currentDispatch.kind === "ok" ? currentDispatch.value?.childHost : "");
        const host = getHost(childHost);
        const identityVariable = host?.terminalIdentityVariable;
        const call = identityVariable === undefined ? undefined : host?.send({ workspaceId: worktree.workspaceId ?? parentWorkspace, terminalId, text: `cd ${shellQuote(worktree.path)} && env -u TMUX -u TMUX_PANE ${CALLER_IDENTITY_ENV_VARS.map((name) => `-u ${name}`).join(" ")} MEGABRAIN_TERMINAL_HOST=${shellQuote(childHost ?? "")} MEGABRAIN_STATE_DIR=${shellQuote(root)} MEGABRAIN_DISPATCH_STATE_DIR=${shellQuote(root)} ${identityVariable}=${shellQuote(terminalId)} MEGABRAIN_DISPATCH_ID=${shellQuote(id)} MEGABRAIN_NO_TMUX=1 ${command}` });
        const sent = call?.kind === "ok" ? await runHostSend(childHost ?? "", process, call.value) : failed(resultError(call ?? failed("host command could not be built"), "host command could not be built"));
        outcome = sent.kind === "ok" ? { kind: "succeeded" } : { kind: "failed", failure: failureForCall(call?.kind === "ok" ? call.value : undefined, sent, `${childHost} terminal send`) };
      }
    } else if (step === "readiness-output-validation") {
      const waited = await waitForTmuxReadiness(options.agent, pane ?? "", readinessTimeoutMs, process, promptFile !== undefined);
      if (options.agent === "grok" && waited.result.kind === "ok" && pane !== null) {
        const panePid = await getTmux().panePid(pane, process, sessionId ?? undefined);
        if (panePid.kind === "ok") {
          const grokHome = environment.GROK_HOME ?? join(environment.HOME ?? "", ".grok");
          const grokSessionId = await resolveGrokSessionId(environment.HOME ?? "", panePid.value.trim(), worktree.path, process, grokHome);
          if (grokSessionId !== undefined) await updateMeta(root, id, { grokSessionId }, process);
        }
      }
      if (waited.result.kind !== "ok") {
        readinessError = waited.result.error;
        await recordRejectedReadinessFrame(root, id, options.agent, readinessTimeoutMs, waited.lastFrame);
      }
      outcome = waited.result.kind === "ok" ? { kind: "succeeded" } : { kind: "failed" };
    } else if (step === "prompt-transport") {
      if (runtime === "tmux") {
        // The readiness wait just proved the composer idle, so this is a normal submit, not a
        // queued one (submitKey(agent) is for queue-write.ts typing into a possibly busy
        // composer, where Codex's Tab queues instead of submitting). Every agent's composer
        // submits an idle prompt on Enter. The text goes in as one bracketed paste that is proven
        // to be in the composer before Enter, never as keystrokes.
        // The brief from argv needs only proof that the agent took it; the paste is the fallback
        // for an agent that never does.
        const fromArgv = promptFile === undefined ? undefined : await awaitArgvPrompt({ pane: pane ?? "", agent: options.agent, environment, process }, () => hasReceipt(root, id));
        promptChannel = fromArgv === undefined ? "paste" : "argv";
        outcome = fromArgv ?? await transportTmuxPrompt({ root, pane: pane ?? "", agent: options.agent, prompt, environment, process, rejectedFrame: (frame) => recordFrame(root, id, "composer-frame", `the ${options.agent} composer never showed the whole prompt; last frame:\n${frame.split("\n").slice(-READINESS_FRAME_MAX_LINES).join("\n").trimEnd()}`) }, () => hasReceipt(root, id));
      } else {
        const currentDispatch = getDispatch(database.value, id);
        const childHost = stringValue(currentDispatch.kind === "ok" ? currentDispatch.value?.childHost : "");
        const host = getHost(childHost);
        const call = host?.send({ workspaceId: worktree.workspaceId ?? parentWorkspace, terminalId, text: prompt, enter: true });
        const sent = await sendSessionMessage({
          caller: "spawn-fallback", messageId: `${id}:initial-prompt`, target: { agent: options.agent, id: terminalId }, text: prompt,
          channels: { typed: async () => {
            if (call?.kind !== "ok") return { delivered: false, detail: resultError(call ?? failed("host prompt could not be built"), "host prompt could not be built") };
            const result = await runHostSend(childHost ?? "", process, call.value);
            return result.kind === "ok" ? true : { delivered: false, detail: result.kind === "failed" ? result.error : result.reason };
          } },
          recordChannel: async (channel) => { await recordChannelResultThroughOwner(root, { agent: options.agent, channel, agentVersion: "unknown", ok: true }); },
        });
        if (!sent.delivered) outcome = { kind: "prompt-transport", status: "failed", failure: { call: `${childHost} terminal send`, detail: sent.detail ?? "session message was not delivered" } };
        else outcome = settleHostReceipt(root, id);
      }
    } else {
      outcome = { kind: "succeeded" };
    }

    const planned = decideSpawnStep({ ...baseInput(), step, outcome });
    if (planned.kind !== "ok") return planned;
    const plan = planned.value;
    state = plan.state;
    const metadataUpdate: RecordValue = {};
    if (step !== "prompt-transport" && step !== "prompt-confirmation" && step !== "state-persist") {
      Object.assign(metadataUpdate, { state: state.dispatch, processState: state.process, terminalState: state.terminal });
    }
    if (step === "prompt-publication" && outcome.kind === "succeeded") Object.assign(metadataUpdate, { promptPublication: "published", promptState: "awaiting-transport" });
    if (step === "prompt-transport" && outcome.kind === "prompt-transport") Object.assign(metadataUpdate, { ...(promptChannel === undefined ? {} : { promptChannel }), promptTransport: outcome.status === "failed" ? "not-transported" : "transported", promptReceipt: outcome.status === "delivered" ? "received" : outcome.status === "turn-without-receipt" ? "not-received" : "pending", promptState: outcome.status === "delivered" ? "confirmed" : "awaiting-receipt", ...(outcome.receiptMissing === undefined ? {} : { processState: "running", receiptMissing: { reason: outcome.receiptMissing, at: new Date().toISOString() } }) });
    if (step === "prompt-confirmation" && outcome.kind === "succeeded") Object.assign(metadataUpdate, { promptDelivered: true, promptDelivery: "delivered", promptState: "confirmed" });
    if (plan.action === "fail") Object.assign(metadataUpdate, { state: plan.state.dispatch, processState: plan.state.process, terminalState: plan.state.terminal, reason: plan.reason, promptState: "failed" });
    if (outcome.kind === "prompt-transport" && outcome.receiptMissing !== undefined) receiptMissing = outcome.receiptMissing;
    const metadataSaved = await updateMeta(root, id, metadataUpdate, process);
    if (metadataSaved.kind !== "ok") return metadataSaved;
    if (step === "prompt-transport" && outcome.kind === "prompt-transport" && (outcome.status === "delivered" || outcome.status === "turn-without-receipt")) {
      const marked = await markRunningIfSpawning(root, id, process);
      if (marked.kind !== "ok") return marked;
    }
    if (plan.action === "fail") {
      trace.reason = plan.reason ?? undefined;
      const cleanupFailures = await cleanup(root, id, worktree, plan, process, dependencies, terminalId, session, pane, sessionCreatedBySpawn);
      if (runtime === "tmux" && sessionCreatedBySpawn) trace.sessionCleanupAttempted = true;
      return failureResult(plan, step === "readiness-wait" || step === "readiness-output-validation" ? readinessError : undefined, cleanupFailures);
    }
    if (plan.nextStep === null) {
      await startSupervisorWorker(root, environment, process);
      // Last, so a spawn that failed above never leaves a window attached to a session it killed.
      const viewer = session === null ? undefined : await openViewer({ session, flag: parsed.value.terminal, automatic: parentContext.host === "local" && !callerInTmux && sessionCreatedBySpawn, env: environment, process });
      const output = { status: "spawned", reason: null, dispatchId: id, ...(parentContext.host === "local" ? { deliveryChannel: "hook-and-watch" } : {}), terminalId, tmuxPane: pane, state: state.dispatch, promptState: "awaiting-receipt", reconcile: plan.reconcile?.instruction ?? null, ...(receiptMissing === null ? {} : { receiptMissing }), ...(terminalCreateAttempts === undefined ? {} : { terminalCreateAttempts }), ...(tmuxHostWarning === null ? {} : { warning: tmuxHostWarning }), ...(viewer === undefined ? {} : { viewer }) };
      const attempts = terminalCreateAttempts !== undefined && terminalCreateAttempts > 1 ? `terminal-create-attempts: ${terminalCreateAttempts}\n` : "";
      const warning = tmuxHostWarning === null ? "" : `warning: ${tmuxHostWarning}\n`;
      return ok(parsed.value.json ? `${JSON.stringify(output)}\n` : `dispatch: ${id}\nstate: ${state.dispatch}\n${parentContext.host === "local" ? "delivery: hook-and-watch\n" : ""}${attempts}${warning}${viewer === undefined ? "" : viewerLine(viewer)}reconcile: ${plan.reconcile?.instruction ?? "none"}\n`, plan.exitCode);
    }
    step = plan.nextStep;
  }
}
