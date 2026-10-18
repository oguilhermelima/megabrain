import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { readLimit, type LimitAgent, type LimitWindowName } from "../../core/chain-limits.js";
import type { ChainConfig } from "../../core/chain.js";
import { resolveStateDirectory } from "../../core/state.js";
import { readConfig } from "../../cli/commands/chain.js";
import type { Chat, ChatEvent } from "../store.js";
import type { InfoCommandData, InfoLimit } from "../info-command-data.js";
export type { InfoCommandData, InfoLimit } from "../info-command-data.js";

function validLimitRows(rows: readonly InfoLimit[]): InfoLimit[] {
  return rows.filter((row) => Number.isFinite(row.usedPercent) && typeof row.resetsAt === "string");
}
export function codexInfoLimits(rows: readonly InfoLimit[]): InfoLimit[] { return validLimitRows(rows); }
export function claudeInfoLimits(rows: readonly InfoLimit[]): InfoLimit[] { return validLimitRows(rows); }
export function grokInfoLimits(rows: readonly InfoLimit[]): InfoLimit[] { return validLimitRows(rows); }
export function agyInfoLimits(rows: readonly InfoLimit[]): InfoLimit[] { return validLimitRows(rows); }
/** Provider-specific entry point so future native chat adapters can wire in their existing readers. */
export function infoLimitsForAgent(agent: LimitAgent, rows: readonly InfoLimit[]): InfoLimit[] {
  switch (agent) {
    case "codex": return codexInfoLimits(rows);
    case "claude": return claudeInfoLimits(rows);
    case "grok": return grokInfoLimits(rows);
    case "agy": return agyInfoLimits(rows);
  }
}

function windowName(name: string): InfoLimit["window"] {
  if (name === "5h" || name === "weekly") return name;
  if (name === "monthly" || name.endsWith("-43200m")) return "monthly";
  return "other";
}

export async function readInfoLimits(agent: LimitAgent, config: ChainConfig, environment: Readonly<Record<string, string | undefined>>, stateDir: string, processAdapter: ProcessAdapter = createProcessAdapter(), model?: string): Promise<InfoLimit[]> {
  const windows: LimitWindowName[] = ["5h", "weekly"];
  const readings = await Promise.all(windows.map((window) => readLimit(agent, window, config, environment, processAdapter, stateDir, model)));
  const rows = readings.flatMap((reading) => reading.status === "unknown" ? [] : reading.result.windows.map((entry) => ({ label: entry.name, usedPercent: entry.usedPercent, resetsAt: entry.resetsAt, window: windowName(entry.name) })));
  return infoLimitsForAgent(agent, [...new Map(rows.map((row) => [`${row.label}\0${row.usedPercent}\0${row.resetsAt}\0${row.window}`, row])).values()]);
}

export async function infoCommandData(chat: Chat, environment: Readonly<Record<string, string | undefined>>, options: { processAdapter?: ProcessAdapter } = {}): Promise<InfoCommandData> {
  const data: InfoCommandData = {
    ...(chat.model ? { model: chat.model } : {}),
    ...(chat.effort ? { effort: chat.effort } : {}),
    ...(chat.approvals === undefined ? {} : { approvals: chat.approvals ? "on" : "off" }),
    ...(chat.cwd ? { cwd: chat.cwd } : {}),
    ...(chat.agentSessionId ? { session: { id: chat.agentSessionId } } : {}),
    ...(chat.usageTokens ? { tokens: chat.usageTokens } : {}),
  };
  if (typeof chat.contextTokens === "number" && typeof chat.contextWindow === "number" && chat.contextWindow > 0) {
    data.context = { used: chat.contextTokens, window: chat.contextWindow, percent: Math.round(chat.contextTokens / chat.contextWindow * 1000) / 10 };
  }
  const config = readConfig(environment);
  if (config.kind === "ok") {
    try {
      const limits = await readInfoLimits(chat.agent, config.value, environment, resolveStateDirectory(environment), options.processAdapter, chat.model ?? undefined);
      if (limits.length > 0) data.limits = limits;
    } catch { /* Limit providers are optional: unavailable readings stay absent. */ }
  }
  return data;
}

function number(value: number): string { return new Intl.NumberFormat("en-US").format(value); }
export function renderInfoCommand(command: string, data: InfoCommandData): string {
  const rows: string[] = [`${command.slice(1).toUpperCase()}`];
  if (data.model !== undefined) rows.push(`Model: ${data.model}`);
  if (data.effort !== undefined) rows.push(`Effort: ${data.effort}`);
  if (data.approvals !== undefined) rows.push(`Approvals: ${data.approvals}`);
  if (data.sandbox !== undefined) rows.push(`Sandbox: ${data.sandbox}`);
  if (data.cwd !== undefined) rows.push(`Directory: ${data.cwd}`);
  if (data.session !== undefined) rows.push(`Session: ${data.session.id}`);
  if (data.context !== undefined) rows.push(`Context: ${number(data.context.used)} / ${number(data.context.window)} tokens (${data.context.percent}%)`);
  if (data.session?.startedAt !== undefined) rows.push(`Started: ${data.session.startedAt}`);
  if (data.session?.turns !== undefined) rows.push(`Turns: ${data.session.turns}`);
  if (data.limits?.length) {
    rows.push("Limits:");
    for (const limit of data.limits) rows.push(`  ${limit.label}: ${limit.usedPercent}% used · resets ${limit.resetsAt}`);
  }
  if (data.tokens !== undefined) rows.push(`Tokens: ${number(data.tokens.input)} input, ${number(data.tokens.output)} output${data.tokens.cacheRead === undefined ? "" : `, ${number(data.tokens.cacheRead)} cache read`}${data.tokens.cacheWrite === undefined ? "" : `, ${number(data.tokens.cacheWrite)} cache write`}`);
  if (data.cost !== undefined) {
    rows.push(`Cost: ${data.cost.total} ${data.cost.currency}`);
    for (const model of data.cost.byModel ?? []) rows.push(`  ${model.model}: ${number(model.input)} input, ${number(model.output)} output, ${number(model.cacheRead)} cache read, ${number(model.cacheWrite)} cache write · ${model.cost} ${data.cost.currency}`);
  }
  return rows.join("\n");
}

export function commandOutputEvent(agent: Chat["agent"], command: string, data: InfoCommandData): ChatEvent {
  return {
    id: crypto.randomUUID(), at: new Date().toISOString(), kind: "command-output", command, agent,
    source: "megabrain", data, text: renderInfoCommand(command, data),
  };
}
