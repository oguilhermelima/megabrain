import { agentCommand, builtinStartCommand, INTERACTIVE_AGENTS } from "../../adapters/agent-command.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { readAgentDefaults } from "../../core/agent-defaults.js";
import { readAgentSettings, startCommand } from "../../core/agent-settings.js";
import { join } from "node:path";
import { failed, ok, type Result } from "../../core/result.js";
import { usageText } from "../../core/usage.js";
import { runAgentUpdateLocked, runBackgroundAgentUpdate, scheduleAgentAutoUpdate, updateReportText, recordAgentUpdate, officialAgentVersion, type AgentVersionSource, type AgentUpdateId, type AgentUpdateReport } from "../../core/agent-update.js";

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

export async function executeAgent(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter, versionSource: AgentVersionSource = officialAgentVersion): Promise<Result<string>> {
  const [verb, ...tail] = args;
  const agent = tail[0]?.startsWith("-") ? undefined : tail.shift();
  const rest = tail;
  if (verb === "defaults") return executeAgentDefaults(args.slice(1), environment);
  if (verb === "update" && args.some((arg) => arg === "-h" || arg === "--help")) return ok(usageText("agent-update"));
  if (verb === "update") {
    const targets = agent === undefined || agent === "all" ? INTERACTIVE_AGENTS : INTERACTIVE_AGENTS.filter((id) => id === agent);
    if (targets.length === 0) return failed("agent update expects codex, claude, grok, agy or all", 2);
    const checkOnly = rest.includes("--check");
    const background = rest.includes("--background");
    const json = rest.includes("--json");
    if (agent === undefined && (!checkOnly || !json)) return failed("checking all agents needs --check --json", 2);
    if (rest.some((arg) => !["--check", "--background", "--json"].includes(arg))) return failed("unknown agent update option", 2);
    try {
      if (background) {
        if (targets.length !== 1) return failed("background update requires one agent", 2);
        await runBackgroundAgentUpdate(targets[0]!, processAdapter, environment);
        return ok("");
      }
      const reports: AgentUpdateReport[] = [];
      for (const target of targets) {
        try {
          const report = await runAgentUpdateLocked(target as AgentUpdateId, checkOnly, processAdapter, environment, versionSource);
          await recordAgentUpdate(report, environment);
          reports.push(report);
        } catch (cause) {
          const at = new Date().toISOString();
          const report: AgentUpdateReport = { agent: target, installed: null, latest: null, installKind: "unknown", status: "failed", checkedAt: at, lastAttempt: { at, ok: false, error: cause instanceof Error ? cause.message : String(cause) } };
          await recordAgentUpdate(report, environment);
          reports.push(report);
        }
      }
      if (json) return ok(`${JSON.stringify(agent === undefined ? { agents: reports } : reports.length === 1 ? reports[0] : reports)}\n`);
      return ok(reports.map((report) => updateReportText(report)).join(""));
    } catch (cause) {
      return failed(cause instanceof Error ? cause.message : String(cause), 1);
    }
  }
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
    void scheduleAgentAutoUpdate(agent as AgentUpdateId, environment, processAdapter).catch(() => undefined);
    const base = startCommand(await readAgentSettings(environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain")), agent);
    const argv = await agentCommand(agent, { model, effort, resume, base }, processAdapter);
    return ok(json ? `${JSON.stringify({ agent, argv, builtin: builtinStartCommand(agent) })}\n` : `${argv.join(" ")}\n`);
  } catch (cause: unknown) {
    return failed(cause instanceof Error ? cause.message : String(cause), 1);
  }
}
