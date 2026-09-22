import { checkDispatchTransition } from "./dispatch-states.js";

export type ReconcileUpdates = Readonly<Record<string, string | number>>;
export type ReconcileResult = Readonly<{ outcome: string; updates: ReconcileUpdates }>;

type Meta = Readonly<Record<string, unknown>>;
const string = (value: unknown, fallback: string): string => typeof value === "string" ? value : fallback;
const number = (value: unknown, fallback: number): number => typeof value === "number" && Number.isInteger(value) ? value : fallback;

function transitionsAllow(meta: Meta, updates: ReconcileUpdates): boolean {
  const fields = [
    ["dispatch", "state", "running"],
    ["process", "processState", "running"],
    ["terminal", "terminalState", "owned"],
  ] as const;
  for (const [axis, field, fallback] of fields) {
    const target = updates[field];
    if (typeof target !== "string") continue;
    const current = string(meta[field], fallback);
    if (checkDispatchTransition(axis, current, target).kind !== "ok") return false;
  }
  return true;
}

function accepted(meta: Meta, updates: ReconcileUpdates, result: ReconcileResult): ReconcileResult {
  return transitionsAllow(meta, updates) ? result : { outcome: "unchanged", updates: {} };
}

export function reconcileDecision(meta: Meta, terminalStatus: "proven" | "missing" | "unknown", parentStatus: "alive" | "gone" | "unknown"): ReconcileResult {
  const state = string(meta.state, "running");
  const processState = string(meta.processState, "running");
  if (state === "closed" || state === "circuit_broken") return { outcome: "unchanged", updates: {} };
  if (terminalStatus === "missing") {
    if (processState === "exited") return { outcome: "unchanged", updates: {} };
    if (processState === "running") {
      const updates = { processState: "exited", terminalState: "missing", stage: "agent-exit", reason: "agent exited without reporting" };
      return accepted(meta, updates, { outcome: "agent-exited", updates });
    }
    const failures = number(meta.failureCount, 0) + 1;
    const requestedState = failures >= 3 ? "circuit_broken" : "failed";
    // circuit_broken is an escalation from failed; a running dispatch must first record failed.
    const nextState = requestedState === "circuit_broken" && !transitionsAllow(meta, { state: requestedState }) ? "failed" : requestedState;
    const nextProcess = ["succeeded", "failed", "stopped", "abandoned"].includes(processState) ? undefined : "abandoned";
    const updates = { state: nextState, ...(nextProcess === undefined ? {} : { processState: nextProcess }), terminalState: "missing", stage: "terminal-missing", reason: "terminal-missing", failureCount: failures };
    return accepted(meta, updates, { outcome: "terminal-missing", updates });
  }
  if (terminalStatus === "proven") {
    if (parentStatus === "gone") {
      const needsOrphan = ["starting", "start-unproven", "running", "stopping", "stop-unproven"].includes(processState);
      const updates = { ...(needsOrphan ? { state: "orphaned" } : {}), terminalState: "retained", stage: "parent-missing", reason: "parent-missing" };
      return accepted(meta, updates, { outcome: "orphaned", updates });
    }
    if (parentStatus === "unknown") return { outcome: "parent-unproven", updates: { stage: "parent-unproven", reason: "parent-unproven" } };
    const updates = { ...(state === "spawning" || state === "orphaned" ? { state: "running" } : {}), ...(processState === "starting" || processState === "start-unproven" ? { processState: "running" } : {}), ...(meta.terminalState === "retained" ? { terminalState: "owned" } : {}), stage: "terminal-proven", reason: "identity-proven" };
    return accepted(meta, updates, { outcome: "adopted", updates });
  }
  const updates = { ...(processState === "starting" ? { processState: "start-unproven" } : {}), terminalState: "retained", stage: "identity-unproven", reason: "identity-unproven" };
  return accepted(meta, updates, { outcome: "identity-unproven", updates });
}
