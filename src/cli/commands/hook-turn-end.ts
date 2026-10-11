import { readFile } from "node:fs/promises";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { checkDispatchTransition, openDispatchStates } from "../../core/dispatch-states.js";
import { resolveStateDirectory } from "../../core/state.js";
import { failed, ok, type Result } from "../../core/result.js";
import { getTmux, sendTmuxPair } from "../../hosts/tmux.js";
import { hostReadText, terminalStatus, type RecordValue } from "./orchestrate-terminal.js";
import { executeCheck, loadMessages } from "./check.js";
import { appendMessage, findChild, parentContextMatches, sendParentPointer, waiterIsActive, type QueueEnvironment } from "./queue-write.js";
import { continueRefusedChain } from "./chain-run.js";
import { getDispatch, listDispatches, listMessages, mutateDispatch, noDispatchChange, setDeliveryTransport, stateDatabase } from "../../adapters/state-db.js";
import { setTmuxChatPane } from "../../core/chat-pane.js";
import { randomUUID } from "node:crypto";
import { waitForStableIdle } from "../../core/liveness.js";
import { readContextMeter } from "../../core/context-meter.js";
import { decideLoopTurn, evaluateContextThreshold, type ContextPolicy, type ContextThresholdState } from "../../core/context-policy.js";
import { getAgent } from "../../agents/index.js";
import { getHost, runHostSend } from "../../hosts/index.js";

export type HookEnvironment = QueueEnvironment;
type JsonRecord = Record<string, unknown>;

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

// The turn-end hook's default response: `{}` for every agent except Cursor, which needs
// `{"continue":true}` on every reply (the deleted hooks/megabrain-turn-end.sh wrapper's own
// MEGABRAIN_HOOK_RESPONSE initialisation, before any later mutation — agent hook configs now
// invoke this binary's `hook turn-end` command directly).
function defaultResponseText(environment: HookEnvironment): string {
  return environment.MEGABRAIN_HOOK_AGENT === "cursor" ? '{"continue":true}' : "{}";
}

// A faithful, narrow port of megabrain_session_id() (lib/common.sh): Superset terminal, then Orca
// terminal, then a probed tmux pane — nothing else. Deliberately NOT src/core/context.ts's
// resolveCallerIdentity, which additionally prefers an explicit MEGABRAIN_SESSION_ID override and
// a Claude/Codex agent-session id ahead of the terminal handle. Those extra tiers exist for the
// child-facing ask/done/check commands; this hook is only ever invoked once a terminal marker or a
// real tmux pane is already known to be present (see the gate at the top of
// executeHookTurnEnd), so using the broader resolver here would let an inherited
// CLAUDE_CODE_SESSION_ID silently outrank the terminal identity the rest of the dispatch-matching
// machinery (meta.terminalId / meta.parentSessionId) is keyed on.
async function computeSessionId(environment: HookEnvironment, processAdapter: ProcessAdapter): Promise<Readonly<{ id: string; host: string }> | undefined> {
  if (present(environment.SUPERSET_TERMINAL_ID)) return { id: environment.SUPERSET_TERMINAL_ID, host: "superset" };
  if (present(environment.ORCA_TERMINAL_HANDLE)) return { id: environment.ORCA_TERMINAL_HANDLE, host: "orca" };
  if (present(environment.TMUX) && present(environment.TMUX_PANE)) {
    const result = await getTmux().sessionForPane(environment.TMUX_PANE, processAdapter);
    if (result.kind === "ok" && result.value !== "") return { id: `${result.value}:${environment.TMUX_PANE}`, host: "tmux" };
  }
  return undefined;
}

// megabrain_parent_notify_pointer_many(count, ids, close). The hook only ever calls it with
// action=close (the "N mails" variant is used elsewhere, never by this hook).
function pointerForFinishedDispatches(count: number, ids: string): string {
  return count === 1
    ? `dispatch ${ids} finished but still owns its terminal; run megabrain orchestrate close ${ids}`
    : `${count} finished dispatches still own terminals: ${ids}; run megabrain orchestrate close <id> for each`;
}

