import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { getAgent } from "../../agents/index.js";
import { decideSpawnStep, resolveAutoSpawnRuntime, type SpawnDecisionInput, type SpawnFailure, type SpawnPlan, type SpawnRuntime, type SpawnState, type SpawnStep, type WorktreeOwnership } from "../../core/spawn-plan.js";
import { checkDispatchTransition } from "../../core/dispatch-states.js";
import { classifyLiveness, waitForStableIdle } from "../../core/liveness.js";
import { failed, ok, unknown, type Result } from "../../core/result.js";
import type { DatabaseHandle } from "../../db/db.js";
import { resolveStateDirectory } from "../../core/state.js";
import { CALLER_IDENTITY_ENV_VARS, type CallerIdentity } from "../../core/context.js";
import { appendMessage, resolveCaller, type QueueEnvironment } from "./queue-write.js";
import { repoFromOrca } from "./repository-selector.js";
import { executeWorktreeCreate } from "./worktree-write.js";
import { getHost, runHostSend, type HostCommand, type HostProvider } from "../../hosts/index.js";
import { createTmuxSession, dispatchTmuxProcess, getTmux, onAppTmuxServer, sendTmuxPair, splitTmuxWorktreePane, verifyTmuxPane, waitForTmuxSession } from "../../hosts/tmux.js";
import { decideTmuxPlacement, tmuxWorktreeSessionName } from "../../core/tmux-placement.js";
import { usageText } from "../../core/usage.js";
import { PROMPT_BUDGET_TMUX_BYTES, promptByteLength } from "../../core/prompt-budget.js";
import { readOnlyStateDatabase, getInstallState, listTmuxSessions, getTmuxSession, getTmuxSessionByStableId, deleteTmuxSession, putTmuxSession, listDispatches, createDispatch, getDispatch, mutateDispatch, listMessages, appendMessage as appendDatabaseMessage, acquireLease, releaseLease } from "../../adapters/state-db.js";
import { resolveAgentDescriptor } from "../../agents/index.js";
import { findClaudeSessionPid } from "../../agents/claude-session.js";
import { grokLeaderSocket } from "../../agents/grok-leader.js";
import { agyParentKey, recordAgyLanguageServer } from "../../agents/agy-ls.js";
import { setTmuxChatPane } from "../../core/chat-pane.js";
import { hasCompactThreshold, parseContextThreshold, thresholdFields, validateContextPolicy, type ContextPolicy } from "../../core/context-policy.js";
import { argvBriefStarted, awaitArgvPrompt, transportTmuxPrompt, type PromptTransportOutcome } from "./spawn-prompt.js";
import { startSupervisorWorker } from "./supervise.js";
import { notifyAdmissionStatus } from "./admission-notify.js";
import { checkTerminalFlag, openViewer, viewerLine } from "./terminal-open.js";
import { resolveGrokSessionId } from "../../core/context-meter.js";
import { join } from "node:path";
import { decideAdmission, DEFAULT_AGENT_COST_BYTES } from "../../core/admission.js";
import { readAdmissionPolicy, estimateTypicalRssByAgent } from "../../adapters/state-db.js";
import { readMachineResources } from "../../core/resources.js";
import { registerMegabrainRepository } from "../../core/project-registry.js";
import type { AgentUpdateRuntime } from "../../core/agent-update.js";

export const TERMINAL_CREATE_MAX_ATTEMPTS = 6;
export const TERMINAL_CREATE_DEADLINE_MS = 2000;
export const TERMINAL_CREATE_BACKOFF_MS = 250;
export const TERMINAL_CREATE_TIMEOUT_MS = 30_000;
const PROMPT_BUDGET_ARGV_BYTES = 262144;

export const SPAWN_ENVIRONMENT_HELP = `
Environment:
  MEGABRAIN_PROMPT_ARGV_GRACE_MS      Milliseconds to wait for an agent to submit the brief on its command line before pasting it (default 30000).
  MEGABRAIN_PROMPT_VERIFY_TIMEOUT_MS  Milliseconds to wait for the pasted prompt to show whole in the composer (default 2000).
  MEGABRAIN_PROMPT_SUBMIT_TIMEOUT_MS  Milliseconds to wait for a turn to start after each Enter (default 3000).
    Spawn has no receipt deadline. Once the agent has taken the prompt it returns, and a missing
    megabrain received is only recorded; the supervisor judges the prompt from the terminal.
`;

