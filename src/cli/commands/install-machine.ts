import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverAgentDirectories, type MachineAgent, type MachineAgentDirectories } from "../../core/agent-directories.js";

export { discoverAgentDirectories } from "../../core/agent-directories.js";

export function installAgentSkills(
  source: string,
  agents: readonly MachineAgent[],
  mode: "global" | "project" | "none",
  directories: MachineAgentDirectories,
  projectDirectory: string,
): string[] {
  if (mode === "none") return [];
  const installed: string[] = [];
  for (const agent of agents) {
    const entry = directories[agent];
    if (entry === undefined) throw new Error(`could not resolve ${agent} configuration directory`);
    const target = mode === "global" ? entry.globalSkill : join(projectDirectory, entry.projectSkill);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    installed.push(target);
  }
  return installed;
}
