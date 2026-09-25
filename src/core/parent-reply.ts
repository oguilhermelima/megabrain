import { failed, ok, type Result } from "./result.js";
import { checkDispatchTransition } from "./dispatch-states.js";
import { usageText } from "./usage.js";

export type ParentReplyArguments = Readonly<{
  readonly dispatchId: string;
  readonly text: string;
  readonly json: boolean;
  readonly supersede: boolean;
}>;

export type SupersedeSummary = Readonly<{
  readonly queued: number;
  readonly delivered: number;
  readonly deliveredSequences: readonly number[];
}>;

export function parseParentReplyArgs(args: readonly string[]): Result<ParentReplyArguments> {
  const dispatchId = args[0] ?? "";
  if (dispatchId === "") return failed(usageText("orchestrate-reply"), 2);
  let text = "";
  let json = false;
  let supersede = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--text") text = args[++index] ?? "";
    else if (arg === "--supersede") supersede = true;
    else if (arg === "--json") json = true;
    else return failed(`unknown orchestrate reply option: ${arg}`, 2);
  }
  if (text === "") return failed("--text is required", 2);
  return ok({ dispatchId, text, json, supersede });
}

export function parseParentChangeArgs(args: readonly string[]): Result<ParentReplyArguments> {
  const dispatchId = args[0] ?? "";
  if (dispatchId === "") return failed(usageText("orchestrate-change"), 2);
  let text = "";
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--text") text = args[++index] ?? "";
    else if (arg === "--json") json = true;
    else return failed(`unknown orchestrate change option: ${arg}`, 2);
  }
  if (text === "") return failed("--text is required", 2);
  return ok({ dispatchId, text, json, supersede: true });
}

// Mirrors the shell's megabrain_dispatch_reply_state_allowed exactly: a reply is accepted only
// where the dispatch state machine (dispatch-states.ts) allows a dispatch:*->running transition.
// "done" has no such transition (dispatch:done only reaches done/failed/orphaned/closed), so
// unlike an ask or a check, a reply to a done dispatch is refused there too — there is no
// idempotent-no-op exception for it in the shell, and there must not be one here.
export function replyStateError(dispatch: string, state: string, change: boolean): string | undefined {
  const allowed = checkDispatchTransition("dispatch", state, "running").kind === "ok";
  if (allowed) return undefined;
  if (!change && ["done", "failed", "closed", "circuit_broken"].includes(state)) {
    return `dispatch ${dispatch} is settled in state ${state}; open a new dispatch for a reply`;
  }
  return `dispatch ${dispatch} cannot receive a ${change ? "change" : "reply"} in state ${state}`;
}

// Mirrors the state clause of the shell's megabrain_dispatch_meta_normalize (run on every meta
// read, before megabrain_dispatch_reply ever saw the state): "stalled" and "timeout" were
// persisted by older versions on the contract axis and are not themselves recognised transitions
// in dispatch-states.ts, so a caller that skips this and passes the raw value into
// replyStateError gets the generic "cannot receive a reply" refusal instead of the shell's
// accept-and-resume-to-running behaviour.
export function normalizeDispatchState(state: string): string {
  return state === "stalled" || state === "timeout" ? "running" : state;
}

export function supersedeDelivery(status: string, consumer: string | null, sequences: readonly number[], alreadySuperseded: boolean): SupersedeSummary {
  if (alreadySuperseded || (status !== "outstanding" && status !== "acknowledged" && status !== "fenced")) return { queued: 0, delivered: 0, deliveredSequences: [] };
  if (status === "outstanding" && (consumer === null || consumer === "")) return { queued: 1, delivered: 0, deliveredSequences: [] };
  return { queued: 0, delivered: 1, deliveredSequences: [...sequences] };
}

export function addSupersedeSummary(total: SupersedeSummary, next: SupersedeSummary): SupersedeSummary {
  return { queued: total.queued + next.queued, delivered: total.delivered + next.delivered, deliveredSequences: [...total.deliveredSequences, ...next.deliveredSequences] };
}
