import { getAgent } from "../agents/index.js";
import { launchArgv, rawValue } from "../agents/types.js";
import { createProcessAdapter, type ProcessAdapter } from "./proc.js";

export const INTERACTIVE_AGENTS = ["claude", "codex", "grok", "agy"] as const;

export type AgentCommandSelection = Readonly<{ model?: string | null; effort?: string | null; resume?: string | null }>;

// The argv that starts (or, with `resume`, resumes a session in) an agent's own TUI with its permission prompts skipped. Rejects when the
// agent is unknown or its CLI is not on PATH; it never starts the agent.
export async function agentCommand(agent: string, options: AgentCommandSelection = {}, processAdapter: ProcessAdapter = createProcessAdapter()): Promise<string[]> {
  const flags = INTERACTIVE_AGENTS.some((id) => id === agent) ? getAgent(agent)?.flags : undefined;
  if (flags === undefined) throw new Error(`unknown agent: ${agent}`);
  const probe = await processAdapter.run("sh", ["-c", `command -v ${flags.executable}`]);
  if (probe.kind !== "ok") throw new Error(`${agent} is not installed: ${flags.executable} was not found on PATH`);
  return launchArgv(flags, options.model ?? null, options.effort ?? null, rawValue, options.resume ?? null);
}
