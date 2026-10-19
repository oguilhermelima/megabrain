import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { addModel, formatModelList, loadAndPersistModelRegistry, readTemplateModels, refreshAgyModels, refreshCodexModels, refreshGrokModels, saveModelRegistry, type Model } from "../../core/model.js";
import { staleChainSteps, type StaleStep } from "../../core/chain.js";
import { failed, ok, type Result } from "../../core/result.js";
import { readConfig } from "./chain.js";
import { usageText } from "../../core/usage.js";

export type Environment = Readonly<Record<string, string | undefined>>;

function usage(key: "model" | "model-list" | "model-add" | "model-refresh"): string {
  return usageText(key);
}

function errorResult(message: string, exitCode = 1): Result<string> { return failed(message, exitCode); }

async function modelList(args: readonly string[], environment: Environment): Promise<Result<string>> {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return ok(usage("model-list"));
    else return errorResult(`unknown model list option: ${arg}`, 2);
  }
  const result = await loadAndPersistModelRegistry(environment);
  if (result.kind === "failed") return result;
  return ok(json ? result.raw.endsWith("\n") ? result.raw : `${result.raw}\n` : formatModelList(result.registry));
}

async function modelAdd(args: readonly string[], environment: Environment): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usage("model-add"));
  if (args.length < 2) return errorResult(usage("model-add"), 2);
  const agent = args[0] ?? "";
  const model = args[1] ?? "";
  let levels = "";
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--reasoning" || arg === "--reasonings" || arg === "--reasoning-levels" || arg === "--levels") {
      levels = args[index + 1] ?? "";
      if (levels.length === 0) return errorResult(`${arg} requires a value`, 2);
      index += 1;
    } else if (arg === "-h" || arg === "--help") return ok(usage("model-add"));
    else return errorResult(`unknown model add option: ${arg}`, 2);
  }
  const loaded = await loadAndPersistModelRegistry(environment);
  if (loaded.kind === "failed") return loaded;
  const result = addModel(loaded.registry, agent, model, levels, new Date().toISOString());
  if (result.kind === "invalid") return errorResult(result.message, result.message.includes("cannot be empty") ? 2 : 1);
  if (result.kind === "unknown") return errorResult("model operation is unknown");
  const saved = await saveModelRegistry(environment, result.value);
  if (saved.kind !== "ok") return errorResult(saved.error, saved.exitCode);
  return ok(`model added: ${agent}/${model}\n`);
}

/** The refresh result; names the chain steps the new registry left pointing at a model it no longer lists. */
function refreshResult(environment: Environment, agent: string, count: number, models: Parameters<typeof staleChainSteps>[1], asJson: boolean): Result<string> {
  const config = readConfig(environment);
  const stale: readonly StaleStep[] = config.kind === "ok" ? staleChainSteps(config.value, models).filter((entry) => entry.agent === agent) : [];
  const text = `model registry refreshed: ${agent} (${count} models)\n`;
  const result = ok(asJson ? `${JSON.stringify({ agent, models: count, staleSteps: stale })}\n` : text);
  if (stale.length === 0) return result;
  const lines = stale.map((entry) => `${entry.chain} step ${entry.step} (${entry.agent}/${entry.model})`).join(", ");
  return { ...result, stderr: `megabrain: ${stale.length} chain step${stale.length === 1 ? "" : "s"} now stale: ${lines}. Repair with: megabrain chain repair <chain> --step <n> --model <id>\n` };
}

/** Each agent's live models: codex and grok from their own caches, agy from its listing, claude from the shipped table. */
async function refreshedModels(agent: string, environment: Environment, processAdapter: ProcessAdapter, known: readonly Model[]): Promise<Result<readonly Model[]>> {
  const template = readTemplateModels(environment);
  const home = environment.HOME ?? "";
  if (agent === "claude") return ok(template.filter((model) => model.agent === "claude"));
  if (agent === "codex") {
    const cache = await readFile(join(home, ".codex", "models_cache.json"), "utf8").catch(() => undefined);
    if (cache === undefined) return failed("could not refresh codex models: ~/.codex/models_cache.json is missing; run codex once to create it");
    return ok(refreshCodexModels(cache, template, new Date().toISOString()));
  }
  if (agent === "grok") {
    const listed = await processAdapter.run("grok", ["models"]);
    if (listed.kind !== "ok") return failed("could not refresh grok models: grok models failed");
    const cache = await readFile(join(home, ".grok", "models_cache.json"), "utf8").catch(() => undefined);
    return ok(refreshGrokModels(listed.value.stdout, cache, known, new Date().toISOString(), template));
  }
  if (agent === "agy") {
    const listed = await processAdapter.run("agy", ["models"]);
    if (listed.kind !== "ok") return failed("could not refresh agy models: agy models failed");
    return ok(refreshAgyModels(listed.value.stdout, new Date().toISOString(), template));
  }
  return failed(`unknown agent: ${agent}`);
}

async function modelRefresh(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const agent = args[0] ?? "";
  if (agent === "-h" || agent === "--help") return ok(usage("model-refresh"));
  if (agent.length === 0) return errorResult(usage("model-refresh"), 2);
  let asJson = false;
  for (const arg of args.slice(1)) {
    if (arg === "--json") asJson = true;
    if (arg !== "--json" && arg !== "-h" && arg !== "--help") return errorResult(`unknown model refresh option: ${arg}`, 2);
    if (arg === "-h" || arg === "--help") return ok(usage("model-refresh"));
  }
  if (!["claude", "codex", "grok", "agy"].includes(agent)) return errorResult(`unknown agent: ${agent}`);
  const loaded = await loadAndPersistModelRegistry(environment);
  if (loaded.kind === "failed") return loaded;
  const refreshed = await refreshedModels(agent, environment, processAdapter, loaded.registry.models);
  if (refreshed.kind !== "ok") return refreshed;
  if (refreshed.value.length === 0) return errorResult(`could not refresh ${agent} models: the listing named no models`);
  const models = [...loaded.registry.models.filter((model) => model.agent !== agent), ...refreshed.value];
  const saved = await saveModelRegistry(environment, { ...loaded.registry, models });
  if (saved.kind !== "ok") return errorResult(saved.error, saved.exitCode);
  return refreshResult(environment, agent, refreshed.value.length, models, asJson);
}

export async function executeModel(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return modelList(rest, environment);
  if (subcommand === "add") return modelAdd(rest, environment);
  if (subcommand === "refresh") return modelRefresh(rest, environment, processAdapter);
  if (subcommand === "-h" || subcommand === "--help" || subcommand === undefined || subcommand.length === 0) return ok(usage("model"));
  return errorResult(`unknown model command: ${subcommand}`, 2);
}
