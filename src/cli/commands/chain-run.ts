import type { ProcessAdapter } from "../../adapters/proc.js";
import { dispatchPath } from "../../adapters/dispatch-store.js";
import { selectChain, type ChainConfig } from "../../core/chain.js";
import { markUsageNoticeSent, readLimit, resetDisplay, usageNoticeDue, usageNoticeReport, type LimitAgent, type LimitReading, type LimitWindowName } from "../../core/chain-limits.js";
import { resolveParentContext } from "../../core/context.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { readConfig, validateConfig, type ChainEnvironment } from "./chain.js";
import { executeSpawn } from "./orchestrate-spawn.js";
import { appendMessage, atomicJson, readJson } from "./queue-write.js";

// Ports lib/module-chain.sh's command_chain_run, megabrain_chain_walk, and
// megabrain_chain_run_spawn for the `chain run` CLI command. The shell versions of
// these three functions stay in the tree: hooks/megabrain-turn-end.sh reaches
// megabrain_chain_walk through megabrain_chain_continue_refused to resume a chain
// after a usage-limit refusal, so this is a second, TypeScript-side implementation
// of the same contract for the CLI entry point, not a replacement of the shell one.

export type ChainRunEnvironment = ChainEnvironment;

export type ChainRunDependencies = Readonly<{
  readonly spawn?: (args: readonly string[], environment: ChainRunEnvironment, processAdapter: ProcessAdapter) => Promise<Result<string>>;
}>;

type SkippedEntry = Readonly<{ readonly step: number; readonly agent: string; readonly kind: "limit" | "failure"; readonly reason: string }>;

type ParsedArgs = {
  explicitName: string | undefined;
  chainOption: string | undefined;
  selectionSource: "name" | "flag";
  parentAgent: string | undefined;
  parentModel: string | undefined;
  parentEffort: string | undefined;
  repo: string | undefined;
  branch: string | undefined;
  base: string | undefined;
  slug: string | undefined;
  worktree: string | undefined;
  prompt: string | undefined;
  label: string | undefined;
  tmuxChoice: string | undefined;
  json: boolean;
  browser: boolean;
  agentArgs: string[];
  help: boolean;
};

function usage(): string {
  return "Usage: megabrain chain run [name] [--chain <name>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--repo <name|path>] [--branch <branch>] [--base <ref>] [--name <slug>] [--worktree <path>] [--prompt <text>] [--label <text>] [--tmux true|false] [--browser] [--agent-arg <flag>] [--json]\n";
}

function errorLine(text: string): string {
  return `megabrain: ${text}\n`;
}

function okWithStderr(value: string, exitCode: number | undefined, stderr: string | undefined): Result<string> {
  const base = ok(value, exitCode);
  return stderr === undefined ? base : { ...base, stderr };
}

function parseArgs(args: readonly string[]): Result<ParsedArgs> {
  const parsed: ParsedArgs = {
    explicitName: undefined, chainOption: undefined, selectionSource: "name",
    parentAgent: undefined, parentModel: undefined, parentEffort: undefined,
    repo: undefined, branch: undefined, base: undefined, slug: undefined, worktree: undefined,
    prompt: undefined, label: undefined, tmuxChoice: undefined,
    json: false, browser: false, agentArgs: [], help: false,
  };
  let rest = args;
  if (rest[0] !== undefined && !rest[0].startsWith("--")) {
    parsed.explicitName = rest[0];
    rest = rest.slice(1);
  }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--chain") {
      const value = rest[index + 1];
      if (value === undefined || value === "") return failed("--chain requires a non-empty value", 2);
      if (parsed.explicitName !== undefined) return failed("chain run accepts either a positional chain name or --chain, not both", 2);
      parsed.chainOption = value;
      parsed.selectionSource = "flag";
      index += 1;
    } else if (arg === "--parent-agent") { parsed.parentAgent = rest[index + 1] ?? ""; index += 1; }
    else if (arg === "--parent-model") { parsed.parentModel = rest[index + 1] ?? ""; index += 1; }
    else if (arg === "--parent-effort") { parsed.parentEffort = rest[index + 1] ?? ""; index += 1; }
    else if (arg === "--repo") { parsed.repo = rest[index + 1] ?? ""; index += 1; }
    else if (arg === "--branch") { parsed.branch = rest[index + 1] ?? ""; index += 1; }
    else if (arg === "--base") { parsed.base = rest[index + 1] ?? ""; index += 1; }
    else if (arg === "--name") { parsed.slug = rest[index + 1] ?? ""; index += 1; }
    else if (arg === "--worktree") { parsed.worktree = rest[index + 1] ?? ""; index += 1; }
    else if (arg === "--prompt") { parsed.prompt = rest[index + 1] ?? ""; index += 1; }
    else if (arg === "--label") { parsed.label = rest[index + 1] ?? ""; index += 1; }
    else if (arg === "--tmux") { parsed.tmuxChoice = rest[index + 1] ?? ""; index += 1; }
    else if (arg === "--browser") { parsed.browser = true; }
    else if (arg === "--agent-arg") {
      const value = rest[index + 1];
      if (value === undefined || value === "") return failed("--agent-arg requires a non-empty value", 2);
      parsed.agentArgs.push(value);
      index += 1;
    } else if (arg === "--json") { parsed.json = true; }
    else if (arg === "-h" || arg === "--help") { parsed.help = true; }
    else return failed(`unknown chain run option: ${arg}`, 2);
  }
  return ok(parsed);
}

