import { failed, ok, type Result } from "./result.js";

export type StopArguments = Readonly<{ dispatchId: string; json: boolean }>;
export type StopDecision = "interrupt";

export function parseStopArgs(args: readonly string[]): Result<StopArguments> {
  const dispatchId = args[0] ?? "";
  if (dispatchId === "") return failed("Usage: megabrain orchestrate stop <dispatch-id> [--json]\n", 2);
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return ok({ dispatchId, json });
    else return failed(`unknown orchestrate stop option: ${arg}`, 2);
  }
  return ok({ dispatchId, json });
}

export function stopDecision(liveness: string, affordance: "known" | "unknown"): Result<StopDecision> {
  if (affordance === "unknown") return failed("interrupt affordance is unknown", 1);
  if (liveness === "pending-check") return failed("pending check frame: messages are waiting for the next tool call", 1);
  if (liveness !== "working") return failed(`${liveness}: agent is not working`, 1);
  return ok("interrupt");
}

export function stopOutput(dispatchId: string, result: string, json: boolean, reason = ""): string {
  const interrupted = result === "landed" || result === "queued";
  if (json) return `${JSON.stringify({ dispatchId, status: interrupted ? "interrupted" : "not-interrupted", result, interrupted, ...(interrupted ? {} : reason === "" ? {} : { reason }) }, null, 2)}\n`;
  return interrupted ? `interrupted: ${dispatchId}\nresult: ${result}\n` : `interrupted: false\nresult: ${result}${reason === "" ? "" : `: ${reason}`}\n`;
}
