import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

function updateInstructionFile(path: string, pointer: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let content = "";
  let mode = 0o600;
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`refusing to replace symbolic link: ${path}`);
    content = readFileSync(path, "utf8");
    mode = statSync(path).mode;
  }

  const lines = content.split("\n");
  const pointerIndex = lines.findIndex((line) => /^# megabrain recipes(?:\s|$)/.test(line));
  let next: string;
  if (pointerIndex >= 0) {
    let pointerInserted = false;
    const updatedLines: string[] = [];
    for (const line of lines) {
      if (line === pointer || /^# megabrain recipes(?:\s|$)/.test(line)) {
        if (!pointerInserted) updatedLines.push(pointer);
        pointerInserted = true;
      } else {
        updatedLines.push(line);
      }
    }
    next = updatedLines.join("\n");
  } else {
    const separator = content.length === 0 ? "" : content.endsWith("\n") ? "" : "\n";
    next = `${content}${separator}${pointer}\n`;
  }
  if (next === content) return;

  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, next, { mode });
    renameSync(temporary, path);
  } catch (cause: unknown) {
    try { unlinkSync(temporary); } catch { /* preserve the original failure */ }
    throw cause;
  }
}

export function installAgentInstructions(
  agents: readonly MachineAgent[],
  mode: "global" | "project" | "none",
  directories: MachineAgentDirectories,
  projectDirectory: string,
  pointer: string,
): string[] {
  if (mode === "none") return [];
  const targets = mode === "project"
    ? [join(projectDirectory, "AGENTS.md")]
    : agents.map((agent) => {
      const entry = directories[agent];
      if (entry === undefined) throw new Error(`could not resolve ${agent} configuration directory`);
      return entry.globalInstructions;
    });
  for (const target of targets) updateInstructionFile(target, pointer);
  return targets;
}
