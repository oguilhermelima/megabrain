import { ok, type Result } from "../core/result.js";
import { unavailableKey, type InterruptKey } from "./types.js";

type InterruptAffordance = Readonly<{
  key: InterruptKey | null;
  sessionEnd: string;
  evidence: string;
}>;

// Keep built-in interrupt and session-ending behavior together. Screenshots are normalized test
// fixtures under tests/fixtures/interrupt-screens; never send a second interrupt key automatically.
export const INTERRUPT_AFFORDANCES: Readonly<Record<string, InterruptAffordance>> = {
  claude: { key: "Escape", sessionEnd: "not probed; one Escape stopped the turn and kept Claude alive", evidence: "Claude v2.1.302 live probe; Escape stopped sleep 60 and left the composer open" },
  codex: { key: "Escape", sessionEnd: "a second Ctrl+C exits the Codex session", evidence: "Codex v0.163.0 live screen: Working (19s • esc to interrupt); session-ending behavior supplied by coordinator" },
  grok: { key: "C-c", sessionEnd: "not probed; local run was blocked by the weekly usage limit", evidence: "coordinator reported Grok's running-turn hint as ctrl+c to interrupt; local v1.0.62 probe hit weekly limit" },
  agy: { key: null, sessionEnd: "not probed; local run stopped at the workspace trust prompt", evidence: "Antigravity CLI v1.4.2 trust screen; no trust choice was made" },
};

function liveInterruptHint(screen: string): InterruptKey | undefined {
  if (/\b(?:esc|escape)\s+to\s+interrupt\b/i.test(screen)) return "Escape";
  if (/\b(?:ctrl|control)\s*\+\s*c\s+to\s+interrupt\b/i.test(screen)) return "C-c";
  return undefined;
}

export function interruptKeyForAgent(agentId: string, screen = ""): Result<InterruptKey> {
  const hint = liveInterruptHint(screen);
  if (hint !== undefined) return ok(hint);
  const affordance = INTERRUPT_AFFORDANCES[agentId];
  return affordance?.key === null || affordance === undefined
    ? unavailableKey(agentId, "interrupt")
    : ok(affordance.key);
}
