import { usageStats, type UsageStats } from "../../adapters/usage-logs.js";
import { failed, ok, type Result } from "../../core/result.js";
import { usageText } from "../../core/usage.js";
import { USAGE_PROVIDERS, type UsageProvider } from "../../core/usage-stats.js";

type Environment = Readonly<Record<string, string | undefined>>;

const number = (value: number) => Math.round(value).toLocaleString("en-US");
const dollars = (value: number | null) => (value === null ? "no price" : `$${value.toFixed(2)}`);

function summary(report: UsageStats): string {
  const range = report.range.days === null ? `all time (since ${report.range.from ?? report.range.to})` : `last ${report.range.days} days (${report.range.from} to ${report.range.to})`;
  const lines = [
    `Usage, ${range}, ${report.timeZone}`,
    `${number(report.totals.total)} tokens · est. ${dollars(report.totals.cost)} · ${report.totals.sessions} sessions · ${report.totals.turns} turns · ${report.activeDays} active days${report.cacheShare === null ? "" : ` · cache share ${Math.round(report.cacheShare * 100)}%`}`,
  ];
  if (report.bestDay !== null) lines.push(`Best day: ${report.bestDay.date}, ${number(report.bestDay.total)} tokens`);
  for (const provider of report.providers) {
    if (!provider.tracked) { lines.push(`  ${provider.provider.padEnd(7)} keeps no token counts`); continue; }
    lines.push(`  ${provider.provider.padEnd(7)} ${number(provider.total)} tokens  ${dollars(provider.cost)}  ${provider.sessions} sessions  ${provider.turns} turns${provider.lastModel === null ? "" : `  last ${provider.lastModel}`}`);
  }
  if (report.megabrain !== null) lines.push(`megabrain: ${report.megabrain.dispatches} dispatches, ${number(report.megabrain.agentSeconds / 3600)} agent hours, ${report.megabrain.chats} chats`);
  lines.push(`Prices as of ${report.prices.asOf}. ${report.prices.note}`);
  return `${lines.join("\n")}\n`;
}

/** `usage stats`: token usage from the agents' own logs, per day and provider. `now` is for tests. */
export async function executeUsage(args: readonly string[], environment: Environment, dependencies: { now?: Date } = {}): Promise<Result<string>> {
  const [verb, ...rest] = args;
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("usage-stats"));
  if (verb !== "stats") return failed(usageText("usage-stats").trimEnd(), 2);
  let days: number | null = null;
  let provider: UsageProvider | null = null;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") { json = true; continue; }
    if (arg !== "--days" && arg !== "--provider") return failed(`unknown usage stats option: ${arg}`, 2);
    const value = rest[index + 1];
    if (value === undefined || value.length === 0) return failed(`${arg} requires a value`, 2);
    index += 1;
    if (arg === "--days") {
      days = Number(value);
      if (!Number.isSafeInteger(days) || days < 1) return failed("--days must be a positive integer", 2);
    } else {
      const known = USAGE_PROVIDERS.find((id) => id === value);
      if (known === undefined) return failed(`unknown provider: ${value} (expected ${USAGE_PROVIDERS.join(", ")})`, 2);
      provider = known;
    }
  }
  const timeZone = environment.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const report = await usageStats(environment, { days, provider, now: dependencies.now ?? new Date(), timeZone });
  return ok(json ? `${JSON.stringify(report)}\n` : summary(report));
}
