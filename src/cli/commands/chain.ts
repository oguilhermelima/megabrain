import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { type ChainConfig } from "../../core/chain.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";

export type ChainEnvironment = Readonly<Record<string, string | undefined>>;
const emptyConfig: ChainConfig = { chains: {}, defaultSteps: [] };
function error(message: string, exitCode = 1): Result<string> { return failed(message, exitCode); }
function json(value: unknown): string { return JSON.stringify(value) + "\n"; }
function chainPath(environment: ChainEnvironment): string { return environment.MEGABRAIN_CHAIN_FILE ?? resolve(resolveStateDirectory(environment), "chains.json"); }
function readConfig(environment: ChainEnvironment): Result<ChainConfig> {
  const path = chainPath(environment); if (!existsSync(path)) return ok(emptyConfig);
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) return error(`chain file is not valid JSON: ${path}`);
    const config = value as Record<string, unknown>;
    if (typeof config.chains !== "object" || config.chains === null || !Array.isArray(config.defaultSteps)) return error(`chain file is not valid: ${path}`);
    return ok(value as ChainConfig);
  } catch (cause: unknown) { return error(cause instanceof Error ? cause.message : `could not read chain file: ${path}`); }
}
function validateConfig(config: ChainConfig, environment: ChainEnvironment): Result<ChainConfig> {
  const modelsPath = resolve(environment.MEGABRAIN_ROOT ?? process.cwd(), ".megabrain/models.json"); let models: Set<string> | undefined;
  let modelErrors = "";
  try { if (existsSync(modelsPath)) { const registry = JSON.parse(readFileSync(modelsPath, "utf8")); models = new Set((registry.models ?? []).map((entry: any) => `${entry.agent}/${entry.model}`)); } } catch { return error(`model registry is not valid JSON: ${modelsPath}`); }
  for (const [name, chain] of Object.entries(config.chains)) {
    if (typeof chain !== "object" || chain === null || typeof chain.steps !== "object" || !Array.isArray(chain.steps) || chain.steps.length === 0) return error(`invalid chain ${name}: steps must be a non-empty array`);
    for (const [index, step] of chain.steps.entries()) {
      if (typeof step !== "object" || step === null) return error(`invalid chain ${name} step ${index + 1}: expected an object`);
      const record = step as Record<string, unknown>; const bad = Object.keys(record).find((key) => !["agent", "model", "effort", "until", "unvalidated"].includes(key));
      if (bad) return error(`invalid chain ${name} step ${index + 1}: unsupported field ${bad}`);
      if (typeof record.agent !== "string" || typeof record.model !== "string") return error(`invalid chain ${name} step ${index + 1}: agent and model are required`);
      if (record.until !== undefined) {
        if (typeof record.until !== "object" || record.until === null || typeof (record.until as Record<string, unknown>).usedPercent !== "number" || typeof (record.until as Record<string, unknown>).window !== "string" || (record.until as Record<string, unknown>).onUnknown !== undefined && !["take", "skip"].includes(String((record.until as Record<string, unknown>).onUnknown))) return error(`invalid chain ${name} step ${index + 1}: until.onUnknown is invalid`);
      }
      if (models && record.unvalidated !== true && !models.has(`${record.agent}/${record.model}`)) modelErrors += `invalid chain ${name} step ${index + 1}: unknown model ${record.agent}/${record.model}\n`;
    }
  }
  if (modelErrors) return error(modelErrors.trim());
  return ok(config);
}
function usage(kind: "chain" | "list" | "limits"): string {
  if (kind === "chain") return "Usage: megabrain chain list|limits|add|edit|delete|run|repair ...\n";
  if (kind === "limits") return "Usage: megabrain chain limits [--json] [--enable <providers>] [--disable <providers>] [--notice-on|--notice-off] [--notice-interval <seconds>]\n";
  return `Usage: megabrain chain ${kind} [--json]\n`;
}
function formatList(config: ChainConfig, asJson: boolean): string {
  if (asJson) return json({ chains: Object.entries(config.chains).map(([name, value]) => ({ ...value, name })), defaultSteps: config.defaultSteps });
  const lines = ["NAME                 SELECTOR                             STEPS"];
  for (const [name, chain] of Object.entries(config.chains)) lines.push(`${name.padEnd(20)} ${JSON.stringify(chain.when ?? {}).padEnd(36)} ${chain.steps.length}`);
  return lines.join("\n") + "\n";
}
type LimitRow = { provider: string; window: string; status: string; usedPercent: number | null; resetsAt: string | null; source: string; fetchedAt: number | null; reason: string | null; bucket: string | null; reading: { kind: string; basis: string | null } | null };
function unknownLimit(provider: string, window: string, reason: string): LimitRow { return { provider, window, status: "unknown", usedPercent: null, resetsAt: null, source: "unknown", fetchedAt: null, reason: `${provider} ${window} window unknown (${reason})`, bucket: null, reading: null }; }
function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => { const path = resolve(directory, entry.name); return entry.isDirectory() ? filesUnder(path) : entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl") ? [path] : []; });
}
function codexRows(environment: ChainEnvironment): LimitRow[] {
  const directory = environment.MEGABRAIN_CODEX_SESSIONS_DIR ?? resolve(environment.HOME ?? "", ".codex/sessions");
  const now = Math.floor(Date.now() / 1000); const snapshots: { limits: Record<string, any>; mtime: number }[] = [];
  for (const path of filesUnder(directory)) {
    let mtime: number; try { mtime = Math.floor(statSync(path).mtimeMs / 1000); } catch { continue; }
    if (mtime < now - 604801) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) { try { const value = JSON.parse(line); const limits = value?.payload?.rate_limits ?? value?.rate_limits; if (limits && typeof limits === "object") snapshots.push({ limits, mtime }); } catch { /* malformed rollout lines are irrelevant */ } }
  }
  snapshots.sort((a, b) => b.mtime - a.mtime); const rows: LimitRow[] = [];
  let incomplete = false;
  for (const window of ["5h", "weekly"]) {
    const minutes = window === "5h" ? 300 : 10080; const chosen = snapshots.find((entry) => Object.values(entry.limits).some((value: any) => value?.window_minutes === minutes)) ?? snapshots[0];
    if (!chosen) { rows.push(unknownLimit("codex", window, "rollout has no rate limit snapshot")); continue; }
    let field = Object.entries(chosen.limits).find(([, value]: [string, any]) => value?.window_minutes === minutes)?.[0];
    if (!field) {
      const usable = Object.entries(chosen.limits).filter(([, value]: [string, any]) => typeof value?.window_minutes === "number");
      if (usable.length === 1) field = usable[0]?.[0];
    }
    const value: any = field ? chosen.limits[field] : undefined;
    if (!field || typeof value?.used_percent !== "number" || typeof value?.resets_at !== "number") { incomplete = true; rows.push(unknownLimit("codex", window, field ? `snapshot reports ${field} ${minutes} minutes but its usage data is incomplete` : "requested window is not present")); continue; }
    if (value.resets_at <= now) { rows.push(unknownLimit("codex", window, `recorded window has already reset at ${value.resets_at} and carries no information about the current window`)); continue; }
    rows.push({ provider: "codex", window, status: "current", usedPercent: value.used_percent, resetsAt: String(value.resets_at), source: "disk", fetchedAt: chosen.mtime, reason: `codex ${window} window at ${value.used_percent.toFixed(1)} percent`, bucket: "default", reading: { kind: "floor", basis: "last-recorded-turn" } });
  }
  if (incomplete) for (const row of rows) { row.status = "unknown"; row.usedPercent = null; row.resetsAt = null; row.source = "unknown"; row.fetchedAt = Math.floor(Date.now() / 1000); row.bucket = null; row.reading = null; }
  return rows;
}
function limits(environment: ChainEnvironment, asJson: boolean): string {
  const rows = [...codexRows(environment), unknownLimit("claude", "5h", "live provider is not enabled"), unknownLimit("claude", "weekly", "live provider is not enabled"), unknownLimit("agy", "5h", "live provider is not enabled"), unknownLimit("agy", "weekly", "live provider is not enabled")];
  if (asJson) return JSON.stringify(rows, null, 2) + "\n";
  const output = ["PROVIDER WINDOW   STATUS    USED         RESET        SOURCE   REASON"];
  for (const row of rows) output.push(`${row.provider.padEnd(8)} ${row.window.padEnd(8)} ${row.status.padEnd(9)} ${(row.usedPercent === null ? "-" : row.usedPercent).toString().padEnd(12)} ${(row.resetsAt ?? "-").padEnd(28)} ${row.source.padEnd(8)} ${row.reason ?? "-"}`);
  return output.join("\n") + "\n";
}
async function execute(args: readonly string[], environment: ChainEnvironment): Promise<Result<string>> {
  const [subcommand, ...rest] = args; let asJson = false;
  if (subcommand === "list") { for (const arg of rest) { if (arg === "--json") asJson = true; else if (arg === "-h" || arg === "--help") return ok(usage("list")); else return error(`unknown chain list option: ${arg}`, 2); } const config = readConfig(environment); if (config.kind !== "ok") return config; const valid = validateConfig(config.value, environment); return valid.kind === "ok" ? ok(formatList(valid.value, asJson)) : valid; }
  if (subcommand === "limits") { for (const arg of rest) { if (arg === "--json") asJson = true; else if (arg === "-h" || arg === "--help") return ok(usage("limits")); else return error(`unknown chain limits option: ${arg}`, 2); } const config = readConfig(environment); if (config.kind !== "ok") return config; const valid = validateConfig(config.value, environment); return valid.kind === "ok" ? ok(limits(environment, asJson)) : valid; }
  if (subcommand === "-h" || subcommand === "--help" || subcommand === undefined) return ok(usage("chain")); return error(`unknown chain command: ${subcommand}`, 2);
}
export async function executeChain(args: readonly string[], environment: ChainEnvironment, _processAdapter: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> { return execute(args, environment); }
