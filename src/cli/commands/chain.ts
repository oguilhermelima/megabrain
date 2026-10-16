import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { chainUsageKeys, explainChains, validateChainRules, type ChainConfig, type ChainExplanation, type MatchContext, type RuleIssue } from "../../core/chain.js";
import { readLimit, type LimitAgent, type LimitReading, type LimitWindowName } from "../../core/chain-limits.js";
import { loadModelRegistry, modelRegistryPaths, validateReasoning, type Model } from "../../core/model.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { executeChainRun } from "./chain-run.js";
import { usageMessage, usageText } from "../../core/usage.js";

export type ChainEnvironment = Readonly<Record<string, string | undefined>>;
const emptyConfig: ChainConfig = { chains: {}, defaultSteps: [] };
function error<T = string>(message: string, exitCode = 1): Result<T> { return failed(message, exitCode); }
function json(value: unknown): string { return JSON.stringify(value) + "\n"; }
export function chainPath(environment: ChainEnvironment): string { return environment.MEGABRAIN_CHAIN_FILE ?? resolve(resolveStateDirectory(environment), "chains.json"); }
function preserveStderr<T>(result: Result<T>, stderr: string | undefined): Result<T> {
  if (result.kind !== "ok" || stderr === undefined) return result;
  return { ...result, stderr };
}
function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}
function isChainConfig(value: unknown): value is ChainConfig {
  const config = record(value);
  return config !== undefined && record(config.chains) !== undefined && Array.isArray(config.defaultSteps);
}
function validatedOutput(valid: Result<ChainConfig>, value: string): Result<string> {
  if (valid.kind !== "ok") return valid;
  return preserveStderr(ok(value), valid.stderr);
}
export function readConfig(environment: ChainEnvironment): Result<ChainConfig> {
  const path = chainPath(environment); if (!existsSync(path)) return ok(emptyConfig);
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) return error(`chain file is not valid JSON: ${path}`);
    if (!isChainConfig(value)) return error(`chain file is not valid: ${path}`);
    const config = value;
    if (config.usageLimits !== undefined && record(config.usageLimits) === undefined) return ok(config);
    const usage = record(config.usageLimits) ?? {};
    const notice = record(usage.notice) ?? {};
    const normalized: ChainConfig = { ...config, usageLimits: { liveProviders: [], cacheTtlSeconds: 60, timeoutSeconds: 5, ...usage, notice: { enabled: false, intervalSeconds: 3600, ...notice } } };
    if (JSON.stringify(normalized) !== JSON.stringify(value)) writeFileSync(path, JSON.stringify(normalized, null, 2) + "\n");
    return ok(normalized);
  } catch { return error(`chain file is not valid JSON: ${path}`); }
}
export function validateConfig(config: ChainConfig, environment: ChainEnvironment): Result<ChainConfig> {
  const { template: modelsPath } = modelRegistryPaths(environment); let models: Set<string> | undefined; let modelIds: ReadonlyArray<{ agent: string; model: string }> = []; let modelEntries: ReadonlyArray<Model> = [];
  let modelErrors = ""; let registryNotice: string | undefined;
  if (!existsSync(modelsPath)) {
    registryNotice = `megabrain: model registry not found at ${modelsPath}; model validation was skipped.\n`;
  } else {
    const loaded = loadModelRegistry(environment);
    if (loaded.kind === "failed") return error(loaded.error);
    modelEntries = loaded.registry.models; modelIds = modelEntries.map((entry) => ({ agent: entry.agent, model: entry.model })); models = new Set(modelIds.map((entry) => `${entry.agent}/${entry.model}`));
  }
  for (const [name, chain] of Object.entries(config.chains)) {
    if (typeof chain !== "object" || chain === null || typeof chain.steps !== "object" || !Array.isArray(chain.steps) || chain.steps.length === 0) return error(`invalid chain ${name}: steps must be a non-empty array`);
    const ruleIssues = validateChainRules(chain, models !== undefined && !chain.steps.every((step) => (step as Record<string, unknown>).unvalidated === true) ? modelEntries : undefined);
    if (ruleIssues.length > 0) return error(`invalid chain ${name}: ${ruleIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    for (const [index, step] of chain.steps.entries()) {
      if (typeof step !== "object" || step === null) return error(`invalid chain ${name} step ${index + 1}: expected an object`);
      const record = step as Record<string, unknown>; const bad = Object.keys(record).find((key) => !["agent", "model", "effort", "until", "when", "unvalidated"].includes(key));
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
        const reasoning = entry?.reasoning ?? { separateAxis: undefined, levels: undefined };
        if (reasoning.separateAxis === true && typeof record.effort !== "string") modelErrors += `megabrain: model '${record.model}' for agent '${record.agent}' requires a separate reasoning level\n`;
        else if (reasoning.separateAxis === true && !reasoning.levels?.includes(String(record.effort))) modelErrors += `megabrain: model '${record.model}' for agent '${record.agent}' does not support reasoning level '${record.effort}'. Supported reasoning levels:\nmegabrain:   ${(reasoning.levels ?? ["none"]).join("\nmegabrain:   ")}\n`;
        else if (reasoning.separateAxis === false && record.effort !== undefined) modelErrors += `megabrain: model '${record.model}' for agent '${record.agent}' has effort as part of the model id; do not supply effort\n`;
        const status = entry?.status; const retirementDate = entry?.retirementDate;
        if (status === "retired" || status === "deprecated") process.stderr.write(`Warning: model '${record.model}' for agent '${record.agent}' is ${status}${retirementDate ? ` (retirement date: ${String(retirementDate)})` : ""}.\n`);
      }
    }
  }
  if (modelErrors) return error(modelErrors.trim());
  return preserveStderr(ok(config), registryNotice);
}
type ChainWrite = { readonly name: string; readonly definition?: Record<string, unknown>; readonly changed?: boolean };
export function modelRegistry(environment: ChainEnvironment): Result<ReadonlyArray<Model>> {
  const { template } = modelRegistryPaths(environment);
  if (!existsSync(template)) return ok([]);
  const loaded = loadModelRegistry(environment);
  if (loaded.kind === "failed") return error(loaded.error);
  return ok(loaded.registry.models);
}
function validateWriteConfig(config: ChainConfig, environment: ChainEnvironment): Result<ChainConfig> { return validateConfig(config, environment); }
function writeConfig(config: ChainConfig, path: string): Result<ChainConfig> {
  try {
    const directory = resolve(path, ".."); mkdirSync(directory, { recursive: true }); const temporaryDirectory = mkdtempSync(resolve(directory, ".chains-write-")); const temporaryPath = resolve(temporaryDirectory, "chains.json");
    try { writeFileSync(temporaryPath, JSON.stringify(config, null, 2)); renameSync(temporaryPath, path); }
    finally { rmSync(temporaryDirectory, { recursive: true, force: true }); }
    return ok(config);
  } catch (cause: unknown) { return error(cause instanceof Error ? cause.message : `could not write chain file: ${path}`); }
}
function parseJson(value: string, label: string): Result<unknown> { try { return ok(JSON.parse(value)); } catch { return error(`chain ${label} has invalid JSON definition`); } }
function chainExists(config: ChainConfig, name: string): boolean { return Object.prototype.hasOwnProperty.call(config.chains, name); }
function validName(name: string): boolean { return /^[A-Za-z0-9._-]+$/.test(name); }
type ChainSaveOptions = Readonly<{ allowUnknownModel?: boolean }>;
type ChainInput = Readonly<{ when: unknown; steps: readonly unknown[]; priority?: number }>;
// Stored shape: priority 0 is the default and is never written.
function toDefinition(chain: ChainInput, allowUnknown: boolean): Record<string, unknown> {
  const steps = chain.steps.map((step) => allowUnknown && record(step) !== undefined ? { ...record(step), unvalidated: true } : step);
  return { when: chain.when, ...(chain.priority !== undefined && chain.priority !== 0 ? { priority: chain.priority } : {}), steps };
}
export function saveChain(name: string, chain: ChainInput, environment: ChainEnvironment, options: ChainSaveOptions = {}): Result<Record<string, unknown>> {
  if (!validName(name)) return error(`invalid chain name: ${name}`);
  const read = readConfig(environment); if (read.kind !== "ok") return read;
  const definition = toDefinition(chain, options.allowUnknownModel === true);
  const config = { ...read.value, chains: { ...read.value.chains, [name]: definition } } as unknown as ChainConfig;
  const valid = validateWriteConfig(config, environment); if (valid.kind !== "ok") return valid;
  const written = writeConfig(config, chainPath(environment)); if (written.kind !== "ok") return written;
  return preserveStderr(ok(definition), valid.stderr);
}
// Path-style validation of one chain without touching the file; the app's authority for its editor.
export function checkChain(chain: ChainInput, environment: ChainEnvironment, options: ChainSaveOptions = {}): Result<RuleIssue[]> {
  const unvalidated = options.allowUnknownModel === true;
  const { template } = modelRegistryPaths(environment); let registry: readonly Model[] | undefined;
  if (existsSync(template)) { const loaded = loadModelRegistry(environment); if (loaded.kind === "failed") return error(loaded.error); registry = loaded.registry.models; }
  const issues = [...validateChainRules(chain, unvalidated ? undefined : registry)];
  if (chain.steps.length === 0) issues.push({ path: "steps", message: "expected a non-empty array" });
  chain.steps.forEach((step, index) => {
    const path = `steps[${index}]`; const value = record(step);
    if (value === undefined) { issues.push({ path, message: "expected an object" }); return; }
    for (const key of Object.keys(value)) if (!["agent", "model", "effort", "until", "when", "unvalidated"].includes(key)) issues.push({ path: `${path}.${key}`, message: "unknown field" });
    if (typeof value.agent !== "string" || value.agent === "") issues.push({ path: `${path}.agent`, message: "agent is required" });
    if (typeof value.model !== "string" || value.model === "") issues.push({ path: `${path}.model`, message: "model is required" });
    if (value.until !== undefined) { const until = record(value.until); if (until === undefined || typeof until.usedPercent !== "number" || typeof until.window !== "string") issues.push({ path: `${path}.until`, message: "expected {usedPercent, window}" }); }
    if (registry === undefined || unvalidated || value.unvalidated === true || typeof value.agent !== "string" || typeof value.model !== "string") return;
    const reasoning = validateReasoning({ version: 1, models: [...registry] }, value.agent, value.model, typeof value.effort === "string" ? value.effort : undefined);
    if (reasoning.kind === "unknown") issues.push({ path: `${path}.model`, message: `unknown model "${value.model}" for agent "${value.agent}"` });
    else if (reasoning.kind === "invalid") issues.push({ path: `${path}.effort`, message: reasoning.message.split("\n")[0] });
  });
  return ok(issues);
}
function parsePriority(value: string): number | undefined { const priority = Number(value); return value.trim() !== "" && Number.isFinite(priority) ? priority : undefined; }
function dryRunReport(issues: readonly RuleIssue[], asJson: boolean): Result<string> {
  const body = { ok: issues.length === 0, errors: issues };
  return ok(asJson ? json(body) : issues.length === 0 ? "chain is valid\n" : issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n") + "\n", issues.length === 0 ? undefined : 2);
}
// `chain add` and `chain save` share parsing; add refuses an existing name and also accepts --step and the legacy --parent-* shorthands.
function writeChainCommand(verb: "add" | "save", args: readonly string[], environment: ChainEnvironment): Result<string> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usage(verb));
  const name = args[0]; if (!name) return error(verb === "add" ? usageMessage("chain-add") : "chain save requires a name", 2);
  if (!validName(name)) return error(`invalid chain name: ${name}`);
  let when: unknown; let steps: unknown[] | undefined; let priority: number | undefined; let asJson = false; let allowUnknown = false; let dryRun = false;
  const shorthand: Record<string, unknown> = {};
  const bad = () => error(`chain ${name} has invalid JSON definition`);
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") asJson = true; else if (arg === "--allow-unknown-model") allowUnknown = true; else if (arg === "--dry-run") dryRun = true;
    else if (["--when", "--steps", "--priority"].includes(arg) || (verb === "add" && ["--step", "--parent-agent", "--parent-model", "--parent-effort"].includes(arg))) {
      const value = args[++i]; if (value === undefined) return error(`${arg} requires a value`, 2);
      if (arg === "--priority") { priority = parsePriority(value); if (priority === undefined) return error("--priority needs a number", 2); }
      else if (arg.startsWith("--parent-")) shorthand[arg === "--parent-agent" ? "parentAgent" : arg === "--parent-model" ? "parentModel" : "parentEffort"] = value;
      else { const parsed = parseJson(value, name); if (parsed.kind !== "ok") return parsed as Result<string>;
        if (arg === "--when") { if (record(parsed.value) === undefined) return bad(); when = parsed.value; }
        else if (arg === "--step") steps = [...(steps ?? []), parsed.value];
        else { if (!Array.isArray(parsed.value)) return bad(); steps = parsed.value; } }
    } else return error(`unknown chain ${verb} option: ${arg}`, 2);
  }
  if (verb === "save" && (when === undefined || steps === undefined)) return error("chain save requires --when and --steps", 2);
  const chain: ChainInput = { when: when === undefined ? shorthand : { ...record(when), ...shorthand }, steps: steps ?? [], priority };
  if (dryRun) { const checked = checkChain(chain, environment, { allowUnknownModel: allowUnknown }); return checked.kind === "ok" ? dryRunReport(checked.value, asJson) : checked; }
  if (verb === "add") { const read = readConfig(environment); if (read.kind !== "ok") return read; if (chainExists(read.value, name)) return error(`chain already exists: ${name}`); }
  const saved = saveChain(name, chain, environment, { allowUnknownModel: allowUnknown }); if (saved.kind !== "ok") return saved;
  return preserveStderr(ok(asJson ? json({ ...saved.value, name }) : `chain ${verb === "add" ? "added" : "saved"}: ${name}\n`), saved.stderr);
}
const addChain = (args: readonly string[], environment: ChainEnvironment): Result<string> => writeChainCommand("add", args, environment);
const saveChainCommand = (args: readonly string[], environment: ChainEnvironment): Result<string> => writeChainCommand("save", args, environment);

type StepPatch = Readonly<{ agent?: string; model?: string; effort?: string; until?: unknown; when?: unknown }>;
function chainAndStep(name: string, index: number, environment: ChainEnvironment): Result<{ config: ChainConfig; steps: unknown[] }> {
  const read = readConfig(environment); if (read.kind !== "ok") return read;
  if (!chainExists(read.value, name)) return error(`chain not found: ${name}`);
  const steps = [...read.value.chains[name].steps];
  if (!Number.isInteger(index) || index < 1 || index > steps.length) return error(`chain step not found: ${name} step ${index}; steps are numbered 1 to ${steps.length}`);
  return ok({ config: read.value, steps });
}
function persistSteps(name: string, config: ChainConfig, steps: unknown[], environment: ChainEnvironment): Result<ChainConfig> {
  const next = { ...config, chains: { ...config.chains, [name]: { ...config.chains[name], steps } } } as unknown as ChainConfig;
  const valid = validateWriteConfig(next, environment); if (valid.kind !== "ok") return valid;
  return preserveStderr(writeConfig(next, chainPath(environment)), valid.stderr);
}
// Steps are numbered from 1. In a patch, `until: null` / `when: null` remove the field.
export function editStep(name: string, index: number, patch: StepPatch, environment: ChainEnvironment): Result<Record<string, unknown>> {
  const found = chainAndStep(name, index, environment); if (found.kind !== "ok") return found;
  const next: Record<string, unknown> = { ...record(found.value.steps[index - 1]) };
  for (const [key, value] of Object.entries(patch)) { if (value === undefined) continue; if (value === null) delete next[key]; else next[key] = value; }
  const steps = found.value.steps.map((step, offset) => offset === index - 1 ? next : step);
  const saved = persistSteps(name, found.value.config, steps, environment); return saved.kind === "ok" ? preserveStderr(ok(next), saved.stderr) : saved;
}
export function moveStep(name: string, from: number, to: number, environment: ChainEnvironment): Result<readonly unknown[]> {
  const found = chainAndStep(name, from, environment); if (found.kind !== "ok") return found;
  if (!Number.isInteger(to) || to < 1 || to > found.value.steps.length) return error(`chain step position out of range: ${to}; steps are numbered 1 to ${found.value.steps.length}`);
  const steps = [...found.value.steps]; const [moved] = steps.splice(from - 1, 1); steps.splice(to - 1, 0, moved);
  const saved = persistSteps(name, found.value.config, steps, environment); return saved.kind === "ok" ? preserveStderr(ok(steps), saved.stderr) : saved;
}
function stepCommand(args: readonly string[], environment: ChainEnvironment): Result<string> {
  const [verb, name, ...rest] = args; if (verb === "-h" || verb === "--help" || verb === undefined) return ok(usageText("chain-step"));
  if (verb !== "edit" && verb !== "move") return error(`unknown chain step command: ${verb}`, 2);
  if (!name) return error(usageMessage("chain-step"), 2);
  const numbers = verb === "edit" ? 1 : 2; const positions = rest.slice(0, numbers).map(Number);
  if (rest.length < numbers || positions.some((position) => !Number.isInteger(position))) return error(usageMessage("chain-step"), 2);
  let asJson = false; const patch: Record<string, unknown> = {};
  for (let i = numbers; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--json") asJson = true;
    else if (verb === "edit" && ["--agent", "--model", "--effort"].includes(arg)) { const value = rest[++i]; if (value === undefined) return error(`${arg} requires a value`, 2); patch[arg.slice(2)] = value; }
    else if (verb === "edit" && (arg === "--until" || arg === "--when")) { const value = rest[++i]; if (value === undefined) return error(`${arg} requires a value`, 2); const parsed = parseJson(value, name); if (parsed.kind !== "ok") return parsed as Result<string>; patch[arg.slice(2)] = parsed.value; }
    else if (verb === "edit" && (arg === "--no-until" || arg === "--no-when")) patch[arg.slice(5)] = null;
    else return error(`unknown chain step ${verb} option: ${arg}`, 2);
  }
  if (verb === "move") { const moved = moveStep(name, positions[0], positions[1], environment); return moved.kind === "ok" ? preserveStderr(ok(asJson ? json({ chain: name, steps: moved.value }) : `chain step moved: ${name} ${positions[0]} to ${positions[1]}\n`), moved.stderr) : moved; }
  if (Object.keys(patch).length === 0) return error("chain step edit needs at least one of --agent, --model, --effort, --until, --no-until, --when, --no-when", 2);
  const edited = editStep(name, positions[0], patch, environment); return edited.kind === "ok" ? preserveStderr(ok(asJson ? json({ chain: name, index: positions[0], step: edited.value }) : `chain step edited: ${name} step ${positions[0]}\n`), edited.stderr) : edited;
}

export type ExplainInput = Readonly<{ parentAgent?: string; parentModel?: string; parentEffort?: string; repo?: string; branch?: string; label?: string; now?: Date }>;
const limitProviders = ["codex", "claude", "agy", "grok"];
// Live usage for every usage condition the config mentions, read through the existing limits cache.
export async function usageForConfig(config: ChainConfig, environment: ChainEnvironment, processAdapter: ProcessAdapter): Promise<Map<string, number | undefined>> {
  const usage = new Map<string, number | undefined>(); const root = resolveStateDirectory(environment);
  for (const key of chainUsageKeys(config)) {
    const [provider, window] = key.split(":");
    if (!limitProviders.includes(provider) || (window !== "5h" && window !== "weekly")) { usage.set(key, undefined); continue; }
    const reading = await readLimit(provider as LimitAgent, window, config, environment, processAdapter, root);
    usage.set(key, reading.status === "current" ? reading.usedPercent : undefined);
  }
  return usage;
}
export function matchContext(input: ExplainInput, usage: ReadonlyMap<string, number | undefined>): MatchContext {
  const known = (value: string | undefined) => value === undefined || value === "" ? undefined : value;
  return { parent: { agent: known(input.parentAgent), model: known(input.parentModel), effort: known(input.parentEffort) }, repo: known(input.repo), branch: known(input.branch), label: known(input.label), usage, now: input.now };
}
export async function chainExplain(input: ExplainInput, environment: ChainEnvironment, processAdapter: ProcessAdapter = createProcessAdapter()): Promise<Result<ChainExplanation>> {
  const read = readConfig(environment); if (read.kind !== "ok") return read;
  return ok(explainChains(read.value, matchContext(input, await usageForConfig(read.value, environment, processAdapter))));
}
async function explainCommand(args: readonly string[], environment: ChainEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("chain-explain"));
  let asJson = false; const input: Record<string, string> = {}; const flags: Record<string, string> = { "--parent-agent": "parentAgent", "--parent-model": "parentModel", "--parent-effort": "parentEffort", "--repo": "repo", "--branch": "branch", "--label": "label" };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") asJson = true;
    else if (flags[arg] !== undefined) { const value = args[++i]; if (value === undefined) return error(`${arg} requires a value`, 2); input[flags[arg]] = value; }
    else return error(`unknown chain explain option: ${arg}`, 2);
  }
  const explained = await chainExplain(input, environment, processAdapter); if (explained.kind !== "ok") return explained;
  if (asJson) return ok(json(explained.value));
  const lines = explained.value.candidates.map((c) => `${c.matched ? "match " : "no    "} ${c.name} (priority ${c.priority}, specificity ${c.specificity})${c.matched ? "" : `: ${c.reasons.filter((r) => /not in|unknown|outside|needs/.test(r))[0] ?? "no match"}`}`);
  lines.push(`chosen: ${explained.value.chosen ?? "defaultSteps"}`);
  for (const step of explained.value.steps) lines.push(`  ${step.index}. ${String(step.step.agent)}/${String(step.step.model)}${step.skipped ? ` skipped (${step.reason})` : ""}`);
  return ok(lines.join("\n") + "\n");
}
function editChain(args: readonly string[], environment: ChainEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return Promise.resolve(ok(usage("edit")));
  const name = args[0]; if (!name) return Promise.resolve(error(usageMessage("chain-edit"), 2)); let asJson = false;
  for (const arg of args.slice(1)) { if (arg === "--json") asJson = true; else if (arg !== "--allow-unknown-model") return Promise.resolve(error(`unknown chain edit option: ${arg}`, 2)); }
  const read = readConfig(environment); if (read.kind !== "ok") return Promise.resolve(read); if (!chainExists(read.value, name)) return Promise.resolve(error(`chain not found: ${name}`));
  const path = chainPath(environment); const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "megabrain-chain-edit-")); const temp = resolve(temporaryDirectory, "chains-edit.json");
  try { writeFileSync(temp, readFileSync(path)); } catch (cause: unknown) { rmSync(temporaryDirectory, { recursive: true, force: true }); return Promise.resolve(error(cause instanceof Error ? cause.message : `could not prepare chain edit: ${path}`)); }
  const editor = environment.EDITOR ?? "vi";
  return processAdapter.run(editor, [temp]).then((result) => { if (result.kind !== "ok") return error(`editor failed while editing chain ${name}`); let edited: ChainConfig; try { edited = JSON.parse(readFileSync(temp, "utf8")); } catch { return error(`chain file is not valid JSON: ${path}`); } if (JSON.stringify(edited) === JSON.stringify(read.value)) return ok(asJson ? json({ changed: false, name }) : `chain unchanged: ${name}\n`); const valid = validateWriteConfig(edited, environment); if (valid.kind !== "ok") return valid; const written = writeConfig(edited, path); if (written.kind !== "ok") return written; return preserveStderr(ok(asJson ? json({ ...edited.chains[name], name, changed: true }) : `chain edited: ${name}\n`), valid.stderr); }).finally(() => { rmSync(temporaryDirectory, { recursive: true, force: true }); });
}
function deleteChain(args: readonly string[], environment: ChainEnvironment): Result<string> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usage("delete"));
  const name = args[0]; if (!name) return error(usageMessage("chain-delete"), 2); const asJson = args.includes("--json"); if (args.slice(1).some((arg) => arg !== "--json")) return error(`unknown chain delete option: ${args.find((arg) => arg !== "--json")}`, 2);
  const read = readConfig(environment); if (read.kind !== "ok") return read; if (!chainExists(read.value, name)) return error(`chain not found: ${name}; available chains: ${Object.keys(read.value.chains).join(", ")}`); const config = { ...read.value, chains: Object.fromEntries(Object.entries(read.value.chains).filter(([key]) => key !== name)) }; const valid = validateWriteConfig(config, environment); if (valid.kind !== "ok") return valid; const written = writeConfig(config, chainPath(environment)); if (written.kind !== "ok") return written; return preserveStderr(ok(asJson ? json({ deleted: true, name }) : `chain deleted: ${name}\n`), valid.stderr);
}
function repairChain(args: readonly string[], environment: ChainEnvironment): Result<string> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usage("repair"));
  const name = args[0]; if (!name) return error(usageMessage("chain-repair"), 2); let step = 0; let model = ""; let effort: string | undefined; let hasEffort = false; let asJson = false;
  for (let i = 1; i < args.length; i += 1) { const arg = args[i]; if (arg === "--json") asJson = true; else if (["--step", "--model", "--effort"].includes(arg)) { const value = args[++i]; if (!value) return error(`${arg} requires a value`, 2); if (arg === "--step") step = Number(value); else if (arg === "--model") model = value; else { effort = value; hasEffort = true; } } else return error(`unknown chain repair option: ${arg}`, 2); }
  if (!Number.isInteger(step) || step <= 0) return error("chain repair requires a positive --step number", 2); if (!model) return error("--model is required for chain repair", 2); const read = readConfig(environment); if (read.kind !== "ok") return read; const current: any = read.value.chains[name]?.steps?.[step - 1]; if (!current) return error(`chain step not found: ${name} step ${step}`); const replacement: any = { ...current, model }; if (hasEffort) replacement.effort = effort; else delete replacement.effort; const config: any = { ...read.value, chains: { ...read.value.chains, [name]: { ...read.value.chains[name], steps: read.value.chains[name].steps.map((entry, index) => index === step - 1 ? replacement : entry) } } }; const valid = validateWriteConfig({ ...config, chains: { [name]: { ...config.chains[name], steps: [replacement] } } }, environment); if (valid.kind !== "ok") return valid; const written = writeConfig(config, chainPath(environment)); if (written.kind !== "ok") return written; return preserveStderr(ok(asJson ? json({ repaired: true, chain: name, step, value: replacement }) : `chain repaired: ${name} step ${step}\n`), valid.stderr);
}
function usage(kind: "chain" | "list" | "limits" | "add" | "save" | "edit" | "delete" | "repair"): string {
  if (kind === "chain") return usageText("chain");
  if (kind === "limits") return usageText("chain-limits");
  if (kind === "add") return usageText("chain-add");
  if (kind === "save") return usageText("chain-save");
  if (kind === "edit") return usageText("chain-edit");
  if (kind === "delete") return usageText("chain-delete");
  if (kind === "repair") return usageText("chain-repair");
  return usageText(kind === "list" ? "chain-list" : "chain-repair");
}
function formatList(config: ChainConfig, asJson: boolean): string {
  if (asJson) return json({ chains: Object.entries(config.chains).map(([name, value]) => ({ ...value, name })), defaultSteps: config.defaultSteps });
  const lines = ["NAME                 SELECTOR                             STEPS"];
  for (const [name, chain] of Object.entries(config.chains)) lines.push(`${name.padEnd(20)} ${JSON.stringify(chain.when ?? {}).padEnd(36)} ${chain.steps.length}`);
  return lines.join("\n") + "\n";
}
type LimitRow = { provider: string; window: string; status: string; usedPercent: number | null; resetsAt: string | null; source: string; fetchedAt: number | null; reason: string | null; bucket: string | null; reading: { kind: string; basis: string | null } | null };
const limitAgents = ["codex", "claude", "agy", "grok"] as const;
const liveProviders = ["claude", "agy", "grok"] as const;
const limitWindows = ["5h", "weekly"] as const;
// Maps core/chain-limits.ts's LimitReading (the port of megabrain_chain_limit_read)
// onto the pre-existing LimitRow shape this command has always returned, so the
// swap to the shared reader is a behaviour fix (real per-window independence, real
// liveProviders gating, the shell's rollout-relevance window and scan cap) without
// changing `chain limits`' output shape. A window can carry more than one bucket
// (agy groups models by family) and this row shape only has room for one per
// (provider, window): it shows the bucket the reader answered for, the most used
// one when no model is given.
function rowFor(provider: LimitAgent, window: LimitWindowName, reading: LimitReading): LimitRow {
  if (reading.status === "unknown") {
    return { provider, window, status: "unknown", usedPercent: null, resetsAt: null, source: "unknown", fetchedAt: null, reason: reading.reason, bucket: null, reading: null };
  }
  const resultReading = reading.result.reading;
  return {
    provider, window, status: "current", usedPercent: reading.usedPercent, resetsAt: reading.resetsAt,
    source: reading.source, fetchedAt: reading.fetchedAt, reason: reading.reason,
    bucket: reading.bucket,
    reading: resultReading ? { kind: resultReading.kind, basis: resultReading.basis } : null,
  };
}
export async function readLimitRows(environment: ChainEnvironment, config: ChainConfig, processAdapter: ProcessAdapter): Promise<LimitRow[]> {
  const root = resolveStateDirectory(environment);
  // Providers read in parallel, each one's two windows in order: the windows share that provider's
  // on-disk cache (chain-limits.ts writes it after the first live fetch), so the second reuses the
  // first's fetch, while different providers share nothing and each can wait on its own network call.
  const perProvider = await Promise.all(
    limitAgents.map(async (provider) => {
      const rows: LimitRow[] = [];
      for (const window of limitWindows) {
        rows.push(rowFor(provider, window, await readLimit(provider, window, config, environment, processAdapter, root)));
      }
      return rows;
    }),
  );
  return perProvider.flat();
}
async function limits(environment: ChainEnvironment, asJson: boolean, config: ChainConfig, processAdapter: ProcessAdapter): Promise<string> {
  const rows = await readLimitRows(environment, config, processAdapter);
  if (asJson) return JSON.stringify(rows, null, 2) + "\n";
  const output = ["PROVIDER WINDOW   STATUS    USED         RESET        SOURCE   REASON"];
  for (const row of rows) output.push(`${row.provider.padEnd(8)} ${row.window.padEnd(8)} ${row.status.padEnd(9)} ${(row.usedPercent === null ? "-" : row.usedPercent).toString().padEnd(12)} ${(row.resetsAt ?? "-").padEnd(28)} ${row.source.padEnd(8)} ${row.reason ?? "-"}`);
  return output.join("\n") + "\n";
}
async function execute(args: readonly string[], environment: ChainEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const [subcommand, ...rest] = args; let asJson = false;
  if (subcommand === "list") { for (const arg of rest) { if (arg === "--json") asJson = true; else if (arg === "-h" || arg === "--help") return ok(usage("list")); else return error(`unknown chain list option: ${arg}`, 2); } const config = readConfig(environment); if (config.kind !== "ok") return config; const valid = validateConfig(config.value, environment); return valid.kind === "ok" ? validatedOutput(valid, formatList(valid.value, asJson)) : valid; }
  if (subcommand === "limits") return limitsCommand(rest, environment, processAdapter);
  if (subcommand === "add") return Promise.resolve(addChain(rest, environment));
  if (subcommand === "save") return Promise.resolve(saveChainCommand(rest, environment));
  if (subcommand === "explain") return explainCommand(rest, environment, processAdapter);
  if (subcommand === "step") return Promise.resolve(stepCommand(rest, environment));
  if (subcommand === "edit") return editChain(rest, environment, processAdapter);
  if (subcommand === "delete") return Promise.resolve(deleteChain(rest, environment));
  if (subcommand === "repair") return Promise.resolve(repairChain(rest, environment));
  if (subcommand === "run") return executeChainRun(rest, environment, processAdapter);
  if (subcommand === "-h" || subcommand === "--help" || subcommand === undefined) return ok(usage("chain")); return error(`unknown chain command: ${subcommand}`, 2);
}
type LimitSettings = { enable: string[]; disable: string[]; notice?: boolean; interval?: number };
function parseProviders(value: string | undefined, flag: string): Result<string[]> {
  if (value === undefined || value === "") return error(`chain limits ${flag} needs a comma-separated provider list`, 2);
  const providers = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const bad = providers.find((entry) => !(liveProviders as readonly string[]).includes(entry));
  return bad === undefined ? ok(providers) : error(`chain limits ${flag}: unknown live provider ${bad}; expected ${liveProviders.join(", ")}`, 2);
}
// --enable/--disable choose which providers `chain limits` and `chain run` may ask over the network
// (or through their CLI); codex is always read from disk and needs no opt-in.
async function limitsCommand(args: readonly string[], environment: ChainEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  let asJson = false; const settings: LimitSettings = { enable: [], disable: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") asJson = true;
    else if (arg === "-h" || arg === "--help") return ok(usage("limits"));
    else if (arg === "--enable" || arg === "--disable") { const parsed = parseProviders(args[index + 1], arg); if (parsed.kind !== "ok") return parsed; settings[arg === "--enable" ? "enable" : "disable"].push(...parsed.value); index += 1; }
    else if (arg === "--notice-on" || arg === "--notice-off") settings.notice = arg === "--notice-on";
    else if (arg === "--notice-interval") { const value = Number(args[index + 1]); if (!Number.isInteger(value) || value <= 0) return error("chain limits --notice-interval needs a positive number of seconds", 2); settings.interval = value; index += 1; }
    else return error(`unknown chain limits option: ${arg}`, 2);
  }
  const config = readConfig(environment); if (config.kind !== "ok") return config;
  let current = config.value;
  if (settings.enable.length > 0 || settings.disable.length > 0 || settings.notice !== undefined || settings.interval !== undefined) {
    const usageLimits = current.usageLimits ?? {};
    const providers = [...(usageLimits.liveProviders ?? []), ...settings.enable].filter((entry, index, all) => all.indexOf(entry) === index && !settings.disable.includes(entry));
    const notice = { ...(usageLimits.notice ?? {}), ...(settings.notice === undefined ? {} : { enabled: settings.notice }), ...(settings.interval === undefined ? {} : { intervalSeconds: settings.interval }) };
    current = { ...current, usageLimits: { ...usageLimits, liveProviders: providers, notice } };
    const written = writeConfig(current, chainPath(environment)); if (written.kind !== "ok") return written;
  }
  const valid = validateConfig(current, environment); if (valid.kind !== "ok") return valid;
  return validatedOutput(valid, await limits(environment, asJson, valid.value, processAdapter));
}
export async function executeChain(args: readonly string[], environment: ChainEnvironment, processAdapter: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> { return execute(args, environment, processAdapter); }
