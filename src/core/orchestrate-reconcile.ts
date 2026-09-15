export type ReconcileUpdates = Readonly<Record<string, string | number>>;
export type ReconcileResult = Readonly<{ outcome: string; updates: ReconcileUpdates }>;

type Meta = Readonly<Record<string, unknown>>;
const string = (value: unknown, fallback: string): string => typeof value === "string" ? value : fallback;
const number = (value: unknown, fallback: number): number => typeof value === "number" && Number.isInteger(value) ? value : fallback;

export function reconcileDecision(meta: Meta, terminalStatus: "proven" | "missing" | "unknown", parentStatus: "alive" | "gone" | "unknown"): ReconcileResult {
  const state = string(meta.state, "running");
  const processState = string(meta.processState, "running");
  if (state === "closed" || state === "circuit_broken") return { outcome: "unchanged", updates: {} };
  if (terminalStatus === "missing") {
    if (processState === "exited") return { outcome: "unchanged", updates: {} };
    if (processState === "running") return { outcome: "agent-exited", updates: { processState: "exited", terminalState: "missing", stage: "agent-exit", reason: "agent exited without reporting" } };
    const failures = number(meta.failureCount, 0) + 1;
    const nextState = failures >= 3 ? "circuit_broken" : "failed";
    const nextProcess = ["succeeded", "failed", "stopped", "abandoned"].includes(processState) ? undefined : "abandoned";
    return { outcome: "terminal-missing", updates: { state: nextState, ...(nextProcess === undefined ? {} : { processState: nextProcess }), terminalState: "missing", stage: "terminal-missing", reason: "terminal-missing", failureCount: failures } };
  }
  if (terminalStatus === "proven") {
    if (parentStatus === "gone") {
      const needsOrphan = ["starting", "start-unproven", "running", "stopping", "stop-unproven"].includes(processState);
      return { outcome: "orphaned", updates: { ...(needsOrphan ? { state: "orphaned" } : {}), terminalState: "retained", stage: "parent-missing", reason: "parent-missing" } };
    }
    if (parentStatus === "unknown") return { outcome: "parent-unproven", updates: { stage: "parent-unproven", reason: "parent-unproven" } };
    return { outcome: "adopted", updates: { ...(state === "spawning" || state === "orphaned" ? { state: "running" } : {}), ...(processState === "starting" || processState === "start-unproven" ? { processState: "running" } : {}), ...(meta.terminalState === "retained" ? { terminalState: "owned" } : {}), stage: "terminal-proven", reason: "identity-proven" } };
  }
  return { outcome: "identity-unproven", updates: { ...(processState === "starting" ? { processState: "start-unproven" } : {}), terminalState: "retained", stage: "identity-unproven", reason: "identity-unproven" } };
}

