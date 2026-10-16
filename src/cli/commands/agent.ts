import { agentCommand, INTERACTIVE_AGENTS } from "../../adapters/agent-command.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { usageText } from "../../core/usage.js";

export async function executeAgent(args: readonly string[], processAdapter: ProcessAdapter): Promise<Result<string>> {
  const [verb, agent, ...rest] = args;
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("agent-command"));
  if (verb !== "command" || agent === undefined || !INTERACTIVE_AGENTS.some((id) => id === agent)) return failed(usageText("agent-command").trimEnd(), 2);
  let model: string | null = null;
  let effort: string | null = null;
  let resume: string | null = null;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") json = true;
    else if (arg === "--model" || arg === "--effort" || arg === "--resume") {
      const value = rest[index + 1];
      if (value === undefined || value.length === 0) return failed(`${arg} requires a value`, 2);
      if (arg === "--model") model = value;
      else if (arg === "--effort") effort = value;
      else resume = value;
      index += 1;
    } else return failed(`unknown agent command option: ${arg}`, 2);
  }
  try {
    const argv = await agentCommand(agent, { model, effort, resume }, processAdapter);
    return ok(json ? `${JSON.stringify({ agent, argv })}\n` : `${argv.join(" ")}\n`);
  } catch (cause: unknown) {
    return failed(cause instanceof Error ? cause.message : String(cause), 1);
  }
}
