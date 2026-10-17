import { existsSync, lstatSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";import { randomUUID } from "node:crypto";import { join } from "node:path";import type { ProcessAdapter } from "../../../adapters/proc.js";import { failed, ok, type Result } from "../../../core/result.js";import { type AgentEnvironment, type MachineAgent } from "../../../core/agent-directories.js";
import { listOutput, hasAgyMegabrainImport } from "./selection.js";
export async function retireLegacyChannels(
  availableAgents: readonly MachineAgent[],
  processAdapter: ProcessAdapter,
  yes: boolean,
  confirm: ((message: string) => Promise<boolean>) | undefined,
): Promise<Result<string>> {
  const messages: string[] = [];
  for (const agent of availableAgents) {
    // Grok never had a megabrain plugin or marketplace; the skill is its first channel.
    if (agent === "grok") continue;
    const pluginOutput = await listOutput(processAdapter, agent, agent === "agy" ? ["plugin", "list"] : ["plugin", "list"]);
    const marketplaceOutput = agent === "agy" ? "" : await listOutput(processAdapter, agent, ["plugin", "marketplace", "list"]);
    const pluginFound = agent === "agy"
      ? hasAgyMegabrainImport(pluginOutput)
      : /megabrain(?:@megabrain-local|\s+installed\b)/i.test(pluginOutput);
    const marketplaceFound = /megabrain-local/i.test(marketplaceOutput);
    for (const [artifact, found] of [["plugin", pluginFound], ["marketplace", marketplaceFound]] as const) {
      if (!found) continue;
      const shouldRemove = yes || (confirm !== undefined && await confirm(`Remove the old ${agent} megabrain ${artifact}? The skill replaces it.`));
      if (!shouldRemove) {
        messages.push(`${agent} ${artifact} retained; rerun with --yes to remove it`);
        continue;
      }
      const args = artifact === "marketplace"
        ? ["plugin", "marketplace", "remove", "megabrain-local"]
        : agent === "claude"
          ? ["plugin", "uninstall", "megabrain@megabrain-local"]
          : agent === "codex"
            ? ["plugin", "remove", "megabrain@megabrain-local"]
            : ["plugin", "uninstall", "megabrain"];
      const removal = await processAdapter.run(agent, args);
      if (removal.kind !== "ok") return failed(`could not remove ${agent} megabrain ${artifact}: ${removal.error}`);
      messages.push(`${agent} ${artifact} removed`);
    }
  }
  return ok(messages.length === 0 ? "no legacy plugin registrations found\n" : `${messages.join("\n")}\n`);
}

export const legacyInstructionsHeading = "# megabrain recipes";

export function instructionLines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function lineContent(line: string): string {
  return line.replace(/\r?\n$/, "");
}

export function removeLegacyInstructionsHeading(path: string): "missing" | "absent" | "followed" | "removed" {
  if (!existsSync(path)) return "missing";
  if (lstatSync(path).isSymbolicLink()) throw new Error(`refusing to replace symbolic link: ${path}`);

  const content = readFileSync(path, "utf8");
  const lines = instructionLines(content);
  const headingIndex = lines.findIndex((line) => lineContent(line) === legacyInstructionsHeading);
  if (headingIndex < 0) return "absent";
  const trailingLines = lines.slice(headingIndex + 1);
  if (trailingLines.some((line) => lineContent(line).trim().length > 0)) return "followed";

  const removeBlankLine = trailingLines.length > 0 && lineContent(trailingLines[0] ?? "").trim().length === 0 ? 1 : 0;
  const next = removeBlankLine === 1
    ? [...lines.slice(0, headingIndex), ...lines.slice(headingIndex + 2)].join("")
    : [...lines.slice(0, headingIndex), ...lines.slice(headingIndex + 1)].join("");
  if (next === content) return "absent";

  const mode = statSync(path).mode;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, next, { mode });
    renameSync(temporary, path);
  } catch (cause: unknown) {
    try { unlinkSync(temporary); } catch { /* preserve the original failure */ }
    throw cause;
  }
  return "removed";
}

export async function retireLegacyInstructions(
  environment: AgentEnvironment,
  projectDirectory: string,
  yes: boolean,
  confirm: ((message: string) => Promise<boolean>) | undefined,
): Promise<Result<string>> {
  const home = environment.HOME;
  const targets = [
    ...(home === undefined || home.length === 0 ? [] : [join(home, ".codex", "AGENTS.md"), join(home, ".agy", "AGENTS.md")]),
    join(projectDirectory, "AGENTS.md"),
  ];
  const messages: string[] = [];
  try {
    for (const path of targets) {
      if (!existsSync(path)) continue;
      if (lstatSync(path).isSymbolicLink()) return failed(`refusing to replace symbolic link: ${path}`);
      const content = readFileSync(path, "utf8");
      if (!instructionLines(content).some((line) => lineContent(line) === legacyInstructionsHeading)) continue;

      const lines = instructionLines(content);
      const headingIndex = lines.findIndex((line) => lineContent(line) === legacyInstructionsHeading);
      const hasFollowingContent = lines.slice(headingIndex + 1).some((line) => lineContent(line).trim().length > 0);
      if (hasFollowingContent) {
        messages.push(`${path}: retained; content follows the heading`);
        continue;
      }

      const shouldRemove = yes || (confirm !== undefined && await confirm(`Remove the leftover "# megabrain recipes" line from ${path}?`));
      if (!shouldRemove) {
        messages.push(`${path}: legacy heading found; rerun with --yes to remove it`);
        continue;
      }
      const result = removeLegacyInstructionsHeading(path);
      if (result === "removed") messages.push(`${path}: legacy instructions heading removed`);
      else if (result === "followed") messages.push(`${path}: retained; content follows the heading`);
    }
  } catch (error: unknown) {
    return failed(error instanceof Error ? error.message : "could not retire legacy instructions heading");
  }
  return ok(messages.length === 0 ? "" : `${messages.join("\n")}\n`);
}

