import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile, mkdtemp } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { getTmux } from "../../hosts/tmux.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { blockPresent, nextBackupPath, parseTmuxOptions, removeManagedBlock, rewriteManagedBlock, shellFor, TMUX_TUNE_END, TMUX_TUNE_SOURCE, TMUX_TUNE_START, tmuxUsage, tunePlan, validateManagedConfig, wrapperPlan, wrapperSource, TMUX_WRAPPER_END, TMUX_WRAPPER_START, type TmuxOptions, type TmuxVerb } from "../../core/tmux.js";

type Environment = Readonly<Record<string, string | undefined>>;
type FileReading = Readonly<{ exists: boolean; regular: boolean; content: string }>;
type TmuxContext = Readonly<{
  readonly config: string;
  readonly install: string;
  readonly repo: string;
  readonly start: string;
  readonly end: string;
  readonly source: string;
}>;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function errorResult(message: string, jsonOutput: boolean, verb: TmuxVerb, action: "apply" | "revert"): Result<string> {
  if (!jsonOutput) return failed(message);
  return { kind: "ok", value: json({ ok: false, action, error: action === "revert" ? `could not revert tmux ${verb}` : `could not apply tmux ${verb}` }), exitCode: 1, stderr: `megabrain: ${message}\n` };
}

function home(environment: Environment): string {
  return environment.HOME ?? process.env.HOME ?? "";
}

function root(environment: Environment): string {
  return resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT);
}

