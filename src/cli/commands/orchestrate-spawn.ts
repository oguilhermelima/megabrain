import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { dispatchPath } from "../../adapters/dispatch-store.js";
import { getAgent } from "../../agents/index.js";
import { decideSpawnStep, resolveAutoSpawnRuntime, type SpawnDecisionInput, type SpawnFailure, type SpawnPlan, type SpawnRuntime, type SpawnState, type SpawnStep, type WorktreeOwnership } from "../../core/spawn-plan.js";
import { checkDispatchTransition } from "../../core/dispatch-states.js";
import { classifyLiveness } from "../../core/liveness.js";
import { failed, ok, unknown, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { CALLER_IDENTITY_ENV_VARS, type CallerIdentity } from "../../core/context.js";
import { appendMessage, atomicJson, readJson, resolveCaller, type QueueEnvironment } from "./queue-write.js";
import { repoFromOrca } from "./repository-selector.js";
import { executeWorktreeCreate } from "./worktree-write.js";
import { getHost, runHostSend, type HostCommand, type HostProvider } from "../../hosts/index.js";
import { createTmuxSession, getTmux, sendTmuxPair, splitTmuxWindow, waitForTmuxSession } from "../../hosts/tmux.js";
import { usageText } from "../../core/usage.js";

const TERMINAL_CREATE_MAX_ATTEMPTS = 6;
const TERMINAL_CREATE_DEADLINE_MS = 2000;
const TERMINAL_CREATE_BACKOFF_MS = 250;
const PROMPT_BUDGET_TMUX_BYTES = 12000;
const PROMPT_BUDGET_ARGV_BYTES = 262144;

type SpawnEnvironment = QueueEnvironment & Readonly<{
  readonly HOME?: string;
  readonly MEGABRAIN_SESSION_ID?: string;
  readonly MEGABRAIN_SESSION_HOST?: string;
  readonly MEGABRAIN_WORKSPACE_ID?: string;
  readonly MEGABRAIN_TMUX_SESSION?: string;
  readonly SUPERSET_WORKSPACE_ID?: string;
  readonly MEGABRAIN_SPAWN_DISPATCH_ID?: string;
  readonly MEGABRAIN_AGENT_READY_TIMEOUT_MS?: string;
}>;

export type SpawnWorktree = Readonly<{
  readonly path: string;
  readonly branch: string;
  readonly ownership: WorktreeOwnership;
  readonly workspaceId: string | null;
}>;

export type SpawnDependencies = Readonly<{
  readonly resolveWorktree?: (target: string | undefined, options: SpawnOptions, environment: SpawnEnvironment, process: ProcessAdapter) => Promise<Result<SpawnWorktree>>;
  readonly removeWorktree?: (path: string, process: ProcessAdapter) => Promise<Result<void>>;
}>;

type SpawnOptions = Readonly<{
  readonly worktree?: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly base?: string;
  readonly name?: string;
  readonly agent: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly prompt: string;
  readonly label: string | null;
  readonly tmux: boolean | null;
  readonly browser: boolean;
  readonly agentArgs: readonly string[];
  readonly json: boolean;
}>;

type RecordValue = Record<string, unknown>;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseBoolean(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const unsupportedOptions = ["--from", "--parent", "--no-parent", "--issue", "--linear-issue", "--pr", "--chain", "--orchestrate"] as const;

function parseArgs(args: readonly string[]): Result<SpawnOptions> {
  let worktree: string | undefined;
  let repo: string | undefined;
  let branch: string | undefined;
  let base: string | undefined;
  let name: string | undefined;
  let agent: string | undefined;
  let model: string | null = null;
  let effort: string | null = null;
  let prompt: string | undefined;
  let label: string | null = null;
  let tmux: boolean | null = null;
  let browser = false;
  let json = false;
  const agentArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--browser") browser = true;
    else if (unsupportedOptions.includes(arg as typeof unsupportedOptions[number])) return failed(`unsupported orchestrate spawn option: ${arg}`, 2);
    else if (arg === "--tmux") {
      const value = args[index + 1];
      if (value === undefined) return failed("--tmux requires true or false", 2);
      const parsed = parseBoolean(value);
      if (parsed === undefined) return failed("--tmux requires true or false", 2);
      tmux = parsed;
      index += 1;
    } else if (["--worktree", "--repo", "--branch", "--base", "--name", "--agent", "--model", "--effort", "--prompt", "--label", "--agent-arg"].includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value === "") return failed(`${arg} requires a non-empty value`, 2);
      if (arg === "--worktree") worktree = value;
      else if (arg === "--repo") repo = value;
      else if (arg === "--branch") branch = value;
      else if (arg === "--base") base = value;
      else if (arg === "--name") name = value;
      else if (arg === "--agent") agent = value;
      else if (arg === "--model") model = value;
      else if (arg === "--effort") effort = value;
      else if (arg === "--prompt") prompt = value;
      else if (arg === "--label") label = value;
      else agentArgs.push(value);
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      return ok({ worktree: "", agent: "", model: null, effort: null, prompt: "", label: null, tmux: null, browser, agentArgs, json });
    } else return failed(`unknown orchestrate spawn option: ${arg}`, 2);
  }
  if (worktree === undefined && (repo === undefined || branch === undefined)) {
    return failed("either --worktree <path> or --repo <name|path> with --branch <branch> is required", 2);
  }
  if (agent === undefined) return failed("--agent is required", 2);
  if (prompt === undefined) return failed("--prompt is required", 2);
  return ok({ worktree, repo, branch, base, name, agent, model, effort, prompt, label, tmux, browser, agentArgs, json });
}

