export type ReconcileUpdates = Readonly<Record<string, string | number>>;
export type ReconcileResult = Readonly<{ outcome: string; updates: ReconcileUpdates }>;

/** Dispatch liveness follows the linked terminal. Terminal exit is final. */
export function reconcileDecision(meta: Readonly<Record<string, unknown>>, terminalStatus: "proven" | "missing" | "unknown", _parentStatus?: "alive" | "gone" | "unknown"): ReconcileResult {
  const state = typeof meta.state === "string" ? meta.state : "running";
  if (["closed", "done", "exited", "failed"].includes(state)) return { outcome: "unchanged", updates: {} };
  if (terminalStatus !== "missing") return { outcome: "running", updates: {} };
  const done = meta.childDone === true;
  const nextState = done ? "done" : "exited";
  const updates = {
    state: nextState,
    processState: done ? "succeeded" : "exited",
    terminalState: "missing",
    stage: "agent-exit",
    reason: done ? "child reported done" : "terminal process exited",
  };
  return { outcome: nextState, updates };
}