export type SpawnEnvironment = QueueEnvironment & Readonly<{
  readonly HOME?: string;
  readonly MEGABRAIN_SESSION_ID?: string;
  readonly MEGABRAIN_SESSION_HOST?: string;
  readonly MEGABRAIN_WORKSPACE_ID?: string;
  readonly MEGABRAIN_TMUX_SESSION?: string;
  readonly SUPERSET_WORKSPACE_ID?: string;
  readonly MEGABRAIN_SPAWN_DISPATCH_ID?: string;
  readonly MEGABRAIN_AGENT_READY_TIMEOUT_MS?: string;
  readonly MEGABRAIN_PROMPT_VERIFY_TIMEOUT_MS?: string;
  readonly MEGABRAIN_PROMPT_SUBMIT_TIMEOUT_MS?: string;
  readonly MEGABRAIN_PROMPT_ARGV_GRACE_MS?: string;
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
  readonly agentUpdates?: AgentUpdateRuntime;
}>;

export type SpawnOptions = Readonly<{
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
  readonly terminal?: string;
  readonly browser: boolean;
  readonly agentArgs: readonly string[];
  readonly json: boolean;
  readonly contextPolicy?: ContextPolicy;
  readonly admission: "wait" | "fail";
  readonly keepOpen?: boolean;
}>;

export type RecordValue = Record<string, unknown>;

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseBoolean(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const unsupportedOptions = ["--from", "--parent", "--no-parent", "--issue", "--linear-issue", "--pr", "--chain", "--orchestrate"] as const;

export function parseArgs(args: readonly string[]): Result<SpawnOptions> {
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
  let terminal: string | undefined;
  let browser = false;
  let json = false;
  let ceilingFields: ContextPolicy = {};
  let compactFields: ContextPolicy = {};
  let loop: boolean | undefined;
  let maxIterations: number | undefined;
  let admission: "wait" | "fail" = "wait";
  let keepOpen = false;
  const agentArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--keep-open") keepOpen = true;
    else if (arg === "--browser") browser = true;
    else if (arg === "--loop") loop = true;
    else if (arg === "--no-loop") loop = false;
    else if (arg === "--admission") {
      const value = args[index + 1];
      if (value !== "wait" && value !== "fail") return failed("--admission requires wait or fail", 2);
      admission = value;
      index += 1;
    }
    else if (unsupportedOptions.includes(arg as typeof unsupportedOptions[number])) return failed(`unsupported orchestrate spawn option: ${arg}`, 2);
    else if (arg === "--tmux") {
      const value = args[index + 1];
      if (value === undefined) return failed("--tmux requires true or false", 2);
      const parsed = parseBoolean(value);
      if (parsed === undefined) return failed("--tmux requires true or false", 2);
      tmux = parsed;
      index += 1;
    } else if (arg === "--terminal") {
      const value = args[index + 1];
      if (value === undefined || value === "") return failed("--terminal requires a non-empty value", 2);
      const checked = checkTerminalFlag(value);
      if (checked.kind !== "ok") return checked;
      terminal = value;
      index += 1;
    } else if (["--worktree", "--repo", "--branch", "--base", "--name", "--agent", "--model", "--effort", "--prompt", "--label", "--agent-arg", "--context-ceiling", "--compact-at", "--max-iterations"].includes(arg)) {
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
      else if (arg === "--context-ceiling" || arg === "--compact-at") {
        const threshold = parseContextThreshold(value);
        if (threshold.kind !== "ok") return failed(`${arg}: ${threshold.error}`, 2);
        if (arg === "--context-ceiling") ceilingFields = thresholdFields("contextCeiling", threshold.value);
        else compactFields = thresholdFields("compactAt", threshold.value);
      }
      else if (arg === "--max-iterations") maxIterations = Number(value);
      else agentArgs.push(value);
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      return ok({ worktree: "", agent: "", model: null, effort: null, prompt: "", label: null, tmux: null, browser, agentArgs, json, admission, keepOpen });
    } else return failed(`unknown orchestrate spawn option: ${arg}`, 2);
  }
  if (worktree === undefined && (repo === undefined || branch === undefined)) {
    return failed("either --worktree <path> or --repo <name|path> with --branch <branch> is required", 2);
  }
  if (agent === undefined) return failed("--agent is required", 2);
  if (prompt === undefined) return failed("--prompt is required", 2);
  const hasPolicy = Object.keys(ceilingFields).length > 0 || Object.keys(compactFields).length > 0 || loop !== undefined || maxIterations !== undefined;
  const contextPolicy: ContextPolicy | undefined = hasPolicy ? { ...ceilingFields, ...compactFields, loop, maxIterations } : undefined;
  if (contextPolicy !== undefined) {
    const valid = validateContextPolicy(contextPolicy);
    if (valid.kind !== "ok") return valid;
  }
  return ok({ worktree, repo, branch, base, name, agent, model, effort, prompt, label, tmux, terminal, browser, agentArgs, json, contextPolicy, admission, keepOpen });
}