function stringField(step: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = step[key];
  return typeof value === "string" ? value : undefined;
}

function untilField(step: Readonly<Record<string, unknown>>): Readonly<{ usedPercent: number; window: string; onUnknown: string }> | undefined {
  const value = step.until;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const usedPercent = record.usedPercent;
  const window = record.window;
  if (typeof usedPercent !== "number" || typeof window !== "string") return undefined;
  const onUnknown = record.onUnknown;
  return { usedPercent, window, onUnknown: typeof onUnknown === "string" ? onUnknown : "take" };
}

function isLimitAgent(agent: string): agent is LimitAgent {
  return agent === "codex" || agent === "claude" || agent === "agy";
}

async function readStepLimit(agent: string, window: string, config: ChainConfig, environment: ChainRunEnvironment, processAdapter: ProcessAdapter, root: string): Promise<LimitReading> {
  if (window !== "5h" && window !== "weekly") return { status: "unknown", reason: `${agent} ${window} window unknown (unsupported window)` };
  if (!isLimitAgent(agent)) return { status: "unknown", reason: `${agent} ${window} window unknown (unsupported provider)` };
  return readLimit(agent, window as LimitWindowName, config, environment, processAdapter, root);
}

function buildSpawnArgs(options: Readonly<{
  worktree: string | undefined; repo: string | undefined; branch: string | undefined; base: string | undefined; slug: string | undefined;
  agent: string; model: string; effort: string | undefined; prompt: string; label: string | undefined; tmuxChoice: string | undefined;
  browser: boolean; agentArgs: readonly string[];
}>): string[] {
  const args: string[] = [];
  if (options.worktree !== undefined && options.worktree !== "") {
    args.push("--worktree", options.worktree);
  } else {
    args.push("--repo", options.repo ?? "", "--branch", options.branch ?? "");
    if (options.base !== undefined && options.base !== "") args.push("--base", options.base);
    if (options.slug !== undefined && options.slug !== "") args.push("--name", options.slug);
  }
  args.push("--agent", options.agent, "--model", options.model);
  if (options.effort !== undefined && options.effort !== "") args.push("--effort", options.effort);
  args.push("--prompt", options.prompt, "--json");
  if (options.label !== undefined && options.label !== "") args.push("--label", options.label);
  if (options.tmuxChoice !== undefined && options.tmuxChoice !== "") args.push("--tmux", options.tmuxChoice);
  if (options.browser) args.push("--browser");
  for (const value of options.agentArgs) args.push("--agent-arg", value);
  return args;
}

async function updateDispatchChainContext(root: string, dispatchId: string, prompt: string): Promise<void> {
  try {
    const path = await dispatchPath(root, dispatchId, "meta.json");
    const meta = await readJson(path);
    if (meta === undefined || typeof meta.chain !== "object" || meta.chain === null) return;
    const chain = meta.chain as Record<string, unknown>;
    await atomicJson(path, { ...meta, chain: { ...chain, prompt }, updatedAt: new Date().toISOString() });
  } catch { /* best effort, matches megabrain_dispatch_meta_update_chain_context's `|| true` caller */ }
}

