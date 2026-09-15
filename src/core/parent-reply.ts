import { failed, ok, type Result } from "./result.js";

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
  if (dispatchId === "") return failed("Usage: megabrain orchestrate reply <dispatch-id> --text <answer> [--supersede] [--json]\n", 2);
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
  if (dispatchId === "") return failed("Usage: megabrain orchestrate change <dispatch-id> --text <text> [--json]\n", 2);
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

export function replyStateError(dispatch: string, state: string, change: boolean): string | undefined {
  const allowed = ["spawning", "running", "waiting_for_reply", "orphaned", "done"].includes(state);
  if (allowed) return undefined;
  if (!change && ["failed", "closed", "circuit_broken"].includes(state)) {
    return `dispatch ${dispatch} is settled in state ${state}; open a new dispatch for a reply`;
  }
  return `dispatch ${dispatch} cannot receive a ${change ? "change" : "reply"} in state ${state}`;
}

export function supersedeDelivery(status: string, consumer: string | null, sequences: readonly number[], alreadySuperseded: boolean): SupersedeSummary {
  if (alreadySuperseded || (status !== "outstanding" && status !== "acknowledged" && status !== "fenced")) return { queued: 0, delivered: 0, deliveredSequences: [] };
  if (status === "outstanding" && (consumer === null || consumer === "")) return { queued: 1, delivered: 0, deliveredSequences: [] };
  return { queued: 0, delivered: 1, deliveredSequences: [...sequences] };
}

export function addSupersedeSummary(total: SupersedeSummary, next: SupersedeSummary): SupersedeSummary {
  return { queued: total.queued + next.queued, delivered: total.delivered + next.delivered, deliveredSequences: [...total.deliveredSequences, ...next.deliveredSequences] };
}

