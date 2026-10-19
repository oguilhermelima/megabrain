import { resolve } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { projectScripts, type ProjectScriptName } from "../../core/project-scripts.js";
import { detectScriptPort } from "../../core/script-port.js";
import { executeProc } from "../../core/proc-runner.js";
import { failed, ok, type Result } from "../../core/result.js";
import { openDatabaseReadOnly } from "../../db/db.js";
import { listRepositories } from "../../db/queries/repositories.js";
import { repositoryCheckout } from "../../core/project-registry.js";

type Environment = Readonly<Record<string, string | undefined>>;
type ProcRow = Readonly<{ name: string; worktree: string; session: string; state: string; pid: number; port?: number }>;

const SCRIPTS: readonly ProjectScriptName[] = ["run", "build", "install"];

/** The repository a name or path selects: a checkout git knows, else a registered name. */
export async function resolveRepositoryPath(selector: string, environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const checkout = await repositoryCheckout(selector, process);
  if (checkout.kind === "ok") return ok(checkout.value.path);
  const opened = openDatabaseReadOnly(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  try {
    const matches = listRepositories(opened.value.db).filter((record) => record.name === selector || record.path === selector);
    if (matches.length > 1) return failed(`repository name is ambiguous: ${selector}; use a path`);
    return matches[0] === undefined ? failed(`repository not found: ${selector}`) : ok(matches[0].path);
  } catch (cause: unknown) {
    return failed(cause instanceof Error ? cause.message : String(cause));
  } finally { opened.value.close(); }
}

type Parsed = Readonly<{ selector: string; script: ProjectScriptName; worktree: string | undefined; command: string | undefined; port: number | undefined; admission: "wait" | "fail" | undefined; force: boolean; json: boolean }>;

function parse(verb: "run" | "stop", args: readonly string[]): Result<Parsed> {
  const usage = `Usage: megabrain repo ${verb} <name|path> [--script run|build|install] [--worktree <path>]${verb === "run" ? " [--command <cmd>] [--port <p>] [--admission wait|fail]" : " [--force]"} [--json]`;
  let selector: string | undefined;
  let script: ProjectScriptName = "run";
  const values: Record<string, string> = {};
  let force = false;
  let json = false;
  const flags = verb === "run" ? ["--script", "--worktree", "--command", "--port", "--admission"] : ["--script", "--worktree"];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--json") json = true;
    else if (argument === "--force" && verb === "stop") force = true;
    else if (flags.includes(argument)) {
      const value = args[++index];
      if (value === undefined || value === "" || value.startsWith("--")) return failed(`${argument} requires a value`, 2);
      values[argument] = value;
    } else if (argument.startsWith("-")) return failed(`unknown repo ${verb} option: ${argument}\n${usage}`, 2);
    else if (selector === undefined) selector = argument;
    else return failed(usage, 2);
  }
  if (selector === undefined) return failed(usage, 2);
  if (values["--script"] !== undefined) {
    const named = SCRIPTS.find((item) => item === values["--script"]);
    if (named === undefined) return failed(`--script accepts ${SCRIPTS.join(", ")}`, 2);
    script = named;
  }
  const admission = values["--admission"];
  if (admission !== undefined && admission !== "wait" && admission !== "fail") return failed("--admission must be wait or fail", 2);
  const port = values["--port"] === undefined ? undefined : Number(values["--port"]);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return failed("--port must be between 1 and 65535", 2);
  return ok({ selector, script, worktree: values["--worktree"], command: values["--command"], port, admission, force, json });
}

// One name per script: a worktree's records are keyed by it, so a second Run finds the first.
const procName = (script: ProjectScriptName): string => `repo-${script}`;

async function runningRow(name: string, worktree: string, environment: Environment, process: ProcessAdapter): Promise<ProcRow | undefined> {
  const listed = await executeProc(["list", "--json"], environment, process);
  if (listed.kind !== "ok") return undefined;
  return (JSON.parse(listed.value) as ProcRow[]).find((row) => row.name === name && row.worktree === worktree && row.state === "running");
}

function report(parsed: Parsed, worktree: string, command: string, row: ProcRow, alreadyRunning: boolean): string {
  const body = { script: parsed.script, name: procName(parsed.script), worktree, command, state: "running", alreadyRunning, session: row.session, pid: row.pid, port: row.port ?? null };
  return parsed.json ? `${JSON.stringify(body, null, 2)}\n` : `${alreadyRunning ? "already running" : "started"} ${body.name} (pid ${row.pid}${row.port === undefined ? "" : `, port ${row.port}`})\n`;
}

/**
 * Runs a project script as a managed process, so the resource policy, `proc list`, `status` and
 * `proc logs` all see it. The start is `proc start`; this only resolves what to start.
 */
export async function executeRepoRun(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const parsed = parse("run", args);
  if (parsed.kind !== "ok") return parsed;
  const request = parsed.value;
  const repository = await resolveRepositoryPath(request.selector, environment, process);
  if (repository.kind !== "ok") return repository;
  const worktree = resolve(request.worktree ?? request.selector);
  const scripts = await projectScripts(repository.value, environment);
  const command = request.command ?? scripts[request.script]?.command ?? "";
  if (command.trim() === "") return failed(`no ${request.script} command is set for ${repository.value}; set one with megabrain repo scripts`);
  const name = procName(request.script);
  const running = await runningRow(name, worktree, environment, process);
  if (running !== undefined) return ok(report(request, worktree, command, running, true));
  // A script that binds a port is started with it, so a taken port is refused up front. A framework's
  // default is a guess, not a promise, and waiting 30s for a guess to listen would kill a good run.
  const detected = request.script === "run" ? detectScriptPort(worktree, command) : null;
  const port = request.port ?? (detected === null || detected.source === "default" ? undefined : detected.port);
  const started = await executeProc([
    "start", "--name", name, "--worktree", worktree, "--cwd", worktree, "--shell", command, "--json",
    ...(request.admission === undefined ? [] : ["--admission", request.admission]),
    ...(port === undefined ? [] : ["--port", String(port)]),
  ], environment, process);
  if (started.kind !== "ok") return started;
  return ok(report(request, worktree, command, JSON.parse(started.value) as ProcRow, false));
}

export async function executeRepoStop(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const parsed = parse("stop", args);
  if (parsed.kind !== "ok") return parsed;
  const request = parsed.value;
  const worktree = resolve(request.worktree ?? request.selector);
  const stopped = await executeProc(["stop", procName(request.script), "--worktree", worktree, ...(request.force ? ["--force"] : [])], environment, process);
  if (stopped.kind !== "ok") return stopped;
  return ok(request.json ? `${JSON.stringify({ script: request.script, name: procName(request.script), worktree, state: "stopped" }, null, 2)}\n` : stopped.value);
}