async function maybeSendUsageNotice(root: string, dispatchId: string, config: ChainConfig, environment: ChainRunEnvironment, processAdapter: ProcessAdapter): Promise<void> {
  try {
    if (!usageNoticeDue(config, root, Math.floor(Date.now() / 1000))) return;
    const meta = await readJson(await dispatchPath(root, dispatchId, "meta.json"));
    if (meta === undefined) return;
    const report = await usageNoticeReport(config, environment, processAdapter, root);
    const appended = await appendMessage(root, dispatchId, "megabrain", "usage", report, environment.MEGABRAIN_SESSION_ID ?? "megabrain", environment, processAdapter);
    if (appended.kind !== "ok") return;
    markUsageNoticeSent(root, Math.floor(Date.now() / 1000));
  } catch { /* best effort, matches megabrain_chain_usage_notice_maybe's `|| return 0` chain */ }
}

type ReportBody = Readonly<{
  readonly ok: boolean;
  readonly chain: string;
  readonly step?: number;
  readonly totalSteps: number;
  readonly agent?: string;
  readonly reason: string;
  readonly skipped: readonly SkippedEntry[];
  readonly dispatch?: unknown;
}>;

function reportOutput(body: ReportBody, json: boolean, spawnOutput: string | undefined): string {
  if (json) return `${JSON.stringify(body)}\n`;
  if (body.ok) return `chain ${body.chain}, step ${body.step} of ${body.totalSteps}, reason: ${body.reason}\n${spawnOutput ?? ""}\n`;
  return `chain ${body.chain} failed after ${body.totalSteps} steps, reason: ${body.reason}\n`;
}

