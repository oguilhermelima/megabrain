import { agentCommand, INTERACTIVE_AGENTS } from "../../adapters/agent-command.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { readAgentDefaults } from "../../core/agent-defaults.js";
import { failed, ok, type Result } from "../../core/result.js";
import { usageText } from "../../core/usage.js";

type Environment = Readonly<Record<string, string | undefined>>;

async function executeAgentDefaults(options: readonly string[], environment: Environment): Promise<Result<string>> {
  if (options.includes("-h") || options.includes("--help")) return ok(usageText("agent-defaults"));
  if (options.some((option) => option !== "--json")) return failed(usageText("agent-defaults").trimEnd(), 2);
  const report = await readAgentDefaults(environment);
  if (options.includes("--json")) return ok(`${JSON.stringify(report)}\n`);
  const lines = report.agents.map(({ agent, model, effort }) => {
    const parts = [model, effort].filter((part) => part !== null);
    return `${agent}: ${parts.length === 0 ? "agent default" : parts.join(" · ")}`;
  });
  return ok(`${[...lines, `shell: ${report.shell}`].join("\n")}\n`);
}

export async function executeAgent(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const [verb, agent, ...rest] = args;
  if (verb === "defaults") return executeAgentDefaults(args.slice(1), environment);
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
