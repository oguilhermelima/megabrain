import { join } from "node:path";

export type MachineAgent = "claude" | "codex" | "agy";
export type AgentDirectories = Readonly<{
  readonly config: string;
  readonly globalSkill: string;
  readonly projectSkill: string;
}>;
export type MachineAgentDirectories = Readonly<Partial<Record<MachineAgent, AgentDirectories>>>;
export type AgentEnvironment = Readonly<Record<string, string | undefined>>;

export function discoverAgentDirectories(environment: AgentEnvironment): MachineAgentDirectories {
  const home = environment.HOME;
  if (home === undefined || home.length === 0) return {};

  const claudeConfig = environment.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codexConfig = environment.CODEX_HOME || join(home, ".codex");
  // agy 1.2.x embeds its customization docs in the CLI binary: its configDir is the user's
  // .gemini/config directory, and skills live under configDir/skills. The binary documentation
  // names no environment override, so this path is derived from HOME.
  const agyConfig = join(home, ".gemini", "config");

  return {
    claude: {
      config: claudeConfig,
      globalSkill: join(claudeConfig, "skills", "megabrain", "SKILL.md"),
      projectSkill: join(".claude", "skills", "megabrain", "SKILL.md"),
    },
    codex: {
      config: codexConfig,
      globalSkill: join(codexConfig, "skills", "megabrain", "SKILL.md"),
      projectSkill: join(".agents", "skills", "megabrain", "SKILL.md"),
    },
    agy: {
      config: agyConfig,
      globalSkill: join(agyConfig, "skills", "megabrain", "SKILL.md"),
      projectSkill: join(".agents", "skills", "megabrain", "SKILL.md"),
    },
  };
}
