import { routeResourceCommand } from "../../core/resource-commands.js";
import { ok, type Result } from "../../core/result.js";

type Environment = Readonly<Record<string, string | undefined>>;
type Payload = Record<string, unknown>;

function record(value: unknown): Payload | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Payload : undefined;
}

// Pre-tool hook for every agent megabrain installs it into. It reads the agent's tool call from
// stdin and, for a resource command, answers in that agent's own rewrite form; Claude, Codex and
// Grok take hookSpecificOutput.updatedInput, Agy takes overwrite. Anything else prints nothing
// (Agy: its neutral "ask"), and a hook never fails: bad input is treated as nothing to do.
export async function executeHookPreTool(_args: readonly string[], environment: Environment, readStdin: () => Promise<string>): Promise<Result<string>> {
  const agent = environment.MEGABRAIN_HOOK_AGENT ?? "";
  let payload: Payload | undefined;
  try { payload = record(JSON.parse(await readStdin())); } catch { payload = undefined; }

  if (agent === "agy") {
    // Agy requires a decision on every call. "ask" is the neutral one: it keeps Agy's own
    // permission rules, including Always Allow (Orca's Agy hook answers the same way).
    const command = record(record(payload?.toolCall)?.args)?.CommandLine;
    const route = typeof command === "string" ? routeResourceCommand(command) : undefined;
    const output = route === undefined ? { decision: "ask" }
      : route.action === "deny" ? { decision: "deny", reason: route.reason }
      : { decision: "ask", overwrite: { CommandLine: route.command } };
    return ok(`${JSON.stringify(output)}\n`);
  }
  if (payload === undefined) return ok("");

  if (agent === "claude" || agent === "codex" || agent === "grok") {
    const input = record(payload.tool_input);
    const command = input?.command;
    if (input === undefined || typeof command !== "string") return ok("");
    const route = routeResourceCommand(command);
    if (route === undefined) return ok("");
    // No permissionDecision on a rewrite: the agent's normal permission flow still applies.
    const output = route.action === "deny"
      ? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: route.reason }
      : { hookEventName: "PreToolUse", updatedInput: { ...input, command: route.command } };
    return ok(`${JSON.stringify({ hookSpecificOutput: output })}\n`);
  }
  return ok("");
}
