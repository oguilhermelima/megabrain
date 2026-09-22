import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { dispatchPath } from "../../adapters/dispatch-store.js";
import { submitKey, getAgent } from "../../agents/index.js";
import { decideSpawnStep, type SpawnDecisionInput, type SpawnPlan, type SpawnRuntime, type SpawnState, type SpawnStep, type WorktreeOwnership } from "../../core/spawn-plan.js";
import { failed, ok, unknown, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { appendMessage, atomicJson, readJson, type QueueEnvironment } from "./queue-write.js";
import { executeWorktreeCreate } from "./worktree-write.js";
import { getHost } from "../../hosts/index.js";
import { createTmuxSession, getTmux, sendTmuxPair, splitTmuxWindow, waitForTmuxSession } from "../../hosts/tmux.js";

type SpawnEnvironment = QueueEnvironment & Readonly<{
  readonly HOME?: string;
  readonly MEGABRAIN_SESSION_ID?: string;
  readonly MEGABRAIN_SESSION_HOST?: string;
  readonly MEGABRAIN_WORKSPACE_ID?: string;
  readonly MEGABRAIN_TMUX_SESSION?: string;
  readonly SUPERSET_WORKSPACE_ID?: string;
  readonly MEGABRAIN_SPAWN_DISPATCH_ID?: string;
  readonly MEGABRAIN_SPAWN_RUNTIME?: string;
}>;

export type SpawnWorktree = Readonly<{
  readonly path: string;
  readonly branch: string;
  readonly ownership: WorktreeOwnership;
  readonly workspaceId: string | null;
}>;

export type SpawnDependencies = Readonly<{
  readonly resolveWorktree?: (target: string, options: SpawnOptions, environment: SpawnEnvironment, process: ProcessAdapter) => Promise<Result<SpawnWorktree>>;
  readonly removeWorktree?: (path: string, process: ProcessAdapter) => Promise<Result<void>>;
}>;

type SpawnOptions = Readonly<{
  readonly worktree: string;
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

const unsupportedOptions = ["--from", "--parent", "--no-parent", "--issue", "--linear-issue", "--pr", "--base", "--name", "--chain", "--orchestrate"] as const;

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
  if (worktree === undefined) return failed("--worktree is required", 2);
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

function parent(environment: SpawnEnvironment): Readonly<{ id: string; host: string; workspaceId: string | null; tmuxSession: string | null; tmuxPane: string | null }> {
  const host = environment.MEGABRAIN_SESSION_HOST ?? (environment.ORCA_TERMINAL_HANDLE ? "orca" : environment.SUPERSET_TERMINAL_ID ? "superset" : environment.TMUX ? "tmux" : "unknown");
  const id = environment.MEGABRAIN_SESSION_ID ?? environment.ORCA_TERMINAL_HANDLE ?? environment.SUPERSET_TERMINAL_ID ?? "";
  const workspaceId = environment.MEGABRAIN_WORKSPACE_ID ?? environment.SUPERSET_WORKSPACE_ID ?? null;
  return { id, host, workspaceId, tmuxSession: environment.TMUX_PANE ? environment.MEGABRAIN_TMUX_SESSION ?? null : null, tmuxPane: environment.TMUX_PANE ?? null };
}

function commandFor(options: SpawnOptions): string {
  const parts = [options.agent];
  if (options.model !== null) parts.push(options.agent === "codex" ? `-c model=${JSON.stringify(options.model)}` : `--model ${JSON.stringify(options.model)}`);
  if (options.effort !== null && options.agent === "codex") parts.push(`-c reasoning_effort=${JSON.stringify(options.effort)}`);
  if (options.browser) parts.push("--browser");
  parts.push(...options.agentArgs.map((arg) => JSON.stringify(arg)));
  return parts.join(" ");
}

function finalPrompt(options: SpawnOptions, id: string): string {
  const label = options.label ?? `${options.agent} ${options.worktree}`;
  return `[megabrain dispatch: ${label}]\n\nThis is a managed megabrain dispatch. Before starting work, run megabrain received to confirm that you received this prompt. If you need coordinator input, run megabrain ask "your question"; wait with megabrain check until a reply arrives, then run megabrain ack <delivery-id> to confirm it. When the requested work is complete, run megabrain done "short outcome summary". Do not print protocol markers and do not continue past an unanswered question.\n\nDispatch identity: ${id}\n\n${options.prompt}`;
}

async function runGit(process: ProcessAdapter, args: readonly string[]): Promise<Result<string>> {
  const result = await process.run("git", args);
  return result.kind === "ok" ? ok(result.value.stdout.trim()) : failed(result.kind === "failed" ? result.error : result.reason, result.exitCode);
}

function existingWorktreeError(options: SpawnOptions): string | undefined {
  const flags = [options.base === undefined ? undefined : "--base", options.name === undefined ? undefined : "--name"].filter((flag): flag is string => flag !== undefined);
  return flags.length === 0 ? undefined : `worktree already exists; ${flags.join(" and ")} cannot be applied`;
}

export async function defaultResolveWorktree(target: string, options: SpawnOptions, environment: SpawnEnvironment, process: ProcessAdapter): Promise<Result<SpawnWorktree>> {
  const direct = await realpath(target).catch(() => undefined);
  if (direct !== undefined) {
    const top = await runGit(process, ["-C", direct, "rev-parse", "--show-toplevel"]);
    if (top.kind !== "ok") return failed(`worktree path is not a Git directory: ${target}`);
    const existingError = existingWorktreeError(options);
    if (existingError !== undefined) return failed(existingError);
    const branch = await runGit(process, ["-C", direct, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    return ok({ path: direct, branch: branch.kind === "ok" && branch.value !== "" ? branch.value : "detached", ownership: "existing", workspaceId: environment.MEGABRAIN_WORKSPACE_ID ?? environment.SUPERSET_WORKSPACE_ID ?? null });
  }
  const listed = await runGit(process, ["worktree", "list", "--porcelain"]);
  if (listed.kind === "ok") {
    let path = "";
    for (const line of listed.value.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      if (line === `branch refs/heads/${target}` || (line.startsWith("worktree ") && basename(path) === target)) {
        const existingError = existingWorktreeError(options);
        if (existingError !== undefined) return failed(existingError);
        return ok({ path, branch: line.startsWith("branch refs/heads/") ? line.slice(18) : target, ownership: "existing", workspaceId: environment.MEGABRAIN_WORKSPACE_ID ?? environment.SUPERSET_WORKSPACE_ID ?? null });
      }
    }
  }
  if (options.repo === undefined || options.branch === undefined) return failed(`worktree not found: ${target}`);
  const createArgs = ["--repo", options.repo, "--branch", options.branch, "--json"];
  if (options.model !== null) createArgs.push("--model", options.model);
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

async function initialMeta(id: string, options: SpawnOptions, worktree: SpawnWorktree, parentContext: ReturnType<typeof parent>, runtime: SpawnRuntime, terminalId: string, session: string | null, pane: string | null): Promise<RecordValue> {
  const now = new Date().toISOString();
  return {
    dispatchId: id,
    parentSessionId: parentContext.id,
    parentHost: parentContext.host,
    parentWorkspaceId: parentContext.workspaceId,
    parentTmuxSession: parentContext.tmuxSession,
    parentTmuxPane: parentContext.tmuxPane,
    childHost: parentContext.host,
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
    label: options.label ?? `${options.agent} ${options.worktree}`,
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

async function cleanup(root: string, id: string, worktree: SpawnWorktree, plan: SpawnPlan, process: ProcessAdapter, dependencies: SpawnDependencies, terminalId: string, session: string | null, pane: string | null, sessionOwned: boolean): Promise<void> {
  if (plan.cleanup.kind !== "required") return;
  if (plan.cleanup.runtime === "tmux" && session !== null) {
    if (sessionOwned) await getTmux().killSession(session, process);
    else if (pane !== null) await getTmux().killPane(pane, process);
  }
  if (plan.cleanup.runtime === "host") {
    const provider = getHost(stringValue((await readJson(await dispatchPath(root, id, "meta.json")))?.childHost));
    const workspaceId = stringValue((await readJson(await dispatchPath(root, id, "meta.json")))?.workspaceId) || null;
    if (provider !== undefined && terminalId !== "") {
      const call = provider.close({ workspaceId, terminalId });
      if (call.kind === "ok") await process.run(call.value.command, call.value.args);
    }
  }
  if (plan.cleanup.worktree === "remove") await (dependencies.removeWorktree ?? defaultRemoveWorktree)(worktree.path, process);
}

function failureResult(plan: SpawnPlan): Result<string> {
  return failed(plan.reason ?? "spawn failed", plan.exitCode);
}

export async function executeSpawn(args: readonly string[], environment: SpawnEnvironment, process: ProcessAdapter, dependencies: SpawnDependencies = {}): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok("Usage: megabrain orchestrate spawn --repo <name|path> --branch <branch> [--agent <id>] [--chain <name>] [--model <model>] [--base <ref>] [--name <slug>] [--effort <level>] [--prompt <text>] [--label <text>] [--worktree <path>] [--tmux true|false] [--browser] [--agent-arg <flag>] [--json]\n");
  const parsed = parseArgs(args);
  if (parsed.kind !== "ok") return parsed;
  const options = parsed.value;
  const agent = getAgent(options.agent);
  if (agent === undefined) return unknown(`agent cannot be determined: ${options.agent}`);
  const key = submitKey(options.agent);
  if (key.kind !== "ok") return key;
  const worktreeResult = await (dependencies.resolveWorktree ?? defaultResolveWorktree)(options.worktree, options, environment, process);
  if (worktreeResult.kind !== "ok") return worktreeResult;
  const worktree = worktreeResult.value;
  const id = dispatchId(environment);
  const parentContext = parent(environment);
  const runtime: SpawnRuntime = options.tmux ?? (environment.MEGABRAIN_SPAWN_RUNTIME === "tmux") ? "tmux" : "host";
  const command = commandFor(options);
  const prompt = finalPrompt(options, id);
  let terminalId = "";
  let session: string | null = null;
  let pane: string | null = null;
  let sessionOwned = true;

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
      const created = await createTmuxSession(session, worktree.path, "bash", process);
      if (created.kind !== "ok") return created;
    }
    const waited = await waitForTmuxSession(session, process);
    if (waited.kind !== "ok") return waited;
    if (pane === null) {
      const panes = await getTmux().panesForSession(session, process);
      if (panes.kind !== "ok" || panes.value[0] === undefined) return failed(`tmux session ${session} has no pane`);
      pane = panes.value[0];
    }
    terminalId = parentContext.id || "unknown-host-terminal";
  } else {
    const host = getHost(parentContext.host);
    if (host === undefined) return failed(`cannot launch agent from unknown orchestration host: ${parentContext.host}`);
    const created = host.create({ workspaceId: worktree.workspaceId ?? parentContext.workspaceId, worktreePath: worktree.path, title: `${options.agent} ${worktree.path}`, command: "bash" });
    if (created.kind !== "ok") return created;
    const response = await process.run(created.value.command, created.value.args);
    if (response.kind !== "ok") return failed(response.error, response.exitCode);
    terminalId = host.terminalIdentity(JSON.parse(response.value.stdout || "{}")) ?? "";
    if (terminalId === "") return failed(`${parentContext.host} terminal create returned no terminal identity`);
  }

  const root = resolveStateDirectory(environment);
  const directory = await dispatchPath(root, id, "");
  await mkdir(directory, { recursive: true });
  const meta = await initialMeta(id, options, worktree, parentContext, runtime, terminalId, session, pane);
  await atomicJson(`${directory}/meta.json`, meta);
  let state: SpawnState = { dispatch: "spawning", process: "starting", terminal: "owned" };
  let step: SpawnStep = runtime === "tmux" ? "transcript-start" : "prompt-publication";
  const baseInput = (): Omit<SpawnDecisionInput, "step" | "outcome"> => ({ dispatchId: id, runtime, worktree: worktree.ownership, state });

  while (true) {
    let outcome: SpawnDecisionInput["outcome"];
    if (step === "prompt-publication") {
      const appended = await appendMessage(root, id, "parent", "prompt", prompt, parentContext.id, environment, process);
      outcome = appended.kind === "ok" ? { kind: "succeeded" } : { kind: "failed" };
    } else if (step === "command-submission") {
      if (runtime === "tmux") {
        const sent = await sendTmuxPair(root, pane ?? "", `cd ${JSON.stringify(worktree.path)} && MEGABRAIN_DISPATCH_ID=${JSON.stringify(id)} MEGABRAIN_TMUX_SESSION=${JSON.stringify(session ?? "")} MEGABRAIN_TMUX_PANE=${JSON.stringify(pane ?? "")} ${command}`, key.value, environment, process);
        outcome = sent.kind === "ok" ? { kind: "succeeded" } : { kind: "failed" };
      } else {
        const childHost = stringValue((await readJson(await dispatchPath(root, id, "meta.json")))?.childHost);
        const host = getHost(childHost);
        const call = host?.send({ workspaceId: worktree.workspaceId ?? parentContext.workspaceId, terminalId, text: `cd ${JSON.stringify(worktree.path)} && MEGABRAIN_DISPATCH_ID=${JSON.stringify(id)} ${command}` });
        const sent = call?.kind === "ok" ? await process.run(call.value.command, call.value.args) : failed("host command could not be built");
        outcome = sent.kind === "ok" ? { kind: "succeeded" } : { kind: "failed" };
      }
    } else if (step === "prompt-transport") {
      if (runtime === "tmux") {
        const sent = await sendTmuxPair(root, pane ?? "", prompt, key.value, environment, process);
        if (sent.kind !== "ok") outcome = { kind: "prompt-transport", status: "failed" };
        else outcome = { kind: "prompt-transport", status: await awaitReceipt(root, id, environment) ? "delivered" : "awaiting-receipt" };
      } else {
        const childHost = stringValue((await readJson(await dispatchPath(root, id, "meta.json")))?.childHost);
        const host = getHost(childHost);
        const call = host?.send({ workspaceId: worktree.workspaceId ?? parentContext.workspaceId, terminalId, text: prompt });
        const sent = call?.kind === "ok" ? await process.run(call.value.command, call.value.args) : failed("host prompt could not be built");
        if (sent.kind !== "ok") outcome = { kind: "prompt-transport", status: "failed" };
        else outcome = { kind: "prompt-transport", status: await awaitReceipt(root, id, environment) ? "delivered" : "awaiting-receipt" };
      }
    } else {
      outcome = { kind: "succeeded" };
    }

    const planned = decideSpawnStep({ ...baseInput(), step, outcome });
    if (planned.kind !== "ok") return planned;
    const plan = planned.value;
    state = plan.state;
    const metadataUpdate: RecordValue = { state: state.dispatch, processState: state.process, terminalState: state.terminal };
    if (step === "prompt-publication" && outcome.kind === "succeeded") Object.assign(metadataUpdate, { promptPublication: "published", promptState: "awaiting-transport" });
    if (step === "prompt-transport" && outcome.kind === "prompt-transport") Object.assign(metadataUpdate, { promptTransport: outcome.status === "failed" ? "not-transported" : "transported", promptReceipt: outcome.status === "delivered" ? "received" : "pending", promptState: outcome.status === "delivered" ? "confirmed" : "awaiting-receipt" });
    if (step === "prompt-confirmation" && outcome.kind === "succeeded") Object.assign(metadataUpdate, { promptDelivered: true, promptDelivery: "delivered", promptState: "confirmed" });
    if (plan.action === "fail") Object.assign(metadataUpdate, { state: "failed", processState: "failed", terminalState: "released", reason: plan.reason, promptState: "failed" });
    await updateMeta(root, id, metadataUpdate);
    if (plan.action === "fail") {
      await cleanup(root, id, worktree, plan, process, dependencies, terminalId, session, pane, sessionOwned);
      return failureResult(plan);
    }
    if (plan.nextStep === null) {
      const output = { dispatchId: id, terminalId, tmuxPane: pane, state: state.dispatch, promptState: "awaiting-receipt", reconcile: plan.reconcile?.instruction ?? null };
      return ok(parsed.value.json ? `${JSON.stringify(output)}\n` : `dispatch: ${id}\nstate: ${state.dispatch}\nreconcile: ${plan.reconcile?.instruction ?? "none"}\n`, plan.exitCode);
    }
    step = plan.nextStep;
  }
}