// megabrain_dispatch_has_prompt_receipt: has the child ever sent a "received" message.
async function hasPromptReceipt(root: string, dispatchId: string): Promise<boolean> {
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return false;
  const messages = listMessages(database.value, dispatchId);
  return messages.kind === "ok" && messages.value.some((message) => message.from === "child" && message.type === "received");
}

// megabrain_dispatch_has_recent_child_activity: the newest child received/ask/done message's
// mtime, compared against MEGABRAIN_DISPATCH_LIVE_ACTIVITY_WINDOW_SECONDS (60, hardcoded in the
// shell too — not an environment override).
const LIVE_ACTIVITY_WINDOW_SECONDS = 60;

async function hasRecentChildActivity(root: string, dispatchId: string): Promise<boolean> {
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return false;
  const result = listMessages(database.value, dispatchId);
  if (result.kind !== "ok") return false;
  let latest = 0;
  for (const message of result.value) {
    if (message.from !== "child" || (message.type !== "received" && message.type !== "ask" && message.type !== "done")) continue;
    const modified = Date.parse(message.createdAt) / 1000;
    if (Number.isFinite(modified) && modified > latest) latest = modified;
  }
  if (latest === 0) return false;
  return Math.floor(Date.now() / 1000) - latest <= LIVE_ACTIVITY_WINDOW_SECONDS;
}

// megabrain_dispatch_stalled_is_due: a missing terminal is always due; otherwise due unless the
// child has spoken (received/ask/done) inside the live-activity window.
async function stalledIsDue(root: string, dispatchId: string, meta: RecordValue, processAdapter: ProcessAdapter): Promise<boolean> {
  const status = await terminalStatus(meta, processAdapter);
  if (status === "missing") return true;
  if (await hasRecentChildActivity(root, dispatchId)) return false;
  return true;
}

// Screen text is used only to see whether the agent is idle after /compact; context itself comes from agent files.
async function readContextFrame(meta: RecordValue, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (meta.runtime === "tmux") {
    const pane = typeof meta.tmuxPane === "string" ? meta.tmuxPane : "";
    if (pane === "") return failed("context screen is unavailable: dispatch pane is missing");
    const status = await terminalStatus(meta, processAdapter);
    if (status !== "proven") return failed(`context screen is unavailable: terminal identity is ${status}`);
    return getTmux().capturePane(pane, 200, processAdapter);
  }
  const provider = getHost(typeof meta.childHost === "string" ? meta.childHost : "");
  const terminalId = typeof meta.terminalId === "string" ? meta.terminalId : "";
  if (provider === undefined || terminalId === "") return failed("context screen is unavailable: host terminal identity is missing");
  const call = provider.read({ workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId });
  if (call.kind !== "ok") return failed(call.kind === "failed" ? call.error : call.reason);
  const result = await processAdapter.run(call.value.command, call.value.args);
  if (result.kind !== "ok") return failed(result.kind === "failed" ? result.error : result.reason);
  try { return ok(hostReadText(JSON.parse(result.value.stdout))); }
  catch { return failed("context screen is unavailable: host terminal returned invalid read-back data"); }
}

async function sendContextInput(root: string, meta: RecordValue, text: string, environment: HookEnvironment, processAdapter: ProcessAdapter): Promise<Result<void>> {
  const identity = await terminalStatus(meta, processAdapter);
  if (identity !== "proven") return failed(`context action could not be sent: terminal identity is ${identity}`);
  if (meta.runtime === "tmux") {
    const pane = typeof meta.tmuxPane === "string" ? meta.tmuxPane : "";
    if (pane === "") return failed("context action could not be sent: dispatch pane is missing");
    return sendTmuxPair(root, pane, text, "Enter", environment, processAdapter);
  }
  const hostId = typeof meta.childHost === "string" ? meta.childHost : "";
  const provider = getHost(hostId);
  if (provider === undefined) return failed(`context action could not be sent: host is unavailable: ${hostId || "unknown"}`);
  const call = provider.send({ workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId: typeof meta.terminalId === "string" ? meta.terminalId : "", text });
  if (call.kind !== "ok") return failed(call.kind === "failed" ? call.error : call.reason);
  const result = await runHostSend(hostId, processAdapter, call.value);
  return result.kind === "ok" ? ok(undefined) : failed(result.kind === "failed" ? result.error : result.reason);
}