export function dispatchId(environment: SpawnEnvironment): string {
  const supplied = environment.MEGABRAIN_SPAWN_DISPATCH_ID;
  return supplied !== undefined && /^[A-Za-z0-9._-]+$/.test(supplied)
    ? supplied
    : `dispatch-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

// The installed module state selects tmux; absent state falls back to the host runtime.
export function tmuxRuntimeInstalled(environment: SpawnEnvironment): boolean {
  const database = readOnlyStateDatabase(environment);
  if (database.kind !== "ok") return false;
  const state = getInstallState(database.value);
  return state.kind === "ok" && (state.value["tmux-runtime"] as { readonly installed?: boolean } | undefined)?.installed === true;
}

// The workspace id a parent may pass down to the child host provider. Unrelated to caller
// identity: kept as its own lookup rather than folded into resolveCaller.
export function parentWorkspaceId(environment: SpawnEnvironment): string | null {
  return environment.MEGABRAIN_WORKSPACE_ID ?? environment.SUPERSET_WORKSPACE_ID ?? null;
}

// The tmux channel to type a notification into for this dispatch's parent. This is the pane the
// parent itself was launched into (MEGABRAIN_TMUX_SESSION, set by whatever spawned the parent),
// not a fresh probe of the parent's current caller identity — the two usually agree, but this
// field exists purely for message delivery, so it stays independent of resolveCaller.
export function parentTmuxChannel(environment: SpawnEnvironment): Readonly<{ tmuxSession: string | null; tmuxPane: string | null }> {
  return { tmuxSession: environment.TMUX_PANE ? environment.MEGABRAIN_TMUX_SESSION ?? null : null, tmuxPane: environment.TMUX_PANE ?? null };
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// A tmux pane inherits the whole environment of whatever launched the pane's shell, and a host
// terminal's shell can too — so without this, a child started by a caller who has
// CLAUDE_CODE_SESSION_ID / ORCA_STRUCTURED_SESSION / etc. set would inherit them, resolve as its
// parent's own identity, and pass the parent's ownership checks. `env -u` for each name in
// CALLER_IDENTITY_ENV_VARS strips them before the launch line's own MEGABRAIN_* assignments run.
export const clearCallerIdentityEnv = `env ${CALLER_IDENTITY_ENV_VARS.map((name) => `-u ${name}`).join(" ")}`;

export function agyLogFile(stateRoot: string, dispatchId: string): string {
  return join(stateRoot, "agy-logs", `${dispatchId}.log`);
}

export function finalPrompt(options: SpawnOptions, id: string): string {
  const label = options.label ?? `${options.agent} ${options.worktree}`;
  return `[megabrain dispatch: ${label}]\n\nREQUIRED: Run megabrain received first.\nREQUIRED: Ask with megabrain ask; poll megabrain check --timeout until answered. Never proceed on a default.\nREQUIRED: Finish with megabrain done, including outcome and evidence.\nCRITICAL: Never close your own dispatch.\nFor ask and done, start with one plain-language sentence a nontechnical person understands; use no filenames, commands, or counts.\n\nDispatch identity: ${id}\n\n${options.prompt}`;
}

// Bytes, not characters: a prompt that fits the CLI's character limit can still overflow the
// pane's paste buffer or the OS argv limit once it is UTF-8 encoded.
export function validatePromptBudget(prompt: string, runtime: SpawnRuntime): Result<void> {
  const transport = runtime === "tmux" ? "tmux" : "argv";
  const limit = runtime === "tmux" ? PROMPT_BUDGET_TMUX_BYTES : PROMPT_BUDGET_ARGV_BYTES;
  const actual = promptByteLength(prompt);
  if (actual > limit) return failed(`prompt is too large for ${transport} delivery: ${actual} bytes (limit: ${limit} bytes)`, 2);
  return ok(undefined);
}

export async function writePromptFile(root: string, id: string, prompt: string): Promise<string | undefined> {
  const directory = join(root, "prompts");
  const file = join(directory, `${id}.txt`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, prompt, { mode: 0o600 });
    return file;
  } catch {
    return undefined;
  }
}

export function agentReadyTimeoutMs(environment: SpawnEnvironment): number {
  const raw = environment.MEGABRAIN_AGENT_READY_TIMEOUT_MS;
  if (raw !== undefined && /^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return value;
  }
  return 10000;
}

// Reuses the same output classification `orchestrate liveness` uses (core/liveness.ts,
// getTmux().capturePane): the tmux runtime has no blocking "wait until ready" call the way the
// host providers do, so readiness is read from the pane's own text until the agent's composer
// reports idle or the deadline passes. A single idle poll is not proof the composer is still
// there to type into: something else (an update-check modal, for one real example) can replace
// it between polls. So readiness only succeeds once idle has held continuously for
// TMUX_READINESS_STABLE_MS — any non-idle observation resets the stability window rather than
// failing outright, since the composer may still settle before the overall deadline.
