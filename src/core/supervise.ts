export type SupervisionCause =
  | "usage-limit"
  | "auth-required"
  | "dialog-waiting"
  | "prompt-unsubmitted"
  | "process-exited"
  | "pane-gone"
  | "no-activity"
  | "unknown";

export type SupervisionFinding = Readonly<{
  cause: SupervisionCause;
  resetAt?: string;
  command?: string;
  exitCode?: number;
  lastLines?: string;
  worktreePath?: string;
  dirtyFiles?: readonly string[];
}>;

export type SupervisionEvidence = Readonly<{
  agent: string;
  frame: string;
  now: number;
  activityAt: number;
  paneExists: boolean;
  processAlive: boolean;
  promptUnsubmitted: boolean;
  exitCode?: number;
  worktreePath?: string;
  dirtyFiles?: readonly string[];
  idleMinutes?: number;
}>;

const RESET_PATTERNS = [
  /(?:try again|resets?)(?: at| after)?\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i,
  /(?:available|reset)\s+(?:again\s+)?(?:at\s+)?(\d{1,2}\s*(?:AM|PM))/i,
];

function usageLimit(frame: string): string | undefined {
  if (!/(?:you(?:'|’)ve hit your usage limit|usage limit reached|rate limit reached|weekly limit reached|you(?:'|’)ve reached your limit|limit reached)/i.test(frame)) return undefined;
  for (const pattern of RESET_PATTERNS) {
    const match = pattern.exec(frame);
    if (match?.[1] !== undefined) return match[1].replace(/\s+/g, " ").trim();
  }
  return "unknown reset time";
}

function visibleCommand(frame: string): string | undefined {
  const match = /(?:Working\s*\(|running\s+)([^)\n]+)/i.exec(frame);
  return match?.[1]?.trim();
}

function lastLines(frame: string): string | undefined {
  const lines = frame.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-3).join(" | ") || undefined;
}

export function classifySupervision(evidence: SupervisionEvidence): SupervisionFinding {
  if (!evidence.paneExists) return { cause: "pane-gone", worktreePath: evidence.worktreePath, dirtyFiles: evidence.dirtyFiles };
  if (!evidence.processAlive) return { cause: "process-exited", ...(evidence.exitCode === undefined ? {} : { exitCode: evidence.exitCode }), ...(lastLines(evidence.frame) === undefined ? {} : { lastLines: lastLines(evidence.frame) }), worktreePath: evidence.worktreePath, dirtyFiles: evidence.dirtyFiles };
  const resetAt = usageLimit(evidence.frame);
  if (resetAt !== undefined) return { cause: "usage-limit", resetAt };
  if (/API Error:[^\n]*(?:authentication|unauthorized)|authentication required|please log in|not logged in/i.test(evidence.frame)) return { cause: "auth-required" };
  if (/(?:trust this project|trust this folder|permission required|allow this command|do you want to allow|press enter to continue)/i.test(evidence.frame)) return { cause: "dialog-waiting" };
  if (evidence.promptUnsubmitted) return { cause: "prompt-unsubmitted" };
  const idleMs = (evidence.idleMinutes ?? 15) * 60_000;
  if (/(?:working\s*\(|esc to interrupt|·\s*(?:thinking|running))/i.test(evidence.frame) && evidence.now - evidence.activityAt >= idleMs) {
    return { cause: "no-activity", command: visibleCommand(evidence.frame) };
  }
  return { cause: "unknown" };
}

export function recommendationFor(finding: SupervisionFinding): string | undefined {
  switch (finding.cause) {
    case "usage-limit": return `Switch this lane to another agent or wait until ${finding.resetAt ?? "the reset"}.`;
    case "auth-required": return "Ask the operator to log in to the agent, then inspect the dispatch.";
    case "dialog-waiting": return "Please answer the dialog, or respawn this lane in the same worktree.";
    case "prompt-unsubmitted": return "The prompt was resubmitted automatically; inspect the dispatch to confirm it started.";
    case "process-exited":
    case "pane-gone": {
      const changes = finding.dirtyFiles ?? [];
      const detail = changes.length > 0 ? ` Uncommitted changes: ${changes.join(", ")}.` : "";
      return `You can respawn this lane in the same worktree.${detail}`;
    }
    case "no-activity": return `The agent is possibly hung${finding.command ? ` while ${finding.command}` : ""}. Inspect with orchestrate read before deciding whether to stop or change it.`;
    case "unknown": return undefined;
  }
}
