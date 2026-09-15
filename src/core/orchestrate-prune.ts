import { failed, ok, type Result } from "./result.js";

export const pruneStates = ["closed", "done", "failed", "orphaned", "circuit_broken"] as const;
export type PruneOptions = Readonly<{ olderThan: number; states: readonly string[]; mode: "archive" | "delete"; dryRun: boolean; json: boolean }>;
export type PruneDecision = Readonly<{ eligible: boolean; reason?: string; timestamp?: string }>;

export function parsePruneArgs(args: readonly string[]): Result<PruneOptions> {
  let olderThan = 7; let states = [...pruneStates] as string[]; let mode: "archive" | "delete" = "archive"; let dryRun = false; let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--older-than") { const value = args[++index]; if (value === undefined || !/^\d+$/.test(value)) return failed("--older-than must be a non-negative number of days", 2); olderThan = Number(value); }
    else if (arg === "--state") { const value = args[++index] ?? ""; if (value === "" || !/^[A-Za-z0-9_,-]+$/.test(value)) return failed(value === "" ? "--state must not be empty" : "--state must be a comma-separated list of dispatch states", 2); states = value.split(","); }
    else if (arg === "--archive") mode = "archive";
    else if (arg === "--delete") mode = "delete";
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return ok({ olderThan, states, mode, dryRun, json });
    else return failed(`unknown orchestrate prune option: ${arg}`, 2);
  }
  return ok({ olderThan, states, mode, dryRun, json });
}

export function pruneDecision(meta: Readonly<Record<string, unknown>>, options: PruneOptions, now: Date): PruneDecision {
  const state = typeof meta.state === "string" ? meta.state : "";
  if (!pruneStates.includes(state as typeof pruneStates[number])) return { eligible: false, reason: state === "" ? "state is missing or unknown" : `state ${state} is not terminal` };
  if (!options.states.includes(state)) return { eligible: false, reason: `state ${state} was not selected` };
  const timestamp = typeof meta.updatedAt === "string" && meta.updatedAt !== "" ? meta.updatedAt : typeof meta.createdAt === "string" && meta.createdAt !== "" ? meta.createdAt : undefined;
  if (timestamp === undefined) return { eligible: false, reason: "updatedAt and createdAt are missing" };
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return { eligible: false, reason: `invalid timestamp: ${timestamp}` };
  if (time > now.getTime() - options.olderThan * 86400000) return { eligible: false, reason: `younger than ${options.olderThan} days` };
  return { eligible: true, timestamp };
}