function policyValue(value: unknown): ContextPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return {
    ...(typeof source.contextCeiling === "number" ? { contextCeiling: source.contextCeiling } : {}),
    ...(typeof source.compactAt === "number" ? { compactAt: source.compactAt } : {}),
    ...(typeof source.loop === "boolean" ? { loop: source.loop } : {}),
    ...(typeof source.maxIterations === "number" ? { maxIterations: source.maxIterations } : {}),
  };
}

function policyStateValue(value: unknown): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}

async function finishContextAction(root: string, dispatchId: string, eventId: string, outcome: string): Promise<void> {
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return;
  mutateDispatch(database.value, dispatchId, (current) => {
    const previous = policyStateValue(current.contextPolicyState);
    const actions = Array.isArray(previous.actions) ? previous.actions as RecordValue[] : [];
    const nextActions = actions.map((action) => action.id === eventId ? { ...action, outcome } : action);
    return { ...current, contextPolicyState: { ...previous, actions: nextActions }, updatedAt: new Date().toISOString() };
  });
}

type ContextPolicyEffect = Readonly<{ response: string | null; handled: boolean }>;

async function applyContextPolicy(
  root: string,
  dispatchId: string,
  meta: RecordValue,
  environment: HookEnvironment,
  processAdapter: ProcessAdapter,
): Promise<ContextPolicyEffect> {
  const policy = policyValue(meta.contextPolicy);
  if (policy.contextCeiling === undefined && policy.compactAt === undefined && policy.loop !== true) return { response: null, handled: false };
  const agentId = typeof meta.agent === "string" ? meta.agent : "";
  const home = environment.HOME ?? "";
  const meter = home === "" ? { status: "unknown" as const } : await readContextMeter({
    agent: agentId,
    ...(typeof meta.agentThreadId === "string" ? { agentThreadId: meta.agentThreadId } : {}),
    ...(typeof meta.agentSessionId === "string" ? { agentSessionId: meta.agentSessionId } : {}),
  }, home);
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return { response: null, handled: false };
  const messages = listMessages(database.value, dispatchId);
  const done = messages.kind === "ok" && messages.value.some((message) => message.from === "child" && message.type === "done");
  if (done) return { response: null, handled: false };

  let event: RecordValue | undefined;
  let eventId = "";
  let plannedPolicy = policy;
  let action: "stop" | "compact" | "continue" | "none" = "none";
  let stopReason = "";
  const updated = mutateDispatch(database.value, dispatchId, (current) => {
    plannedPolicy = policyValue(current.contextPolicy);
    if (plannedPolicy.contextCeiling === undefined && plannedPolicy.compactAt === undefined && plannedPolicy.loop !== true) return noDispatchChange;
    const previous = policyStateValue(current.contextPolicyState);
    const thresholdState: ContextThresholdState = {
      ceilingLatched: previous.ceilingLatched === true,
      compactLatched: previous.compactLatched === true,
    };
    const threshold = evaluateContextThreshold(plannedPolicy, thresholdState, meter);
    const previousIterations = typeof previous.loopIterations === "number" && Number.isSafeInteger(previous.loopIterations) ? previous.loopIterations : 0;
    const nextIterations = plannedPolicy.loop === true ? previousIterations + 1 : previousIterations;
    const loopDecision = plannedPolicy.loop === true ? decideLoopTurn(false, nextIterations, plannedPolicy.maxIterations) : { action: "done" as const, completedIterations: previousIterations };
    const ceilingStop = threshold.action === "stop";
    const budgetStop = !ceilingStop && plannedPolicy.loop === true && loopDecision.action === "stop";
    const unknownBudgetStop = !ceilingStop && !budgetStop && plannedPolicy.loop === true && plannedPolicy.maxIterations === undefined && meter.status === "unknown";
    if (ceilingStop) { action = "stop"; stopReason = "context ceiling reached"; }
    else if (budgetStop) { action = "stop"; stopReason = "loop iteration budget reached"; }
    else if (unknownBudgetStop) { action = "stop"; stopReason = "context meter unavailable for the loop budget"; }
    else if (threshold.action === "compact") action = "compact";
    else if (plannedPolicy.loop === true) action = "continue";
    if (action === "none" && threshold.state.ceilingLatched === thresholdState.ceilingLatched && threshold.state.compactLatched === thresholdState.compactLatched) return noDispatchChange;

    const actions = Array.isArray(previous.actions) ? previous.actions as RecordValue[] : [];
    const patch: RecordValue = {
      ceilingLatched: threshold.state.ceilingLatched,
      compactLatched: threshold.state.compactLatched,
      loopIterations: nextIterations,
      actions,
    };
    if (action !== "none") {
      eventId = randomUUID();
      event = {
        id: eventId,
        action,
        reason: action === "stop" ? stopReason : action === "compact" ? "context threshold reached" : "loop prompt re-injected",
        percentUsed: meter.status === "known" ? meter.percentUsed : null,
        sourceFrame: meter.status === "known" ? meter.sourceFrame.slice(0, 500) : null,
        reading: meter.status,
        outcome: "pending",
        createdAt: new Date().toISOString(),
      };
      patch.actions = [...actions, event];
    }
    const processState = typeof current.processState === "string" ? current.processState : "";
    const stopTransition = action === "stop" ? checkDispatchTransition("process", processState, "stopped") : undefined;
    const dispatchState = typeof current.state === "string" ? current.state : "";
    const waitTransition = action === "stop" ? checkDispatchTransition("dispatch", dispatchState, "waiting_for_reply") : undefined;
    return {
      ...current,
      ...(stopTransition?.kind === "ok" ? { processState: "stopped" } : {}),
      ...(waitTransition?.kind === "ok" ? { state: "waiting_for_reply", stage: stopReason === "context ceiling reached" ? "context-ceiling" : "context-policy-stop", reason: stopReason } : {}),
      contextPolicyState: patch,
      ...(action === "stop" ? { contextPolicyStopReason: stopReason, contextPolicyStoppedAt: new Date().toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
  if (updated.kind !== "ok" || action === "none" || event === undefined) return { response: null, handled: false };

  const continuation = typeof updated.value.contextPolicyPrompt === "string" ? updated.value.contextPolicyPrompt : typeof updated.value.contextLoopPrompt === "string" ? updated.value.contextLoopPrompt : "";
  if (action === "stop") {
    await finishContextAction(root, dispatchId, eventId, "completed");
    return { response: `{"decision":"block","reason":"${stopReason}"}`, handled: true };
  }

  if (action === "compact") {
    const compact = getAgent(agentId)?.compactCommand;
    if (compact === undefined) {
      await finishContextAction(root, dispatchId, eventId, "failed: compact command unavailable");
      return { response: null, handled: true };
    }
    const sent = await sendContextInput(root, meta, compact, environment, processAdapter);
    if (sent.kind !== "ok") {
      await finishContextAction(root, dispatchId, eventId, `failed: ${sent.error}`);
      return { response: null, handled: true };
    }
    const waited = await waitForStableIdle(agentId, 60000, () => readContextFrame(meta, processAdapter), `context compaction did not finish within 60000ms`);
    if (waited.kind !== "ok") {
      await finishContextAction(root, dispatchId, eventId, `failed: ${waited.error}`);
      return { response: null, handled: true };
    }
  }

  const prompt = continuation === "" ? "Continue the dispatch task from your current progress and report done when it is complete." : `Continue the dispatch task from your current progress. Original prompt:\n\n${continuation}`;
  const continued = await sendContextInput(root, meta, prompt, environment, processAdapter);
  await finishContextAction(root, dispatchId, eventId, continued.kind === "ok" ? "completed" : `failed: ${continued.error}`);
  return { response: null, handled: true };
}

// megabrain_dispatch_limit_refusal_read: only tmux dispatches can be checked (host runtimes have
// no pane to capture), and the refusal needs both the anchored first line and the separate
// model-switch marker so quoted prose cannot trigger it.
async function readLimitRefusal(meta: JsonRecord, processAdapter: ProcessAdapter): Promise<Readonly<{ refused: boolean; reason: string }>> {
  const runtime = typeof meta.runtime === "string" ? meta.runtime : "host";
  if (runtime !== "tmux") return { refused: false, reason: "" };
  const pane = typeof meta.tmuxPane === "string" ? meta.tmuxPane : "";
  if (pane === "") return { refused: false, reason: "" };
  const captured = await getTmux().capturePane(pane, 200, processAdapter);
  if (captured.kind !== "ok") return { refused: false, reason: "" };
  const output = captured.value;
  if (!/^You've hit your usage limit for/m.test(output)) return { refused: false, reason: "" };
  if (!output.includes("Switch to another model now,")) return { refused: false, reason: "" };
  return { refused: true, reason: "agent refused the dispatch: You've hit your usage limit for" };
}

// megabrain_dispatch_mark_limit_refused: fails the dispatch (state + processState), records the
// refusal reason, and marks reconcileOutcome=limit-refused — the field continueRefusedChain later
// reads back to confirm this dispatch really was marked here before resuming its chain. Refuses
// (mirroring megabrain_dispatch_meta_update_fields's own transition validation) rather than write
// an illegal state/processState transition.
async function markLimitRefused(root: string, dispatchId: string, reason: string, processAdapter: ProcessAdapter): Promise<boolean> {
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return false;
  let refused = false;
  const updated = mutateDispatch(database.value, dispatchId, (meta) => {
    const state = typeof meta.state === "string" ? meta.state : "";
    const processState = typeof meta.processState === "string" ? meta.processState : "";
    if (checkDispatchTransition("dispatch", state, "failed").kind !== "ok" || checkDispatchTransition("process", processState, "failed").kind !== "ok") { refused = true; return noDispatchChange; }
    return { promptReceipt: "unknown", promptState: "failed", promptDeliveryReason: reason, state: "failed", processState: "failed", stage: "limit-refused", reason, reconcileOutcome: "limit-refused", updatedAt: new Date().toISOString() };
  });
  if (updated.kind !== "ok" || refused) return false;
  const stored = getDispatch(database.value, dispatchId);
  const meta = stored.kind === "ok" ? stored.value : undefined;
  if (meta?.runtime === "tmux" && typeof meta.tmuxPane === "string") {
    await setTmuxChatPane(meta.tmuxPane, typeof meta.agent === "string" ? meta.agent : "unknown", typeof meta.chatName === "string" ? meta.chatName : typeof meta.branch === "string" ? meta.branch : dispatchId, "failed", processAdapter);
  }
  return true;
}

// megabrain_hook_parent_notify: scans every dispatch this session parents. A "done" dispatch that
// still owns its terminal is batched into one "N dispatches finished" nudge (first-match meta
// supplies the channel); a still-open dispatch that has not yet confirmed receipt of its prompt is
// checked for a usage-limit refusal in its pane and, if found, marked failed and offered a chain
// continuation. Every per-dispatch step is best-effort: one dispatch's failure must not stop the
// scan from reaching the rest (mirrors the shell's `|| true` / `|| continue` at each of these
// points).
async function hookParentNotify(root: string, session: Readonly<{ id: string; host: string }>, environment: HookEnvironment, processAdapter: ProcessAdapter): Promise<void> {
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return;
  const listed = listDispatches(database.value);
  if (listed.kind !== "ok") return;
  const doneIds: string[] = [];
  let doneFirstMeta: JsonRecord | undefined;

  for (const meta of listed.value) {
    const dispatchId = meta.dispatchId;
    if (dispatchId === undefined) continue;
    const state = typeof meta.state === "string" ? meta.state : "";
    const terminalState = typeof meta.terminalState === "string" ? meta.terminalState : "owned";
    const isOpen = (openDispatchStates as readonly string[]).includes(state);
    const isDoneOwned = state === "done" && terminalState === "owned";
    if (!isOpen && !isDoneOwned) continue;

    const parentSessionId = typeof meta.parentSessionId === "string" ? meta.parentSessionId : "";
    const parentHost = typeof meta.parentHost === "string" ? meta.parentHost : "";
    if (session.id !== parentSessionId || session.host !== parentHost) continue;
    if (!(await parentContextMatches(root, meta, processAdapter).catch(() => false))) continue;
    if (await waiterIsActive(root, dispatchId).catch(() => false)) continue;

    if (state === "done") {
      if (doneFirstMeta === undefined) doneFirstMeta = meta;
      doneIds.push(dispatchId);
      continue;
    }

    if (await hasPromptReceipt(root, dispatchId)) continue;
    const refusal = await readLimitRefusal(meta, processAdapter).catch(() => ({ refused: false, reason: "" }));
    if (!refusal.refused) continue;
    const marked = await markLimitRefused(root, dispatchId, refusal.reason, processAdapter).catch(() => false);
    if (!marked) continue;
    // WHY caught here and not left to propagate: a chain continuation failing (or a chain that
    // has no further step to take) must not stop the scan from reaching the remaining dispatches,
    // exactly like the shell's `megabrain_chain_continue_refused "$dispatch_id" >/dev/null 2>&1 || true`.
    await continueRefusedChain(dispatchId, environment, processAdapter).catch(() => undefined);
  }

  if (doneIds.length > 0 && doneFirstMeta !== undefined) {
    const pointer = pointerForFinishedDispatches(doneIds.length, doneIds.join(", "));
    await sendParentPointer(root, doneFirstMeta, pointer, environment, processAdapter).catch(() => undefined);
  }
}

// jq's `.a // .b // empty`: falls through null/false/missing (but not an empty string, which is
// truthy in jq) to the next alternative, and yields "" once every alternative is exhausted.
function jqAlternative(value: unknown): string | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parsePayload(raw: string): Readonly<{ text: string; transcriptPath: string }> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { text: "", transcriptPath: "" };
    const record = parsed as JsonRecord;
    const text = jqAlternative(record.last_assistant_message) ?? jqAlternative(record.lastAssistantMessage) ?? "";
    const transcriptPath = jqAlternative(record.transcript_path) ?? jqAlternative(record.transcriptPath) ?? "";
    return { text, transcriptPath };
  } catch {
    return { text: "", transcriptPath: "" };
  }
}

// `tail -n 20 "$path" 2>/dev/null | tail -c 8000`: the last 20 newline-separated lines, then the
// last 8000 bytes (not characters — a byte cut can land inside a multi-byte UTF-8 sequence, same
// as the shell).
async function tailTranscript(path: string): Promise<string> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (content === undefined) return "";
  const lastLines = content.split("\n").slice(-20).join("\n");
  const buffer = Buffer.from(lastLines, "utf8");
  const truncated = buffer.length > 8000 ? buffer.subarray(buffer.length - 8000) : buffer;
  return truncated.toString("utf8");
}

// Ports the deleted hooks/megabrain-turn-end.sh wrapper in full: same inputs (stdin/argv payload,
// environment), same decisions and side effects, and the same never-fail contract — every branch
// here ends in finish(), which always resolves ok() (exit 0), because a hook must never block or
// fail the agent's turn. readStdin is only invoked on the one branch that actually needs the
// payload (the stalled-child-message branch), exactly like the shell only calling `cat` there —
// reading stdin eagerly would risk blocking a caller whose stdin is a live terminal on every
// other branch.
export async function executeHookTurnEnd(
  args: readonly string[],
  environment: HookEnvironment,
  processAdapter: ProcessAdapter,
  readStdin: () => Promise<string>,
): Promise<Result<string>> {
  const defaultText = defaultResponseText(environment);
  const finish = (text: string): Result<string> => ok(`${text}\n`);

  try {
    // A caller with neither a terminal marker nor a real tmux pane exits here, cheaply, without
    // touching the filesystem or spawning a process — the common case for an unmanaged terminal.
    // A caller genuinely inside a tmux pane (TMUX and TMUX_PANE both set) also passes: a real tmux
    // dispatch's agent process never has SUPERSET_TERMINAL_ID/ORCA_TERMINAL_HANDLE (orchestrate-
    // spawn.ts's tmux launch line clears every CALLER_IDENTITY_ENV_VARS entry before starting it),
    // and neither does a coordinator itself running through the tmux-runtime module. From here,
    // computeSessionId and findChild already resolve a tmux caller by tmuxSession+tmuxPane.
    const hasTerminalMarker = present(environment.SUPERSET_TERMINAL_ID) || present(environment.ORCA_TERMINAL_HANDLE);
    const hasTmuxPane = present(environment.TMUX) && present(environment.TMUX_PANE);
    if (!hasTerminalMarker && !hasTmuxPane) {
      return finish(defaultText);
    }

    const root = resolveStateDirectory(environment);
    const session = await computeSessionId(environment, processAdapter);
    if (session === undefined) return finish(defaultText);

    const child = await findChild(root, environment, processAdapter);
    if ("kind" in child) {
      await hookParentNotify(root, session, environment, processAdapter);
      return finish(defaultText);
    }

    const dispatchId = child.dispatch;
    const database = stateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME });
    if (database.kind !== "ok") return finish(defaultText);
    const metaResult = getDispatch(database.value, dispatchId);
    const meta = metaResult.kind === "ok" ? metaResult.value : undefined;
    if (meta === undefined) return finish(defaultText);
    const state = typeof meta.state === "string" ? meta.state : "";

    const checkResult = await executeCheck(["--timeout", "0", "--poll-interval", "0", "--wait-mode", "poll", "--json"], environment, processAdapter, { acknowledge: false, excludedTransports: ["checked", "hook-notified"] });
    let messageCount = 0;
    let messageSeqs: number[] = [];
    if (checkResult.kind === "ok") {
      try {
        const parsed = JSON.parse(checkResult.value) as { readonly messages?: readonly unknown[]; readonly messageSeqs?: readonly unknown[] };
        messageCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0;
        messageSeqs = Array.isArray(parsed.messageSeqs) ? parsed.messageSeqs.filter((value): value is number => typeof value === "number") : [];
      } catch { messageCount = 0; }
    }
    if (messageCount > 0) {
      for (const sequence of messageSeqs) setDeliveryTransport(database.value, dispatchId, sequence, "hook-notified");
      if (environment.MEGABRAIN_HOOK_AGENT === "cursor") return finish('{"continue":true}');
      return finish('{"decision":"block","reason":"megabrain reply available; run megabrain check and act on it"}');
    }

    if (state === "waiting_for_reply" || state === "done" || state === "closed" || state === "orphaned") {
      return finish(defaultText);
    }

    const contextEffect = await applyContextPolicy(root, dispatchId, meta as RecordValue, environment, processAdapter);
    if (contextEffect.response !== null) return finish(contextEffect.response);
    if (contextEffect.handled) return finish(defaultText);

    const due = await stalledIsDue(root, dispatchId, meta as RecordValue, processAdapter);
    if (!due) return finish(defaultText);

    const payloadRaw = args[0] !== undefined && args[0] !== "" ? args[0] : await readStdin().catch(() => "");
    const { text: payloadText, transcriptPath } = parsePayload(payloadRaw);
    let text = payloadText;
    if (text === "" && transcriptPath !== "") text = await tailTranscript(transcriptPath);
    if (text === "") text = "child turn ended without ask or done";

    await appendMessage(root, dispatchId, "child", "stalled", text, session.id, environment, processAdapter);
    return finish(defaultText);
  } catch {
    // A hook must never fail or block the agent's turn (megabrain_hook_finish's contract):
    // whatever went wrong, print the same default response any other early bail would have.
    return finish(defaultText);
  }
}

export function readStdinText(): Promise<string> {
  return (async () => {
    let text = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) text += chunk;
    return text;
  })().catch(() => "");
}