export async function executeChainRun(
  args: readonly string[],
  environment: ChainRunEnvironment,
  processAdapter: ProcessAdapter,
  dependencies: ChainRunDependencies = {},
): Promise<Result<string>> {
  const parsed = parseArgs(args);
  if (parsed.kind !== "ok") return parsed;
  if (parsed.value.help) return ok(usage());
  const options = parsed.value;
  if (options.prompt === undefined || options.prompt === "") return failed("--prompt is required for chain run", 2);
  if (options.worktree === undefined || options.worktree === "") {
    if (options.repo === undefined || options.repo === "") return failed("--repo is required for chain run unless --worktree is used", 2);
    if (options.branch === undefined || options.branch === "") return failed("--branch is required for chain run unless --worktree is used", 2);
  }

  const parentEnvironment = {
    supersetAgentId: environment.SUPERSET_AGENT_ID,
    supersetModel: environment.SUPERSET_AGENT_MODEL,
    supersetEffort: environment.SUPERSET_AGENT_EFFORT,
    aiAgent: environment.AI_AGENT,
    aiModel: environment.AI_MODEL,
    aiEffort: environment.AI_EFFORT,
    codexSessionId: environment.CODEX_SESSION_ID,
  };
  const resolvedParent = resolveParentContext(parentEnvironment);
  const parentAgent = options.parentAgent ?? (resolvedParent.kind === "resolved" ? resolvedParent.agent : "");
  const parentModel = options.parentModel ?? resolvedParent.model ?? "";
  const parentEffort = options.parentEffort ?? resolvedParent.effort ?? "";

  const read = readConfig(environment);
  if (read.kind !== "ok") return read;
  const validated = validateConfig(read.value, environment);
  if (validated.kind !== "ok") return validated;
  const config = validated.value;

  const selectionName = options.chainOption ?? options.explicitName;
  const selection = selectChain(config, selectionName, {
    agent: parentAgent === "" ? undefined : parentAgent,
    model: parentModel === "" ? undefined : parentModel,
    effort: parentEffort === "" ? undefined : parentEffort,
  }, options.selectionSource);
  if (selection.kind === "not-found") return failed(`chain not found: ${selection.name}; list chains with megabrain chain list`, 1);
  if (selection.kind === "ambiguous") return failed(`chain selection is ambiguous: candidates: ${selection.candidates.join(", ")}`, 1);
  const usedDefault = selection.kind === "default";
  const reportChain = usedDefault ? "defaultSteps" : selection.name;
  const steps = selection.steps;
  const selectionReason = selection.reason;

  const root = resolveStateDirectory(environment);
  const spawn = dependencies.spawn ?? executeSpawn;
  const stderrLines: string[] = [];
  const skipped: SkippedEntry[] = [];

  if (steps.length === 0) {
    const reason = "chain has no usable steps; add a chain with megabrain chain add";
    stderrLines.push(errorLine("no usable chain steps; add a chain with megabrain chain add"));
    const body: ReportBody = { ok: false, chain: reportChain, totalSteps: 0, reason, skipped: [] };
    return okWithStderr(reportOutput(body, options.json, undefined), 1, stderrLines.join("") || undefined);
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const stepNumber = index + 1;
    const agent = stringField(step, "agent") ?? "";
    const model = stringField(step, "model") ?? "";
    const effort = stringField(step, "effort");
    const until = untilField(step);

    let limitReason = "";
    let untilStatus: "current" | "unknown" | undefined;
    if (until !== undefined) {
      const reading = await readStepLimit(agent, until.window, config, environment, processAdapter, root);
      limitReason = reading.reason;
      untilStatus = reading.status;
      if (reading.status === "unknown") {
        if (until.onUnknown === "skip") {
          skipped.push({ step: stepNumber, agent, kind: "limit", reason: reading.reason });
          continue;
        }
        stderrLines.push(`chain step ${stepNumber} (${agent}) usage limit is unknown; taking step (onUnknown=take)\n`);
      } else if (reading.usedPercent >= until.usedPercent) {
        const resetText = reading.resetsAt !== "" ? `; resets at ${resetDisplay(reading.resetsAt)}` : "";
        skipped.push({ step: stepNumber, agent, kind: "limit", reason: `${reading.reason}${resetText}` });
        continue;
      }
    }

    let finalReason = skipped.length > 0 ? skipped.map((entry) => entry.reason).join("; ") : "no earlier steps skipped";
    finalReason = usedDefault ? `used defaultSteps; ${finalReason}` : `${finalReason}; ${selectionReason}`;
    if (limitReason !== "" && untilStatus === "unknown") finalReason = `${finalReason}; ${limitReason}`;

    const spawnArgs = buildSpawnArgs({
      worktree: options.worktree, repo: options.repo, branch: options.branch, base: options.base, slug: options.slug,
      agent, model, effort, prompt: options.prompt, label: options.label, tmuxChoice: options.tmuxChoice,
      browser: options.browser, agentArgs: options.agentArgs,
    });
    const spawnResult = await spawn(spawnArgs, environment, processAdapter);

    if (spawnResult.kind === "ok") {
      const spawnOutput = spawnResult.value.replace(/\n+$/, "");
      let spawnJson: unknown = null;
      try { spawnJson = JSON.parse(spawnOutput); } catch { spawnJson = null; }
      const dispatchId = spawnJson !== null && typeof spawnJson === "object" && typeof (spawnJson as Record<string, unknown>).dispatchId === "string"
        ? (spawnJson as Record<string, unknown>).dispatchId as string
        : undefined;
      if (dispatchId !== undefined) {
        await maybeSendUsageNotice(root, dispatchId, config, environment, processAdapter);
        await updateDispatchChainContext(root, dispatchId, options.prompt);
      }
      const body: ReportBody = { ok: true, chain: reportChain, step: stepNumber, totalSteps: steps.length, agent, reason: finalReason, skipped, dispatch: spawnJson };
      return okWithStderr(reportOutput(body, options.json, spawnOutput), undefined, stderrLines.join("") || undefined);
    }

    const spawnError = (spawnResult.kind === "failed" ? spawnResult.error : spawnResult.reason) || "launch failed";
    let failureReason = `${agent} launch failed: ${spawnError}`;
    if (limitReason !== "" && untilStatus === "unknown") failureReason = `${failureReason}; ${limitReason}`;
    skipped.push({ step: stepNumber, agent, kind: "failure", reason: failureReason });
  }

  const reason = skipped.length > 0 ? skipped.map((entry) => entry.reason).join("; ") : "chain has no usable steps; add a chain with megabrain chain add";
  const body: ReportBody = { ok: false, chain: reportChain, totalSteps: steps.length, reason, skipped };
  return okWithStderr(reportOutput(body, options.json, undefined), 1, stderrLines.join("") || undefined);
}
