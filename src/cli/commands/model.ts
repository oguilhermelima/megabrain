import { writeFileSync } from "node:fs";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { addModel, formatModelList, loadModelRegistry, reasoningLevels, refreshAgyModels, validateReasoning } from "../../core/model.js";
import { failed, ok, type Result } from "../../core/result.js";
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
  const result = loadModelRegistry(environment);
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
  const loaded = loadModelRegistry(environment);
  if (loaded.kind === "failed") return loaded;
  const result = addModel(loaded.registry, agent, model, levels, new Date().toISOString());
  if (result.kind === "invalid") return errorResult(result.message, result.message.includes("cannot be empty") ? 2 : 1);
  if (result.kind === "unknown") return errorResult("model operation is unknown");
  writeFileSync(loaded.file, `${JSON.stringify(result.value, null, 2)}\n`);
  return ok(`model added: ${agent}/${model}\n`);
}

async function modelRefresh(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const agent = args[0] ?? "";
  if (agent === "-h" || agent === "--help") return ok(usage("model-refresh"));
  if (agent.length === 0) return errorResult(usage("model-refresh"), 2);
  for (const arg of args.slice(1)) {
    if (arg !== "--json" && arg !== "-h" && arg !== "--help") return errorResult(`unknown model refresh option: ${arg}`, 2);
    if (arg === "-h" || arg === "--help") return ok(usage("model-refresh"));
  }
  if (agent === "codex" || agent === "claude") return errorResult(`${agent} has no live model listing; its registry entries remain manually curated`);
  if (agent !== "agy") return errorResult(`unknown agent: ${agent}`);
  const loaded = loadModelRegistry(environment);
  if (loaded.kind === "failed") return loaded;
  const result = await processAdapter.run("agy", ["models"]);
  if (result.kind !== "ok") return errorResult("could not refresh agy models: agy models failed");
  const ids = result.value.stdout.split(/\s+/).map((id) => id.replace(/[^A-Za-z0-9_.-]/g, "")).filter((id) => /^(gemini|claude|gpt-oss)-[A-Za-z0-9_.-]+$/.test(id));
  const models = refreshAgyModels(ids, new Date().toISOString());
  if (models.length === 0) return errorResult("could not refresh agy models: agy models returned no model ids");
  writeFileSync(loaded.file, `${JSON.stringify({ ...loaded.registry, models: [...loaded.registry.models.filter((model) => model.agent !== "agy"), ...models] }, null, 2)}\n`);
  return ok(`model registry refreshed: agy (${models.length} models)\n`);
}

export async function executeModel(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return modelList(rest, environment);
  if (subcommand === "add") return modelAdd(rest, environment);
  if (subcommand === "refresh") return modelRefresh(rest, environment, processAdapter);
  if (subcommand === "-h" || subcommand === "--help" || subcommand === undefined || subcommand.length === 0) return ok(usage("model"));
  return errorResult(`unknown model command: ${subcommand}`, 2);
}