function dispatchId(environment: SpawnEnvironment): string {
  const supplied = environment.MEGABRAIN_SPAWN_DISPATCH_ID;
  return supplied !== undefined && /^[A-Za-z0-9._-]+$/.test(supplied)
    ? supplied
    : `dispatch-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

// The "tmux-runtime" installed flag in state.json selects tmux. An absent or unparsable file means
// tmux is not installed, so the automatic runtime falls back to host.
async function tmuxRuntimeInstalled(environment: SpawnEnvironment): Promise<boolean> {
  try {
    const raw = await readFile(`${resolveStateDirectory(environment)}/state.json`, "utf8");
    const parsed = JSON.parse(raw) as Record<string, { readonly installed?: boolean } | undefined>;
    return parsed["tmux-runtime"]?.installed === true;
  } catch {
    return false;
  }
}

// The workspace id a parent may pass down to the child host provider. Unrelated to caller
// identity: kept as its own lookup rather than folded into resolveCaller.
function parentWorkspaceId(environment: SpawnEnvironment): string | null {
  return environment.MEGABRAIN_WORKSPACE_ID ?? environment.SUPERSET_WORKSPACE_ID ?? null;
}

// The tmux channel to type a notification into for this dispatch's parent. This is the pane the
// parent itself was launched into (MEGABRAIN_TMUX_SESSION, set by whatever spawned the parent),
// not a fresh probe of the parent's current caller identity — the two usually agree, but this
// field exists purely for message delivery, so it stays independent of resolveCaller.
function parentTmuxChannel(environment: SpawnEnvironment): Readonly<{ tmuxSession: string | null; tmuxPane: string | null }> {
  return { tmuxSession: environment.TMUX_PANE ? environment.MEGABRAIN_TMUX_SESSION ?? null : null, tmuxPane: environment.TMUX_PANE ?? null };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// A tmux pane inherits the whole environment of whatever launched the pane's shell, and a host
// terminal's shell can too — so without this, a child started by a caller who has
// CLAUDE_CODE_SESSION_ID / ORCA_STRUCTURED_SESSION / etc. set would inherit them, resolve as its
// parent's own identity, and pass the parent's ownership checks. `env -u` for each name in
// CALLER_IDENTITY_ENV_VARS strips them before the launch line's own MEGABRAIN_* assignments run.
const clearCallerIdentityEnv = `env ${CALLER_IDENTITY_ENV_VARS.map((name) => `-u ${name}`).join(" ")}`;

function finalPrompt(options: SpawnOptions, id: string): string {
  const label = options.label ?? `${options.agent} ${options.worktree}`;
  return `[megabrain dispatch: ${label}]\n\nThis is a managed megabrain dispatch. Before starting work, run megabrain received to confirm that you received this prompt. If you need coordinator input, run megabrain ask "your question"; wait with megabrain check until a reply arrives, then run megabrain ack <delivery-id> to confirm it. When the requested work is complete, run megabrain done "short outcome summary". Do not print protocol markers and do not continue past an unanswered question.\n\nDispatch identity: ${id}\n\n${options.prompt}`;
}

// Bytes, not characters: a prompt that fits the CLI's character limit can still overflow the
// pane's paste buffer or the OS argv limit once it is UTF-8 encoded.
function promptByteLength(prompt: string): number {
  return new TextEncoder().encode(prompt).length;
}

function validatePromptBudget(prompt: string, runtime: SpawnRuntime): Result<void> {
  const transport = runtime === "tmux" ? "tmux" : "argv";
  const limit = runtime === "tmux" ? PROMPT_BUDGET_TMUX_BYTES : PROMPT_BUDGET_ARGV_BYTES;
  const actual = promptByteLength(prompt);
  if (actual > limit) return failed(`prompt is too large for ${transport} delivery: ${actual} bytes (limit: ${limit} bytes)`, 2);
  return ok(undefined);
}

function agentReadyTimeoutMs(environment: SpawnEnvironment): number {
  const raw = environment.MEGABRAIN_AGENT_READY_TIMEOUT_MS;
  if (raw !== undefined && /^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return value;
  }
  return 10000;
}

const TMUX_READINESS_POLL_MS = 100;
const TMUX_READINESS_STABLE_MS = 1000;

// Reuses the same output classification `orchestrate liveness` uses (core/liveness.ts,
// getTmux().capturePane): the tmux runtime has no blocking "wait until ready" call the way the
// host providers do, so readiness is read from the pane's own text until the agent's composer
// reports idle or the deadline passes. A single idle poll is not proof the composer is still
// there to type into: something else (an update-check modal, for one real example) can replace
// it between polls. So readiness only succeeds once idle has held continuously for
// TMUX_READINESS_STABLE_MS — any non-idle observation resets the stability window rather than
// failing outright, since the composer may still settle before the overall deadline.
async function waitForTmuxReadiness(agentId: string, pane: string, timeoutMs: number, process: ProcessAdapter): Promise<Result<void>> {
  const started = Date.now();
  let stableSince: number | null = null;
  while (true) {
    const captured = await getTmux().capturePane(pane, 200, process);
    const idle = captured.kind === "ok" && classifyLiveness(agentId, captured.value).status === "idle";
    if (idle) {
      if (stableSince === null) stableSince = Date.now();
      else if (Date.now() - stableSince >= TMUX_READINESS_STABLE_MS) return ok(undefined);
    } else {
      stableSince = null;
    }
    if (Date.now() - started >= timeoutMs) return failed(`tmux pane ${pane} did not become ready within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, TMUX_READINESS_POLL_MS));
  }
}

