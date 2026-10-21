import type { ProcessTable } from "./session-origin.js";

type SessionIdentity = Readonly<{ agent: string; id: string; processId?: number }>;
type DispatchIdentity = Readonly<Record<string, unknown>>;

const DISPATCH_SESSION_KEYS = ["agentThreadId", "agentSessionId", "grokSessionId", "codexSessionId"];

// A dispatch owns a session by its recorded session id, or by the session's process sitting in the agent process's tree. Never by time.
export function dispatchForSession<T extends DispatchIdentity>(session: SessionIdentity, dispatches: readonly T[], table: ProcessTable): T | null {
  const matches = dispatches.filter((dispatch) => dispatch.agent === session.agent);
  const exact = matches.find((dispatch) => DISPATCH_SESSION_KEYS.some((key) => dispatch[key] === session.id));
  if (exact !== undefined) return exact;
  const inTree = (agentPid: number): boolean => {
    const seen = new Set<number>();
    for (let current: number | undefined = session.processId; current !== undefined && current > 1 && !seen.has(current); current = table.get(current)?.ppid) {
      if (current === agentPid) return true;
      seen.add(current);
    }
    return false;
  };
  return matches.find((dispatch) => typeof dispatch.agentPid === "number" && inTree(dispatch.agentPid)) ?? null;
}