function readPath(path: string): Promise<FileReading> {
  return stat(path).then(async (metadata) => {
    if (!metadata.isFile()) return { exists: true, regular: false, content: "" };
    return { exists: true, regular: true, content: await readFile(path, "utf8") };
  }).catch(() => ({ exists: false, regular: false, content: "" }));
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const directory = await mkdtemp(join(dirname(path), `.${basename(path)}.`));
  const temporary = join(directory, basename(path));
  try {
    await writeFile(temporary, content);
    await rename(temporary, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function installFile(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const directory = await mkdtemp(join(dirname(destination), `.${basename(destination)}.`));
  const temporary = join(directory, basename(destination));
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function existingEntries(directory: string, prefix: string): Promise<ReadonlySet<string>> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return new Set<string>();
  }
  return new Set(names.filter((name) => name.startsWith(prefix)).map((name) => join(directory, name)));
}

async function backupPaths(directory: string, prefix: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const name of names.filter((entry) => entry.startsWith(prefix)).sort()) {
    const path = join(directory, name);
    try {
      if ((await stat(path)).isFile()) paths.push(path);
    } catch {
      // A concurrently removed backup is absent from the report.
    }
  }
  return paths;
}

async function dateStamp(processAdapter: ProcessAdapter): Promise<string> {
  const result = await processAdapter.run("date", ["-u", "+%Y%m%dT%H%M%SZ"]);
  if (result.kind === "ok") return result.value.stdout.trim();
  return new Date().toISOString().replace(/[-:]|\.\d{3}/g, "").replace("T", "T").replace("Z", "Z");
}

async function backupPath(context: TmuxContext, config: FileReading, processAdapter: ProcessAdapter): Promise<string | undefined> {
  if (!config.regular) return undefined;
  const stamp = await dateStamp(processAdapter);
  const existing = await existingEntries(dirname(context.config), `${basename(context.config)}.megabrain-backup-`);
  return nextBackupPath(context.config, true, stamp, existing);
}

function configContext(environment: Environment, verb: TmuxVerb): TmuxContext {
  const homeDirectory = home(environment);
  if (verb === "tune") return {
    config: `${homeDirectory}/.tmux.conf`,
    install: `${homeDirectory}/.megabrain/tmux/megabrain.tmux.conf`,
    repo: join(root(environment), "tmux/megabrain.tmux.conf"),
    start: TMUX_TUNE_START,
    end: TMUX_TUNE_END,
    source: TMUX_TUNE_SOURCE,
  };
  const shell = shellFor(environment);
  const bash = shell === "bash";
  return {
    config: `${homeDirectory}/${bash ? ".bashrc" : ".zshrc"}`,
    install: `${homeDirectory}/${bash ? ".megabrain/bash/megabrain-agent-tmux.bash" : ".megabrain/zsh/megabrain-agent-tmux.zsh"}`,
    repo: join(root(environment), bash ? "bash/megabrain-agent-tmux.bash" : "zsh/megabrain-agent-tmux.zsh"),
    start: TMUX_WRAPPER_START,
    end: TMUX_WRAPPER_END,
    source: wrapperSource(bash ? "bash" : "zsh") ?? "source ~/.megabrain/zsh/megabrain-agent-tmux.zsh",
  };
}

function wrapperBackupDirectory(environment: Environment): string {
  return home(environment);
}

async function serverState(processAdapter: ProcessAdapter): Promise<Readonly<{ running: boolean; rgb: boolean }>> {
  const running = (await getTmux().listSessions(processAdapter)).kind === "ok";
  if (!running) return { running: false, rgb: false };
  const features = await getTmux().globalOption("terminal-features", processAdapter);
  if (features.kind !== "ok") return { running: true, rgb: false };
  const rgb = features.value.split(",").some((entry) => entry.split(":").includes("RGB"));
  return { running: true, rgb };
}

async function apply(context: TmuxContext, config: FileReading, processAdapter: ProcessAdapter, verb: TmuxVerb): Promise<Result<Readonly<{ backup?: string; serverApplied: boolean }>>> {
  const repository = await readPath(context.repo);
  if (!repository.regular) return failed(`${verb === "tune" ? "tmux tuning" : "tmux wrapper"} file is missing: ${context.repo}`);
  if (config.exists && !config.regular) return failed(verb === "tune" ? `tmux config exists but is not a regular file: ${context.config}` : `zsh config exists but is not a regular file: ${context.config}`);
  if (!validateManagedConfig(config.content, context.start, context.end)) return failed(verb === "tune" ? `tmux config has an incomplete legacy tuning block: ${context.config}` : `zsh config has an incomplete megabrain tmux wrapper block: ${context.config}`);
  let backup: string | undefined;
  try {
    backup = await backupPath(context, config, processAdapter);
    if (backup !== undefined) await copyFile(context.config, backup);
    await installFile(context.repo, context.install);
    await writeAtomic(context.config, rewriteManagedBlock(config.content, context.start, context.end, context.source));
  } catch {
    return failed(verb === "tune" ? `could not update ${context.config}` : `could not update ${context.config}`);
  }
  if (verb === "tune") {
    const server = await serverState(processAdapter);
    if (server.running) {
      const sourceResult = await getTmux().sourceFile(context.install, processAdapter);
      if (sourceResult.kind !== "ok") return failed("could not apply tmux tuning to the running server");
      return ok({ backup, serverApplied: true });
    }
  }
  return ok({ backup, serverApplied: false });
}

async function revert(context: TmuxContext, config: FileReading, verb: TmuxVerb): Promise<Result<boolean>> {
  if (!config.exists) return ok(false);
  if (!config.regular) return failed(verb === "tune" ? `tmux config exists but is not a regular file: ${context.config}` : `zsh config exists but is not a regular file: ${context.config}`);
  if (!validateManagedConfig(config.content, context.start, context.end)) return failed(verb === "tune" ? `tmux config has an incomplete legacy tuning block: ${context.config}` : `zsh config has an incomplete megabrain tmux wrapper block: ${context.config}`);
  if (!blockPresent(config.content, context.start, context.end, context.source)) return ok(false);
  try {
    await writeAtomic(context.config, removeManagedBlock(config.content, context.start, context.end));
  } catch {
    return failed(verb === "tune" ? `could not remove the legacy tuning block from ${context.config}` : `could not remove the megabrain tmux wrapper block from ${context.config}`);
  }
  return ok(true);
}

async function executeVerb(verb: TmuxVerb, options: TmuxOptions, environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const context = configContext(environment, verb);
  const config = await readPath(context.config);
  const installed = await readPath(context.install);
  const installedCurrent = installed.regular && (await readPath(context.repo)).regular && installed.content === (await readFile(context.repo, "utf8").catch(() => ""));
  if (options.dryRun) {
    const state = verb === "tune" ? await serverState(processAdapter) : { running: false, rgb: false };
    const next = await backupPath(context, config, processAdapter);
    if (options.json) {
      return ok(json(verb === "tune" ? {
        ok: true, action: "dry-run", changed: false, wouldChange: !blockPresent(config.content, context.start, context.end, context.source) || !installedCurrent,
        configPath: context.config, installedPath: context.install, blockPresent: blockPresent(config.content, context.start, context.end, context.source), installedCurrent, serverRunning: state.running, serverRgb: state.rgb,
      } : {
        ok: true, action: "dry-run", changed: false, wouldChange: !blockPresent(config.content, context.start, context.end, context.source) || !installedCurrent,
        configPath: context.config, installedPath: context.install, blockPresent: blockPresent(config.content, context.start, context.end, context.source), installedCurrent,
      }));
    }
    return ok(`${verb === "tune" ? tunePlan(context.config, context.install, next) : wrapperPlan(context.config, context.install, next)}  - dry-run: no files${verb === "tune" ? " or tmux server options" : ""} will change\n`);
  }
  if (options.revert) {
    const result = await revert(context, config, verb);
    if (result.kind !== "ok") return errorResult(result.error, options.json, verb, "revert");
    const backupPrefix = verb === "tune" ? ".tmux.conf.megabrain-backup-" : ".zshrc.megabrain-backup-";
    const backups = await backupPaths(wrapperBackupDirectory(environment), backupPrefix);
    if (options.json) return ok(json({ ok: true, action: "revert", changed: result.value, configPath: context.config, backupPaths: backups }));
    return ok(`${verb === "tune" ? "tmux tuning" : "tmux agent wrapper"} reverted from ${context.config}\nbackups remain available:\n${backups.map((path) => `  ${path}\n`).join("")}`);
  }
  if (!options.yes) {
    await backupPath(context, config, processAdapter);
    if (options.json) return ok(json(verb === "tune" ? { ok: true, action: "apply", status: "confirmation-required", changed: false } : { ok: true, action: "apply", status: "confirmation-required", changed: false, configPath: context.config, installedPath: context.install }));
    return ok(`tmux ${verb === "tune" ? "tuning" : "agent wrapper"} skipped (non-interactive); run: megabrain tmux ${verb} --yes\n`);
  }
  const result = await apply(context, config, processAdapter, verb);
  if (result.kind !== "ok") return errorResult(result.error, options.json, verb, "apply");
  if (options.json) {
    return ok(json(verb === "tune" ? { ok: true, action: "apply", changed: true, configPath: context.config, installedPath: context.install, backupPath: result.value.backup ?? null, serverApplied: result.value.serverApplied } : { ok: true, action: "apply", changed: true, configPath: context.config, installedPath: context.install, backupPath: result.value.backup ?? null }));
  }
  const backupText = result.value.backup === undefined ? `backup: none (${context.config} did not exist)\n` : `backup: ${result.value.backup}\n`;
  return ok(`${verb === "tune" ? "tmux tuning applied\n" : "tmux agent wrapper applied\n"}${backupText}${verb === "tune" ? `running tmux server: ${result.value.serverApplied ? "updated" : "none"}\n` : ""}`);
}

export async function executeTmux(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const verb = args[0];
  if (verb === "-h" || verb === "--help" || verb === undefined || verb === "") return ok(tmuxUsage());
  if (verb !== "tune" && verb !== "wrapper") return failed(`unknown tmux command: ${verb}`, 2);
  const commandArgs = args.slice(1);
  if (commandArgs.includes("-h") || commandArgs.includes("--help")) return ok(tmuxUsage(verb));
  const parsed = parseTmuxOptions(verb, commandArgs);
  if (parsed.kind !== "ok") return parsed;
  if (verb === "wrapper" && !parsed.value.revert && !parsed.value.dryRun) {
    const shell = shellFor(environment);
    if (shell !== "zsh" && shell !== "bash") return failed(`the agent wrapper ships for zsh and bash and your login shell is ${environment.SHELL ?? "unknown"}; nothing was written`);
  }
  return executeVerb(verb, parsed.value, environment, processAdapter);
}