async function runGit(process: ProcessAdapter, args: readonly string[]): Promise<Result<string>> {
  const result = await process.run("git", args);
  return result.kind === "ok" ? ok(result.value.stdout.trim()) : failed(result.kind === "failed" ? result.error : result.reason, result.exitCode);
}

function existingWorktreeError(options: SpawnOptions): string | undefined {
  const flags = [options.base === undefined ? undefined : "--base", options.name === undefined ? undefined : "--name"].filter((flag): flag is string => flag !== undefined);
  return flags.length === 0 ? undefined : `worktree already exists; ${flags.join(" and ")} cannot be applied`;
}

export async function defaultResolveWorktree(target: string | undefined, options: SpawnOptions, environment: SpawnEnvironment, process: ProcessAdapter): Promise<Result<SpawnWorktree>> {
  const direct = target === undefined ? undefined : await realpath(target).catch(() => undefined);
  if (direct !== undefined) {
    const top = await runGit(process, ["-C", direct, "rev-parse", "--show-toplevel"]);
    if (top.kind !== "ok") return failed(`worktree path is not a Git directory: ${target}`);
    const existingError = existingWorktreeError(options);
    if (existingError !== undefined) return failed(existingError);
    const branch = await runGit(process, ["-C", direct, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    return ok({ path: direct, branch: branch.kind === "ok" && branch.value !== "" ? branch.value : "detached", ownership: "existing", workspaceId: environment.MEGABRAIN_WORKSPACE_ID ?? environment.SUPERSET_WORKSPACE_ID ?? null });
  }
  if (options.repo === undefined) return failed("--repo is required to resolve a worktree by name");
  const repository = await repoFromOrca(process, options.repo);
  if (repository.kind !== "ok") return repository;
  const listed = await runGit(process, ["-C", repository.value, "worktree", "list", "--porcelain"]);
  if (listed.kind === "ok") {
    let path = "";
    for (const line of listed.value.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      const listedBranch = line.startsWith("branch refs/heads/") ? line.slice(18) : undefined;
      const matches = target === undefined
        ? listedBranch === options.branch
        : listedBranch === target || (line.startsWith("worktree ") && basename(path) === target);
      if (matches) {
        const existingError = existingWorktreeError(options);
        if (existingError !== undefined) return failed(existingError);
        return ok({ path, branch: listedBranch ?? target ?? "detached", ownership: "existing", workspaceId: environment.MEGABRAIN_WORKSPACE_ID ?? environment.SUPERSET_WORKSPACE_ID ?? null });
      }
    }
  }
  if (options.repo === undefined || options.branch === undefined) return failed(`worktree not found: ${target}`);
  const createArgs = ["--repo", options.repo, "--branch", options.branch, "--json"];
  if (options.base !== undefined) createArgs.push("--base", options.base);
  if (options.name !== undefined) createArgs.push("--name", options.name);
  const created = await executeWorktreeCreate(createArgs, environment, process);
  if (created.kind !== "ok") return created;
  try {
    const value = JSON.parse(created.value) as RecordValue;
    const path = stringValue(value.worktree);
    const branch = stringValue(value.branch);
    if (path === "" || branch === "") return failed("worktree creation returned no path or branch");
    return ok({ path, branch, ownership: "created", workspaceId: environment.MEGABRAIN_WORKSPACE_ID ?? environment.SUPERSET_WORKSPACE_ID ?? null });
  } catch {
    return failed("worktree creation returned invalid JSON");
  }
}

async function defaultRemoveWorktree(path: string, process: ProcessAdapter): Promise<Result<void>> {
  const result = await process.run("git", ["worktree", "remove", "--force", path]);
  return result.kind === "ok" ? ok(undefined) : failed(result.kind === "failed" ? result.error : result.reason, result.exitCode);
}

function describeHostCall(call: HostCommand): string {
  const text = call.args.indexOf("--text");
  const json = call.args.indexOf("--json");
  const end = text === -1 ? json : json === -1 ? text : Math.min(text, json);
  const args = end === -1 ? call.args : call.args.slice(0, end);
  return [call.command, ...args].join(" ");
}

function failureForCall(call: HostCommand | undefined, result: Result<unknown>, fallbackCall: string): SpawnFailure {
  return {
    call: call === undefined ? fallbackCall : describeHostCall(call),
    detail: result.kind === "ok" ? "call failed" : result.error,
  };
}

type HostTerminalCreation = Readonly<{
  readonly terminalId: string;
  readonly attempts: number;
}>;

function terminalCreateFailure(call: HostCommand, response: Result<unknown>, attempts: number, elapsedMs: number): Result<HostTerminalCreation> {
  const failure = failureForCall(call, response, "terminal create");
  return failed(`${failure.call}: ${failure.detail} after ${attempts} attempts in ${elapsedMs}ms`, response.kind === "ok" ? 1 : response.exitCode);
}

async function createHostTerminal(host: Pick<HostProvider, "terminalIdentity">, call: HostCommand, process: ProcessAdapter): Promise<Result<HostTerminalCreation>> {
  const started = Date.now();
  for (let attempts = 1; attempts <= TERMINAL_CREATE_MAX_ATTEMPTS; attempts += 1) {
    const response = await process.run(call.command, call.args);
    if (response.kind === "ok") {
      const terminalId = host.terminalIdentity(JSON.parse(response.value.stdout || "{}")) ?? "";
      if (terminalId === "") return failed("terminal create returned no terminal identity");
      return ok({ terminalId, attempts });
    }
    const elapsed = Date.now() - started;
    if (attempts === TERMINAL_CREATE_MAX_ATTEMPTS || elapsed >= TERMINAL_CREATE_DEADLINE_MS) return terminalCreateFailure(call, response, attempts, elapsed);
    const waitMs = Math.min(TERMINAL_CREATE_BACKOFF_MS, TERMINAL_CREATE_DEADLINE_MS - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const retryElapsed = Date.now() - started;
    if (retryElapsed >= TERMINAL_CREATE_DEADLINE_MS) return terminalCreateFailure(call, response, attempts, retryElapsed);
  }
  return failed("terminal create retry deadline expired");
}

function resultError(result: Result<unknown>, fallback: string): string {
  return result.kind === "ok" ? fallback : result.error;
}

async function hasReceipt(root: string, id: string): Promise<boolean> {
  const directory = await dispatchPath(root, id, "messages");
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const value = await readJson(`${directory}/${name}`);
    if (value?.from === "child" && value.type === "received") return true;
  }
  return false;
}

async function awaitReceipt(root: string, id: string, environment: SpawnEnvironment): Promise<boolean> {
  const seconds = Number(environment.MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS ?? "30");
  const timeout = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0;
  const started = Date.now();
  do {
    if (await hasReceipt(root, id)) return true;
    if (Date.now() - started >= timeout) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (true);
}

async function updateMeta(root: string, id: string, update: RecordValue): Promise<Result<void>> {
  const path = await dispatchPath(root, id, "meta.json");
  const current = await readJson(path);
  if (current === undefined) return failed(`dispatch not found: ${id}`);
  await atomicJson(path, { ...current, ...update, updatedAt: new Date().toISOString() });
  return ok(undefined);
}

export async function markRunningIfSpawning(root: string, id: string): Promise<Result<void>> {
  const path = await dispatchPath(root, id, "meta.json");
  const meta = await readJson(path);
  if (meta === undefined) return failed(`dispatch not found: ${id}`);
  const state = stringValue(meta.state);
  const transition = checkDispatchTransition("dispatch", state, "running");
  if (transition.kind === "unknown") return transition;
  if (state !== "spawning") return ok(undefined);
  if (transition.kind === "failed") return transition;
  return updateMeta(root, id, { state: "running" });
}

async function initialMeta(id: string, options: SpawnOptions, worktree: SpawnWorktree, parentContext: CallerIdentity, parentWorkspace: string | null, parentTmux: Readonly<{ tmuxSession: string | null; tmuxPane: string | null }>, runtime: SpawnRuntime, terminalId: string, session: string | null, pane: string | null): Promise<RecordValue> {
  const now = new Date().toISOString();
  return {
    dispatchId: id,
    // The stable owner of this dispatch (D): a caller's own agent-session id when one is
    // available, otherwise its terminal handle. parentTerminalId is recorded separately so a
    // caller whose agent session later changes can still be recognised by the terminal it ran in
    // (see core/context.js ownsDispatch).
    parentSessionId: parentContext.id,
    parentHost: parentContext.host,
    parentTerminalId: parentContext.terminalId,
    parentWorkspaceId: parentWorkspace,
    parentTmuxSession: parentTmux.tmuxSession,
    parentTmuxPane: parentTmux.tmuxPane,
    // A tmux dispatch's childHost names its own runtime ("tmux"), not the caller's host — see the
    // WHY comment on terminalId's assignment in executeSpawn's tmux branch above.
    childHost: runtime === "tmux" ? "tmux" : parentContext.host,
    workspaceId: worktree.workspaceId,
    terminalId,
    worktreePath: worktree.path,
    branch: worktree.branch,
    agent: options.agent,
    agentId: options.agent,
    model: options.model ?? "",
    effort: options.effort,
    modelHonored: true,
    modelSubstitution: null,
    runtime,
    spawnRuntime: runtime === "tmux" ? "tmux" : "ide",
    tmuxSession: session,
    tmuxPane: pane,
    label: options.label ?? `${options.agent} ${worktree.path}`,
    chain: null,
    state: "spawning",
    promptDelivered: false,
    promptDelivery: "pending",
    promptDeliveryReason: null,
    promptPublication: "pending",
    promptTransport: "pending",
    promptReceipt: "pending",
    promptState: "awaiting-publication",
    processState: "starting",
    terminalState: "owned",
    terminalReason: null,
    failureCount: 0,
    stage: null,
    reason: null,
    reconcileOutcome: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function cleanup(root: string, id: string, worktree: SpawnWorktree, plan: SpawnPlan, process: ProcessAdapter, dependencies: SpawnDependencies, terminalId: string, session: string | null, pane: string | null, sessionOwned: boolean): Promise<readonly string[]> {
  if (plan.cleanup.kind !== "required") return [];
  const failures: string[] = [];
  if (plan.cleanup.runtime === "tmux" && session !== null) {
    const call = sessionOwned ? `tmux kill-session --target ${session}` : `tmux kill-pane --target ${pane ?? ""}`;
    const result = sessionOwned ? await getTmux().killSession(session, process) : pane === null ? undefined : await getTmux().killPane(pane, process);
    if (result !== undefined && result.kind !== "ok") failures.push(`${call}: ${result.error}`);
  }
  if (plan.cleanup.runtime === "host") {
    const provider = getHost(stringValue((await readJson(await dispatchPath(root, id, "meta.json")))?.childHost));
    const workspaceId = stringValue((await readJson(await dispatchPath(root, id, "meta.json")))?.workspaceId) || null;
    if (provider !== undefined && terminalId !== "") {
      const call = provider.close({ workspaceId, terminalId });
      if (call.kind === "ok") {
        const result = await process.run(call.value.command, call.value.args);
        if (result.kind !== "ok") failures.push(`${describeHostCall(call.value)}: ${result.error}`);
      } else {
        failures.push(`${provider.id} terminal close --terminal ${terminalId}: ${call.error}`);
      }
    }
  }
  if (plan.cleanup.worktree === "remove") {
    const result = await (dependencies.removeWorktree ?? defaultRemoveWorktree)(worktree.path, process);
    if (result.kind !== "ok") failures.push(`git worktree remove --force ${worktree.path}: ${result.error}`);
  }
  return failures;
}

function failureResult(plan: SpawnPlan, detail?: string, cleanupFailures: readonly string[] = []): Result<string> {
  const primary = plan.failure === null ? detail : `${plan.failure.call}: ${plan.failure.detail}`;
  const message = [plan.reason ?? "spawn failed", primary].filter((part): part is string => part !== undefined).join(": ");
  const cleanup = cleanupFailures.map((failure) => `cleanup failed: ${failure}`).join("; ");
  return failed(cleanup === "" ? message : `${message}; ${cleanup}`, plan.exitCode);
}

export async function executeSpawn(args: readonly string[], environment: SpawnEnvironment, process: ProcessAdapter, dependencies: SpawnDependencies = {}): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("orchestrate-spawn"));
  const parsed = parseArgs(args);
  if (parsed.kind !== "ok") return parsed;
  const options = parsed.value;
  const agent = getAgent(options.agent);
  if (agent === undefined) return unknown(`agent cannot be determined: ${options.agent}`);
  const agentCommand = agent.commandLine?.({
    model: options.model,
    effort: options.effort,
    browser: options.browser,
    agentArgs: options.agentArgs,
  });
  if (agentCommand === undefined) return unknown(`agent cannot build a command line: ${options.agent}`);
  if (agentCommand.kind !== "ok") return agentCommand;
  // An explicit --tmux always wins; omitted, this follows the shell's auto default exactly (see
  // resolveAutoSpawnRuntime and tmuxRuntimeInstalled) instead of reading MEGABRAIN_SPAWN_RUNTIME,
  // an environment variable nothing in this codebase ever sets.
  const runtime: SpawnRuntime = options.tmux === null ? resolveAutoSpawnRuntime(await tmuxRuntimeInstalled(environment)) : options.tmux ? "tmux" : "host";
  // dispatchId does not depend on the worktree, so the wrapped prompt (the payload actually
  // transported, not the raw --prompt) can be built and budgeted before anything is created.
  const id = dispatchId(environment);
  const prompt = finalPrompt(options, id);
  const budget = validatePromptBudget(prompt, runtime);
  if (budget.kind !== "ok") return budget;
  const worktreeResult = await (dependencies.resolveWorktree ?? defaultResolveWorktree)(options.worktree, options, environment, process);
  if (worktreeResult.kind !== "ok") return worktreeResult;
  const worktree = worktreeResult.value;
  const parentContext = await resolveCaller(environment, process);
  const parentWorkspace = parentWorkspaceId(environment);
  const parentTmux = parentTmuxChannel(environment);
  // F: a tmux spawn from a caller whose host could not be resolved would otherwise record an
  // empty owner (parentContext.id === "" with host "unknown") — a dispatch nobody can later
  // supervise, close or reply to. Refuse before anything is created. The host runtime path
  // already refuses below (getHost(parentContext.host) === undefined), so this only needs to
  // cover tmux.
  if (runtime === "tmux" && parentContext.host === "unknown") {
    return failed("cannot spawn on tmux from an unknown caller host; run inside a managed terminal or set MEGABRAIN_SESSION_HOST so the dispatch has a supervisable owner");
  }
  const command = agentCommand.value;
  const readinessTimeoutMs = agentReadyTimeoutMs(environment);
  let terminalId = "";
  let session: string | null = null;
  let pane: string | null = null;
  let sessionOwned = true;
  let readinessError: string | undefined;
  let terminalCreateAttempts: number | undefined;

  if (runtime === "tmux") {
    if (parentContext.host === "tmux" && environment.TMUX_PANE !== undefined) {
      const current = await getTmux().sessionForPane(environment.TMUX_PANE, process);
      if (current.kind === "ok") {
        session = current.value;
        sessionOwned = false;
        const waited = await waitForTmuxSession(session, process);
        if (waited.kind !== "ok") return waited;
        const split = await splitTmuxWindow(session, worktree.path, process);
        if (split.kind !== "ok") return split;
        pane = split.value;
      }
    }
    if (session === null) {
      session = `megabrain-${id}`;
      const created = await createTmuxSession(session, worktree.path, undefined, process);
      if (created.kind !== "ok") return created;
    }
    const waited = await waitForTmuxSession(session, process);
    if (waited.kind !== "ok") return waited;
    if (pane === null) {
      const panes = await getTmux().panesForSession(session, process);
      if (panes.kind !== "ok" || panes.value[0] === undefined) return failed(`tmux session ${session} has no pane`);
      pane = panes.value[0];
    }
    // The CHILD's own identity, never the caller's: session/pane are always the pane this
    // dispatch actually runs in (freshly split or created above), even when the split reuses the
    // caller's own tmux session — the caller's own pane and this dispatch's pane are always
    // different panes. Before this fix terminalId was parentContext.id (the spawning caller's own
    // id), which findChild (queue-write.ts) matches against meta.terminalId === current.id &&
    // meta.childHost === current.host — so a non-tmux-hosted caller that spawned a tmux dispatch
    // matched its own just-spawned dispatch on its very next findChild call (the turn-end hook,
    // on every agent turn; `megabrain done`/`ask`/`received`). See initialMeta below for the
    // matching childHost fix.
    terminalId = `tmux:${session}:${pane}`;
  } else {
    // E: a structured Orca session (ORCA_STRUCTURED_SESSION=1, no ORCA_TERMINAL_HANDLE) now
    // resolves host "orca" here too (C, resolveCaller shares callerEnvironment with every other
    // verb), so this branch already launches such a caller through the orca provider below with
    // no further change. Verified before relying on that: `orca terminal create` takes only
    // --worktree/--title/--command/--focus (`orca terminal create --help`), and the same CLI's
    // `orca worktree current` probe — used for the exact same host recognition in `megabrain
    // context` — already succeeds when run from a structured session (measured, issue #55). The
    // orca CLI is not scoped to the caller's own terminal; nothing here needed a parent terminal
    // identity to begin with.
    const host = getHost(parentContext.host);
    if (host === undefined) return failed(`cannot launch agent from unknown orchestration host: ${parentContext.host}`);
    const created = host.create({ workspaceId: worktree.workspaceId ?? parentWorkspace, worktreePath: worktree.path, title: `${options.agent} ${worktree.path}` });
    if (created.kind !== "ok") return created;
    const createdTerminal = await createHostTerminal(host, created.value, process);
    if (createdTerminal.kind !== "ok") return createdTerminal;
    terminalId = createdTerminal.value.terminalId;
    terminalCreateAttempts = createdTerminal.value.attempts;
  }

  const root = resolveStateDirectory(environment);
  const directory = await dispatchPath(root, id, "");
  await mkdir(directory, { recursive: true });
  const meta = await initialMeta(id, options, worktree, parentContext, parentWorkspace, parentTmux, runtime, terminalId, session, pane);
  await atomicJson(`${directory}/meta.json`, meta);
  let state: SpawnState = { dispatch: "spawning", process: "starting", terminal: "owned" };
  let step: SpawnStep = runtime === "tmux" ? "transcript-start" : "prompt-publication";
  const baseInput = (): Omit<SpawnDecisionInput, "step" | "outcome"> => ({ dispatchId: id, runtime, worktree: worktree.ownership, state });

  while (true) {
    let outcome: SpawnDecisionInput["outcome"];
    if (step === "prompt-publication") {
      const appended = await appendMessage(root, id, "parent", "prompt", prompt, parentContext.id, environment, process);
      outcome = appended.kind === "ok" ? { kind: "succeeded" } : { kind: "failed", failure: { call: "dispatch message append", detail: appended.error } };
    } else if (step === "readiness-wait") {
      const host = getHost(parentContext.host);
      const waited = host?.readiness({ workspaceId: worktree.workspaceId ?? parentWorkspace, terminalId }, process, readinessTimeoutMs);
      if (waited === undefined) {
        readinessError = `${parentContext.host} terminal ${terminalId} did not become ready within ${readinessTimeoutMs}ms`;
        outcome = { kind: "failed" };
      } else {
        const result = await waited;
        if (result.kind !== "ok") readinessError = result.error;
        outcome = result.kind === "ok" ? { kind: "succeeded" } : { kind: "failed" };
      }
    } else if (step === "command-submission") {
      if (runtime === "tmux") {
        // The launch line runs in the pane's shell, not the agent composer: it always submits on
        // Enter regardless of the agent's own submit key (Tab for Codex, which the shell reads as
        // completion instead of running the command). clearStrayInput=true here, and only here:
        // this is the one call typing into a still-bare shell prompt, matching the shell's own
        // megabrain_tmux_send_agent (see the WHY comment on sendTmuxPair).
        const sent = await sendTmuxPair(root, pane ?? "", `cd ${shellQuote(worktree.path)} && ${clearCallerIdentityEnv} MEGABRAIN_STATE_DIR=${shellQuote(root)} MEGABRAIN_DISPATCH_ID=${shellQuote(id)} MEGABRAIN_TMUX_SESSION=${shellQuote(session ?? "")} MEGABRAIN_TMUX_PANE=${shellQuote(pane ?? "")} ${command}`, "Enter", environment, process, true);
        outcome = sent.kind === "ok" ? { kind: "succeeded" } : { kind: "failed", failure: { call: `tmux send-keys --target ${pane ?? ""}`, detail: sent.error } };
      } else {
        const childHost = stringValue((await readJson(await dispatchPath(root, id, "meta.json")))?.childHost);
        const host = getHost(childHost);
        const identityVariable = host?.terminalIdentityVariable;
        const call = identityVariable === undefined ? undefined : host?.send({ workspaceId: worktree.workspaceId ?? parentWorkspace, terminalId, text: `cd ${shellQuote(worktree.path)} && env -u TMUX -u TMUX_PANE ${CALLER_IDENTITY_ENV_VARS.map((name) => `-u ${name}`).join(" ")} MEGABRAIN_STATE_DIR=${shellQuote(root)} ${identityVariable}=${shellQuote(terminalId)} MEGABRAIN_DISPATCH_ID=${shellQuote(id)} ${command}` });
        const sent = call?.kind === "ok" ? await runHostSend(childHost ?? "", process, call.value) : failed(resultError(call ?? failed("host command could not be built"), "host command could not be built"));
        outcome = sent.kind === "ok" ? { kind: "succeeded" } : { kind: "failed", failure: failureForCall(call?.kind === "ok" ? call.value : undefined, sent, `${childHost} terminal send`) };
      }
    } else if (step === "readiness-output-validation") {
      const waited = await waitForTmuxReadiness(options.agent, pane ?? "", readinessTimeoutMs, process);
      if (waited.kind !== "ok") readinessError = waited.error;
      outcome = waited.kind === "ok" ? { kind: "succeeded" } : { kind: "failed" };
    } else if (step === "prompt-transport") {
      if (runtime === "tmux") {
        // The readiness wait just proved the composer idle, so this is a normal submit, not a
        // queued one (submitKey(agent) is for queue-write.ts typing into a possibly busy
        // composer, where Codex's Tab queues instead of submitting). Every agent's composer
        // submits an idle prompt on Enter.
        const sent = await sendTmuxPair(root, pane ?? "", prompt, "Enter", environment, process);
        if (sent.kind !== "ok") outcome = { kind: "prompt-transport", status: "failed", failure: { call: `tmux send-keys --target ${pane ?? ""}`, detail: sent.error } };
        else outcome = { kind: "prompt-transport", status: await awaitReceipt(root, id, environment) ? "delivered" : "awaiting-receipt" };
      } else {
        const childHost = stringValue((await readJson(await dispatchPath(root, id, "meta.json")))?.childHost);
        const host = getHost(childHost);
        const call = host?.send({ workspaceId: worktree.workspaceId ?? parentWorkspace, terminalId, text: prompt });
        const sent = call?.kind === "ok" ? await runHostSend(childHost ?? "", process, call.value) : failed(resultError(call ?? failed("host prompt could not be built"), "host prompt could not be built"));
        if (sent.kind !== "ok") outcome = { kind: "prompt-transport", status: "failed", failure: failureForCall(call?.kind === "ok" ? call.value : undefined, sent, `${childHost} terminal send`) };
        else outcome = { kind: "prompt-transport", status: await awaitReceipt(root, id, environment) ? "delivered" : "awaiting-receipt" };
      }
    } else {
      outcome = { kind: "succeeded" };
    }

    const planned = decideSpawnStep({ ...baseInput(), step, outcome });
    if (planned.kind !== "ok") return planned;
    const plan = planned.value;
    state = plan.state;
    const metadataUpdate: RecordValue = {};
    if (step !== "prompt-transport" && step !== "prompt-confirmation" && step !== "state-persist") {
      Object.assign(metadataUpdate, { state: state.dispatch, processState: state.process, terminalState: state.terminal });
    }
    if (step === "prompt-publication" && outcome.kind === "succeeded") Object.assign(metadataUpdate, { promptPublication: "published", promptState: "awaiting-transport" });
    if (step === "prompt-transport" && outcome.kind === "prompt-transport") Object.assign(metadataUpdate, { promptTransport: outcome.status === "failed" ? "not-transported" : "transported", promptReceipt: outcome.status === "delivered" ? "received" : "pending", promptState: outcome.status === "delivered" ? "confirmed" : "awaiting-receipt" });
    if (step === "prompt-confirmation" && outcome.kind === "succeeded") Object.assign(metadataUpdate, { promptDelivered: true, promptDelivery: "delivered", promptState: "confirmed" });
    if (plan.action === "fail") Object.assign(metadataUpdate, { state: "failed", processState: "failed", terminalState: "released", reason: plan.reason, promptState: "failed" });
    await updateMeta(root, id, metadataUpdate);
    if (step === "prompt-transport" && outcome.kind === "prompt-transport" && outcome.status === "delivered") {
      const marked = await markRunningIfSpawning(root, id);
      if (marked.kind !== "ok") return marked;
    }
    if (plan.action === "fail") {
      const cleanupFailures = await cleanup(root, id, worktree, plan, process, dependencies, terminalId, session, pane, sessionOwned);
      return failureResult(plan, step === "readiness-wait" || step === "readiness-output-validation" ? readinessError : undefined, cleanupFailures);
    }
    if (plan.nextStep === null) {
      const output = { dispatchId: id, terminalId, tmuxPane: pane, state: state.dispatch, promptState: "awaiting-receipt", reconcile: plan.reconcile?.instruction ?? null, ...(terminalCreateAttempts === undefined ? {} : { terminalCreateAttempts }) };
      const attempts = terminalCreateAttempts !== undefined && terminalCreateAttempts > 1 ? `terminal-create-attempts: ${terminalCreateAttempts}\n` : "";
      return ok(parsed.value.json ? `${JSON.stringify(output)}\n` : `dispatch: ${id}\nstate: ${state.dispatch}\n${attempts}reconcile: ${plan.reconcile?.instruction ?? "none"}\n`, plan.exitCode);
    }
    step = plan.nextStep;
  }
}
