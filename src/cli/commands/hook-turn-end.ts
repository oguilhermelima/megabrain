import { readdir, readFile, stat } from "node:fs/promises";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { dispatchFile, dispatchPath, liveDispatchDirectories, resolveDispatchDirectory } from "../../adapters/dispatch-store.js";
import { checkDispatchTransition, openDispatchStates } from "../../core/dispatch-states.js";
import { resolveStateDirectory } from "../../core/state.js";
import { ok, type Result } from "../../core/result.js";
import { getTmux } from "../../hosts/tmux.js";
import { terminalStatus, type RecordValue } from "./orchestrate-terminal.js";
import { executeCheck, loadMessages } from "./check.js";
import { appendMessage, atomicJson, findChild, parentContextMatches, readJson, sendParentPointer, waiterIsActive, type QueueEnvironment } from "./queue-write.js";
import { continueRefusedChain } from "./chain-run.js";

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
  const resolved = await resolveDispatchDirectory(root, dispatchId);
  if (resolved.kind !== "ok") return false;
  const messages = await loadMessages(dispatchFile(resolved.value, "messages"));
  return messages.some((message) => message.from === "child" && message.type === "received");
}

// megabrain_dispatch_has_recent_child_activity: the newest child received/ask/done message's
// mtime, compared against MEGABRAIN_DISPATCH_LIVE_ACTIVITY_WINDOW_SECONDS (60, hardcoded in the
// shell too — not an environment override).
const LIVE_ACTIVITY_WINDOW_SECONDS = 60;

async function hasRecentChildActivity(root: string, dispatchId: string): Promise<boolean> {
  const resolved = await resolveDispatchDirectory(root, dispatchId);
  if (resolved.kind !== "ok") return false;
  const directory = dispatchFile(resolved.value, "messages");
  const names = await readdir(directory).catch(() => []);
  let latest = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = `${directory}/${name}`;
    const value = await readJson(path);
    if (value === undefined) continue;
    if (value.from !== "child" || (value.type !== "received" && value.type !== "ask" && value.type !== "done")) continue;
    const modified = await stat(path).then((entry) => Math.floor(entry.mtimeMs / 1000)).catch(() => undefined);
    if (modified !== undefined && modified > latest) latest = modified;
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
async function markLimitRefused(root: string, dispatchId: string, reason: string): Promise<boolean> {
  const path = await dispatchPath(root, dispatchId, "meta.json");
  const meta = await readJson(path);
  if (meta === undefined) return false;
  const state = typeof meta.state === "string" ? meta.state : "";
  const processState = typeof meta.processState === "string" ? meta.processState : "";
  if (checkDispatchTransition("dispatch", state, "failed").kind !== "ok") return false;
  if (checkDispatchTransition("process", processState, "failed").kind !== "ok") return false;
  const now = new Date().toISOString();
  await atomicJson(path, {
    ...meta,
    promptReceipt: "unknown",
    promptState: "failed",
    promptDeliveryReason: reason,
    state: "failed",
    processState: "failed",
    stage: "limit-refused",
    reason,
    reconcileOutcome: "limit-refused",
    updatedAt: now,
  });
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
  const directories = await liveDispatchDirectories(root);
  const doneIds: string[] = [];
  let doneFirstMeta: JsonRecord | undefined;

  for (const directory of directories) {
    const dispatchId = directory.slice(directory.lastIndexOf("/") + 1);
    if (dispatchId === "") continue;
    const meta = await readJson(`${directory}/meta.json`);
    if (meta === undefined) continue;
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
    const marked = await markLimitRefused(root, dispatchId, refusal.reason).catch(() => false);
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
    const meta = await readJson(await dispatchPath(root, dispatchId, "meta.json"));
    if (meta === undefined) return finish(defaultText);
    const state = typeof meta.state === "string" ? meta.state : "";

    const checkResult = await executeCheck(["--timeout", "0", "--poll-interval", "0", "--wait-mode", "poll", "--json"], environment, processAdapter);
    let messageCount = 0;
    if (checkResult.kind === "ok") {
      try {
        const parsed = JSON.parse(checkResult.value) as { readonly messages?: readonly unknown[] };
        messageCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0;
      } catch { messageCount = 0; }
    }
    if (messageCount > 0) {
      if (environment.MEGABRAIN_HOOK_AGENT === "cursor") return finish('{"continue":true}');
      return finish('{"decision":"block","reason":"megabrain reply available; run megabrain check and act on it"}');
    }

    if (state === "waiting_for_reply" || state === "done" || state === "closed" || state === "orphaned") {
      return finish(defaultText);
    }

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
