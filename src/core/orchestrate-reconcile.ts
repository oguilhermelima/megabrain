export type ReconcileUpdates = Readonly<Record<string, string | number>>;
export type ReconcileResult = Readonly<{ outcome: string; updates: ReconcileUpdates }>;

/** Read legacy terminal markers through the one dispatch lifecycle state rule. */
export function dispatchStateFromMeta(meta: Readonly<Record<string, unknown>>): string {
  const state = typeof meta.state === "string" ? meta.state : "running";
  return meta.processState === "exited" || meta.terminalState === "retained" ||
    ["retained", "identity_unproven", "circuit_broken"].includes(state) || meta.stage === "identity-unproven" || meta.stage === "parent-missing"
    ? "exited"
    : state;
}

/** Dispatch liveness follows the linked terminal. Terminal exit is final. */
export function reconcileDecision(meta: Readonly<Record<string, unknown>>, terminalStatus: "proven" | "missing" | "unknown", _parentStatus?: "alive" | "gone" | "unknown"): ReconcileResult {
  const state = dispatchStateFromMeta(meta);
  if (["closed", "done", "exited", "failed"].includes(state)) return { outcome: "unchanged", updates: {} };
  if (terminalStatus === "unknown") return { outcome: "unchanged", updates: {} };
  if (terminalStatus === "proven") return { outcome: "running", updates: {} };
  const done = meta.childDone === true;
  const nextState = done ? "done" : "exited";
  const updates = {
    ...(done ? { state: "done" } : {}),
    processState: done ? "succeeded" : "exited",
    terminalState: "missing",
    stage: "agent-exit",
    reason: done ? "child reported done" : "terminal process exited",
  };
  return { outcome: nextState, updates };
}
