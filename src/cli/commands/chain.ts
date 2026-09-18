import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
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
function preserveStderr<T>(result: Result<T>, stderr: string | undefined): Result<T> {
  if (result.kind !== "ok" || stderr === undefined) return result;
  return { ...result, stderr };
}
function validatedOutput(valid: Result<ChainConfig>, value: string): Result<string> {
  if (valid.kind !== "ok") return valid;
  return preserveStderr(ok(value), valid.stderr);
}
function readConfig(environment: ChainEnvironment): Result<ChainConfig> {
  const path = chainPath(environment); if (!existsSync(path)) return ok(emptyConfig);
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) return error(`chain file is not valid JSON: ${path}`);
    const config = value as Record<string, unknown>;
    if (typeof config.chains !== "object" || config.chains === null || !Array.isArray(config.defaultSteps)) return error(`chain file is not valid: ${path}`);
    if (config.usageLimits !== undefined && (typeof config.usageLimits !== "object" || config.usageLimits === null || Array.isArray(config.usageLimits))) return ok(value as ChainConfig);
    const usage = config.usageLimits as Record<string, unknown> | undefined ?? {};
    const notice = (usage.notice && typeof usage.notice === "object" && !Array.isArray(usage.notice)) ? usage.notice as Record<string, unknown> : {};
    const normalized = { ...config, usageLimits: { liveProviders: [], cacheTtlSeconds: 30, timeoutSeconds: 5, notice: { enabled: false, intervalSeconds: 3600 }, ...usage, notice: { enabled: false, intervalSeconds: 3600, ...notice } } } as ChainConfig;
    if (JSON.stringify(normalized) !== JSON.stringify(value)) writeFileSync(path, JSON.stringify(normalized, null, 2) + "\n");
    return ok(normalized);
  } catch { return error(`chain file is not valid JSON: ${path}`); }
}
function validateConfig(config: ChainConfig, environment: ChainEnvironment): Result<ChainConfig> {
  const modelsPath = resolve(environment.MEGABRAIN_ROOT ?? process.cwd(), ".megabrain/models.json"); let models: Set<string> | undefined; let modelIds: ReadonlyArray<{ agent: string; model: string }> = []; let modelEntries: ReadonlyArray<any> = [];
  let modelErrors = ""; let registryNotice: string | undefined;
  try {
    if (existsSync(modelsPath)) {
      const registry = JSON.parse(readFileSync(modelsPath, "utf8")); modelEntries = registry.models ?? []; modelIds = modelEntries.map((entry: any) => ({ agent: entry.agent, model: entry.model })); models = new Set(modelIds.map((entry) => `${entry.agent}/${entry.model}`));
    } else {
      registryNotice = `megabrain: model registry not found at ${modelsPath}; model validation was skipped.\n`;
    }
  } catch { return error(`model registry is not valid JSON: ${modelsPath}`); }
  for (const [name, chain] of Object.entries(config.chains)) {
    if (typeof chain !== "object" || chain === null || typeof chain.steps !== "object" || !Array.isArray(chain.steps) || chain.steps.length === 0) return error(`invalid chain ${name}: steps must be a non-empty array`);
    for (const [index, step] of chain.steps.entries()) {
      if (typeof step !== "object" || step === null) return error(`invalid chain ${name} step ${index + 1}: expected an object`);
      const record = step as Record<string, unknown>; const bad = Object.keys(record).find((key) => !["agent", "model", "effort", "until", "unvalidated"].includes(key));
      if (bad) return error(`invalid chain ${name} step ${index + 1}: unsupported field ${bad}`);
      if (typeof record.agent !== "string" || record.agent.length === 0) return error(`invalid chain ${name} step ${index + 1}: agent is required`);
      if (typeof record.model !== "string" || record.model.length === 0) return error(`invalid chain ${name} step ${index + 1}: model is required`);
      if (record.until !== undefined) {
        if (typeof record.until !== "object" || record.until === null || typeof (record.until as Record<string, unknown>).usedPercent !== "number" || typeof (record.until as Record<string, unknown>).window !== "string" || (record.until as Record<string, unknown>).onUnknown !== undefined && !["take", "skip"].includes(String((record.until as Record<string, unknown>).onUnknown))) return error(`invalid chain ${name} step ${index + 1}: until.onUnknown is invalid`);
      }
      if (models && record.unvalidated !== true && !models.has(`${record.agent}/${record.model}`)) {
        modelErrors += `megabrain: unknown model '${record.model}' for agent '${record.agent}'. Valid model ids:\n`;
        for (const entry of modelIds) if (entry.agent === record.agent) modelErrors += `megabrain:   ${entry.model}\n`;
        modelErrors += `megabrain: invalid chain ${name} step ${index + 1}: model '${record.model}' is not registered for agent '${record.agent}'\n`;
      } else if (models && record.unvalidated !== true) {
        const entry = modelEntries.find((candidate) => candidate.agent === record.agent && candidate.model === record.model);
        const reasoning = entry?.reasoning ?? {};
        if (reasoning.separateAxis === true && typeof record.effort !== "string") modelErrors += `megabrain: model '${record.model}' for agent '${record.agent}' requires a separate reasoning level\n`;
        else if (reasoning.separateAxis === true && !reasoning.levels?.includes(record.effort)) modelErrors += `megabrain: model '${record.model}' for agent '${record.agent}' does not support reasoning level '${record.effort}'. Supported reasoning levels:\nmegabrain:   ${(reasoning.levels ?? ["none"]).join("\nmegabrain:   ")}\n`;
        else if (reasoning.separateAxis === false && record.effort !== undefined) modelErrors += `megabrain: model '${record.model}' for agent '${record.agent}' has effort as part of the model id; do not supply effort\n`;
        if (entry?.status === "retired" || entry?.status === "deprecated") process.stderr.write(`Warning: model '${record.model}' for agent '${record.agent}' is ${entry.status}${entry.retirementDate ? ` (retirement date: ${entry.retirementDate})` : ""}.\n`);
      }
    }
  }
  if (modelErrors) return error(modelErrors.trim());
  return preserveStderr(ok(config), registryNotice);
}
type ChainWrite = { readonly name: string; readonly definition?: Record<string, unknown>; readonly changed?: boolean };
function modelRegistry(environment: ChainEnvironment): Result<ReadonlyArray<{ agent: string; model: string; reasoning?: { separateAxis?: boolean; levels?: string[] } }>> {
  const path = resolve(environment.MEGABRAIN_ROOT ?? process.cwd(), ".megabrain/models.json");
  if (!existsSync(path)) return ok([]);
  try { const value = JSON.parse(readFileSync(path, "utf8")); return ok(value.models ?? []); }
  catch { return error(`model registry is not valid JSON: ${path}`); }
}
function validateWriteConfig(config: ChainConfig, environment: ChainEnvironment): Result<ChainConfig> { return validateConfig(config, environment); }
function writeConfig(config: ChainConfig, path: string): Result<ChainConfig> {
  try {
    const directory = resolve(path, ".."); mkdirSync(directory, { recursive: true }); const temp = mkdtempSync(resolve(directory, ".chains-write-")); const tempPath = resolve(temp, "chains.json");
    writeFileSync(tempPath, JSON.stringify(config, null, 2)); if (existsSync(path)) unlinkSync(path); renameSync(tempPath, path); return ok(config);
  } catch (cause: unknown) { return error(cause instanceof Error ? cause.message : `could not write chain file: ${path}`); }
}
function parseJson(value: string, label: string): Result<unknown> { try { return ok(JSON.parse(value)); } catch { return error(`chain ${label} has invalid JSON definition`); } }
function chainExists(config: ChainConfig, name: string): boolean { return Object.prototype.hasOwnProperty.call(config.chains, name); }
function validName(name: string): boolean { return /^[A-Za-z0-9._-]+$/.test(name); }
function addChain(args: readonly string[], environment: ChainEnvironment): Result<string> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usage("add"));
  const name = args[0]; if (!name) return error("Usage: megabrain chain add <name> --when <json> --steps <json> [--step <json>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--allow-unknown-model] [--json]", 2);
  if (!validName(name)) return error(`invalid chain name: ${name}`);
  let when: Record<string, unknown> = {}; let steps: unknown[] = []; let asJson = false; let allowUnknown = false;
  for (let i = 1; i < args.length; i += 1) { const arg = args[i]; if (arg === "--json") asJson = true; else if (arg === "--allow-unknown-model") allowUnknown = true; else if (["--when", "--steps", "--step", "--parent-agent", "--parent-model", "--parent-effort"].includes(arg)) {
    const value = args[++i]; if (value === undefined) return error(`${arg} requires a value`, 2);
    if (arg === "--when") { const parsed = parseJson(value, name); if (parsed.kind !== "ok" || typeof parsed.value !== "object" || parsed.value === null) return error(`chain ${name} has invalid JSON definition`); when = parsed.value as Record<string, unknown>; }
    else if (arg === "--steps") { const parsed = parseJson(value, name); if (parsed.kind !== "ok" || !Array.isArray(parsed.value)) return error(`chain ${name} has invalid JSON definition`); steps = parsed.value; }
    else if (arg === "--step") { const parsed = parseJson(value, name); if (parsed.kind !== "ok") return parsed as Result<string>; steps = [...steps, parsed.value]; }
    else { when = { ...when, [arg.slice(2).replaceAll("-", "") === "parentagent" ? "parentAgent" : arg.slice(2).replaceAll("-", "")] : value }; }
  } else return error(`unknown chain add option: ${arg}`, 2); }
  const read = readConfig(environment); if (read.kind !== "ok") return read; if (chainExists(read.value, name)) return error(`chain already exists: ${name}`);
  let definition: any = { when, steps };
  if (allowUnknown) definition = { ...definition, steps: steps.map((step: any) => ({ ...step, unvalidated: true })) };
  const valid = validateWriteConfig({ ...read.value, chains: { ...read.value.chains, [name]: definition } }, environment); if (valid.kind !== "ok") return valid;
  const written = writeConfig({ ...read.value, chains: { ...read.value.chains, [name]: definition } }, chainPath(environment)); if (written.kind !== "ok") return written;
  return preserveStderr(ok(asJson ? json({ ...definition, name }) : `chain added: ${name}\n`), valid.stderr);
}
function editChain(args: readonly string[], environment: ChainEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return Promise.resolve(ok(usage("edit")));
  const name = args[0]; if (!name) return Promise.resolve(error("Usage: megabrain chain edit <name> [--allow-unknown-model] [--json]", 2)); let asJson = false;
  for (const arg of args.slice(1)) { if (arg === "--json") asJson = true; else if (arg !== "--allow-unknown-model") return Promise.resolve(error(`unknown chain edit option: ${arg}`, 2)); }
  const read = readConfig(environment); if (read.kind !== "ok") return Promise.resolve(read); if (!chainExists(read.value, name)) return Promise.resolve(error(`chain not found: ${name}`));
  const path = chainPath(environment); const temp = resolve(mkdtempSync(resolve(path, "..")), "chains-edit.json"); writeFileSync(temp, readFileSync(path));
  const editor = environment.EDITOR ?? "vi";
  return processAdapter.run(editor, [temp]).then((result) => { if (result.kind !== "ok") return error(`editor failed while editing chain ${name}`); let edited: ChainConfig; try { edited = JSON.parse(readFileSync(temp, "utf8")); } catch { return error(`chain file is not valid JSON: ${path}`); } if (JSON.stringify(edited) === JSON.stringify(read.value)) return ok(asJson ? json({ changed: false, name }) : `chain unchanged: ${name}\n`); const valid = validateWriteConfig(edited, environment); if (valid.kind !== "ok") return valid; const written = writeConfig(edited, path); if (written.kind !== "ok") return written; return preserveStderr(ok(asJson ? json({ ...edited.chains[name], name, changed: true }) : `chain edited: ${name}\n`), valid.stderr); });
}
function deleteChain(args: readonly string[], environment: ChainEnvironment): Result<string> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usage("delete"));
  const name = args[0]; if (!name) return error("Usage: megabrain chain delete <name> [--json]", 2); const asJson = args.includes("--json"); if (args.slice(1).some((arg) => arg !== "--json")) return error(`unknown chain delete option: ${args.find((arg) => arg !== "--json")}`, 2);
  const read = readConfig(environment); if (read.kind !== "ok") return read; if (!chainExists(read.value, name)) return error(`chain not found: ${name}; available chains: ${Object.keys(read.value.chains).join(", ")}`); const config = { ...read.value, chains: Object.fromEntries(Object.entries(read.value.chains).filter(([key]) => key !== name)) }; const valid = validateWriteConfig(config, environment); if (valid.kind !== "ok") return valid; const written = writeConfig(config, chainPath(environment)); if (written.kind !== "ok") return written; return preserveStderr(ok(asJson ? json({ deleted: true, name }) : `chain deleted: ${name}\n`), valid.stderr);
}
function repairChain(args: readonly string[], environment: ChainEnvironment): Result<string> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usage("repair"));
  const name = args[0]; if (!name) return error("Usage: megabrain chain repair <name> --step <number> --model <id> [--effort <level>] [--json]", 2); let step = 0; let model = ""; let effort: string | undefined; let hasEffort = false; let asJson = false;
  for (let i = 1; i < args.length; i += 1) { const arg = args[i]; if (arg === "--json") asJson = true; else if (["--step", "--model", "--effort"].includes(arg)) { const value = args[++i]; if (!value) return error(`${arg} requires a value`, 2); if (arg === "--step") step = Number(value); else if (arg === "--model") model = value; else { effort = value; hasEffort = true; } } else return error(`unknown chain repair option: ${arg}`, 2); }
  if (!Number.isInteger(step) || step <= 0) return error("chain repair requires a positive --step number", 2); if (!model) return error("--model is required for chain repair", 2); const read = readConfig(environment); if (read.kind !== "ok") return read; const current: any = read.value.chains[name]?.steps?.[step - 1]; if (!current) return error(`chain step not found: ${name} step ${step}`); const replacement: any = { ...current, model }; if (hasEffort) replacement.effort = effort; else delete replacement.effort; const config: any = { ...read.value, chains: { ...read.value.chains, [name]: { ...read.value.chains[name], steps: read.value.chains[name].steps.map((entry, index) => index === step - 1 ? replacement : entry) } } }; const valid = validateWriteConfig({ ...config, chains: { [name]: { ...config.chains[name], steps: [replacement] } } }, environment); if (valid.kind !== "ok") return valid; const written = writeConfig(config, chainPath(environment)); if (written.kind !== "ok") return written; return preserveStderr(ok(asJson ? json({ repaired: true, chain: name, step, value: replacement }) : `chain repaired: ${name} step ${step}\n`), valid.stderr);
}
function usage(kind: "chain" | "list" | "limits" | "add" | "edit" | "delete" | "repair"): string {
  if (kind === "chain") return "Usage: megabrain chain list|limits|add|edit|delete|run|repair ...\n";
  if (kind === "limits") return "Usage: megabrain chain limits [--json] [--enable <providers>] [--disable <providers>] [--notice-on|--notice-off] [--notice-interval <seconds>]\n";
  if (kind === "add") return "Usage: megabrain chain add <name> --when <json> --steps <json> [--step <json>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--allow-unknown-model] [--json]\n";
  if (kind === "edit") return "Usage: megabrain chain edit <name> [--allow-unknown-model] [--json]\n";
  if (kind === "delete") return "Usage: megabrain chain delete <name> [--json]\n";
  if (kind === "repair") return "Usage: megabrain chain repair <name> --step <number> --model <id> [--effort <level>] [--json]\n";
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
async function execute(args: readonly string[], environment: ChainEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const [subcommand, ...rest] = args; let asJson = false;
  if (subcommand === "list") { for (const arg of rest) { if (arg === "--json") asJson = true; else if (arg === "-h" || arg === "--help") return ok(usage("list")); else return error(`unknown chain list option: ${arg}`, 2); } const config = readConfig(environment); if (config.kind !== "ok") return config; const valid = validateConfig(config.value, environment); return valid.kind === "ok" ? validatedOutput(valid, formatList(valid.value, asJson)) : valid; }
  if (subcommand === "limits") { for (const arg of rest) { if (arg === "--json") asJson = true; else if (arg === "-h" || arg === "--help") return ok(usage("limits")); else return error(`unknown chain limits option: ${arg}`, 2); } const config = readConfig(environment); if (config.kind !== "ok") return config; const valid = validateConfig(config.value, environment); return valid.kind === "ok" ? validatedOutput(valid, limits(environment, asJson)) : valid; }
  if (subcommand === "add") return Promise.resolve(addChain(rest, environment));
  if (subcommand === "edit") return editChain(rest, environment, processAdapter);
  if (subcommand === "delete") return Promise.resolve(deleteChain(rest, environment));
  if (subcommand === "repair") return Promise.resolve(repairChain(rest, environment));
  if (subcommand === "-h" || subcommand === "--help" || subcommand === undefined) return ok(usage("chain")); return error(`unknown chain command: ${subcommand}`, 2);
}
export async function executeChain(args: readonly string[], environment: ChainEnvironment, processAdapter: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> { return execute(args, environment, processAdapter); }
