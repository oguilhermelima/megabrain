import { getAgent } from "../agents/index.js";
import { launchArgv, rawValue, shellArgument } from "../agents/types.js";
import { createProcessAdapter, type ProcessAdapter } from "./proc.js";

export const INTERACTIVE_AGENTS = ["claude", "codex", "grok", "agy"] as const;

export type AgentCommandSelection = Readonly<{ model?: string | null; effort?: string | null; resume?: string | null; base?: readonly string[] | null }>;

/** The built-in start words (executable, permission, startup) a person's own start command replaces. */
export function builtinStartCommand(agent: string): string[] {
  const flags = INTERACTIVE_AGENTS.some((id) => id === agent) ? getAgent(agent)?.flags : undefined;
  if (flags === undefined) throw new Error(`unknown agent: ${agent}`);
  return launchArgv(flags, null, null, rawValue);
}

// The argv that starts (or, with `resume`, resumes a session in) an agent's own TUI with its permission prompts skipped. Rejects when the
// agent is unknown or its CLI is not on PATH; it never starts the agent. `base` is the person's own start command.
export async function agentCommand(agent: string, options: AgentCommandSelection = {}, processAdapter: ProcessAdapter = createProcessAdapter()): Promise<string[]> {
  const flags = INTERACTIVE_AGENTS.some((id) => id === agent) ? getAgent(agent)?.flags : undefined;
  if (flags === undefined) throw new Error(`unknown agent: ${agent}`);
  const executable = options.base?.[0] ?? flags.executable;
  const probe = await processAdapter.run("sh", ["-c", `command -v ${shellArgument(executable)}`]);
  if (probe.kind !== "ok") throw new Error(`${agent} is not installed: ${executable} was not found on PATH`);
  return launchArgv(flags, options.model ?? null, options.effort ?? null, rawValue, options.resume ?? null, options.base ?? null);
}
