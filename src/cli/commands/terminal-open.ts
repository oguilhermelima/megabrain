import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import {
  attachArgv, detectTerminal, isOpenerName, openerInvocation, OPENER_NAMES, selectTerminal,
  type Environment, type OpenerName, type Platform,
} from "../../core/terminal-openers.js";
import { usageText } from "../../core/usage.js";

function currentPlatform(): Platform {
  return process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
}

function defaultFile(environment: Environment): string {
  return join(environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain"), "terminal-default");
}

export async function storedDefault(environment: Environment): Promise<string | undefined> {
  try { return (await readFile(defaultFile(environment), "utf8")).trim() || undefined; } catch { return undefined; }
}

// Quote a word only when a shell would split or expand it, so the printed attach command is
// readable and still safe to paste.
export function printable(argv: readonly string[]): string {
  return argv.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)).join(" ");
}

type OpenArguments = { session?: string; server?: string; terminal?: string; json: boolean };

function parseOpen(args: readonly string[]): Result<OpenArguments> {
  const parsed: OpenArguments = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const value = (): string | undefined => { index += 1; return args[index]; };
    if (argument === "--json") parsed.json = true;
    else if (argument === "--session" || argument === "--server" || argument === "--terminal") {
      const next = value();
      if (next === undefined || next === "" || next.startsWith("--")) return failed(`${argument} requires a value`, 2);
      if (argument === "--session") parsed.session = next;
      else if (argument === "--server") parsed.server = next;
      else parsed.terminal = next;
    } else return failed(`unknown terminal open argument: ${argument}`, 2);
  }
  if (parsed.session === undefined) return failed("terminal open requires --session <tmux session>", 2);
  return ok(parsed);
}

export async function launchOpener(
  name: OpenerName,
  argv: readonly string[],
  environment: Environment,
  process: ProcessAdapter,
  platform: Platform = currentPlatform(),
): Promise<Result<unknown>> {
  const invocation = openerInvocation(name, argv, { env: environment, platform });
  return invocation.detached
    ? process.startDetached(invocation.command, invocation.args)
    : process.run(invocation.command, invocation.args);
}

export type Viewer = Readonly<{ terminal: string; opened: boolean; attachCommand: string; error: string | null }>;

// A viewer is a window in the operator's own terminal attached to a tmux session the child already
// runs in, so it never fails the command that asked for it: the child is up either way, and the
// error plus the attach command tell the operator how to look at it by hand. `automatic` is true
// for a caller with no host and no tmux, who has nowhere else to see the child; every other caller
// gets a viewer only when --terminal names a terminal (or none).
export async function openViewer(input: Readonly<{
  session: string;
  flag?: string;
  automatic: boolean;
  env: Environment;
  process: ProcessAdapter;
  platform?: Platform;
}>): Promise<Viewer | undefined> {
  const { session, flag, env, process } = input;
  if (!input.automatic && (flag === undefined || flag === "auto")) return undefined;
  const attachCommand = printable(attachArgv(session));
  const notOpened = (terminal: string, error: string | null): Viewer => ({ terminal, opened: false, attachCommand, error });
  const selection = selectTerminal({ flag, env, stored: await storedDefault(env) });
  if (selection.kind !== "ok") return notOpened("none", selection.error);
  if (selection.value.kind === "none") return notOpened("none", null);
  const name = selection.value.name;
  const started = await launchOpener(name, attachArgv(session), env, process, input.platform);
  return started.kind === "ok" ? { terminal: name, opened: true, attachCommand, error: null } : notOpened(name, started.error);
}

export function viewerLine(viewer: Viewer): string {
  const state = viewer.opened ? "opened" : viewer.error === null ? "not opened" : `not opened: ${viewer.error}`;
  return `viewer: ${viewer.terminal} (${state}); attach with: ${viewer.attachCommand}\n`;
}

// Rejects an unknown --terminal name at argument parsing, before anything is created.
export function checkTerminalFlag(flag: string): Result<void> {
  const selection = selectTerminal({ flag, env: {} });
  return selection.kind === "ok" ? ok(undefined) : selection;
}

export async function executeTerminalOpen(
  args: readonly string[],
  environment: Environment,
  process: ProcessAdapter,
  platform: Platform = currentPlatform(),
): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("terminal-open"));
  const parsed = parseOpen(args);
  if (parsed.kind !== "ok") return parsed;
  const { session, server, terminal, json } = parsed.value;
  const sessionName = session ?? "";
  const selection = selectTerminal({ flag: terminal, env: environment, stored: await storedDefault(environment) });
  if (selection.kind !== "ok") return selection;
  const tmuxServer = server === undefined ? [] : ["-L", server];
  const exists = await process.run("tmux", [...tmuxServer, "has-session", "-t", sessionName]);
  if (exists.kind !== "ok") return failed(`tmux session not found: ${sessionName}`);
  const attach = printable(attachArgv(sessionName, server));
  const report = (opened: string | null, source: string, detail: string): Result<string> => ok(json
    ? `${JSON.stringify({ terminal: opened ?? "none", source, session: sessionName, attach }, null, 2)}\n`
    : `${detail}\n`);
  if (selection.value.kind === "none") return report(null, selection.value.source, `no terminal opened (${selection.value.source}); attach with: ${attach}`);
  const name = selection.value.name;
  const started = await launchOpener(name, attachArgv(sessionName, server), environment, process, platform);
  if (started.kind !== "ok") return failed(`could not open ${name}: ${started.error}`);
  return report(name, selection.value.source, `opened ${name} (${selection.value.source}) attached to ${sessionName}; attach manually with: ${attach}`);
}

export async function executeTerminalDefault(args: readonly string[], environment: Environment): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("terminal-default"));
  const file = defaultFile(environment);
  if (args.length > 1) return failed("terminal default takes at most one argument", 2);
  const [argument] = args;
  if (argument === "--clear") {
    await rm(file, { force: true });
    return ok("terminal default: cleared\n");
  }
  if (argument !== undefined) {
    if (argument !== "none" && argument !== "auto" && !isOpenerName(argument)) {
      return failed(`unknown terminal '${argument}'; use one of: ${OPENER_NAMES.join(", ")}, auto, none`, 2);
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${argument}\n`);
    return ok(`terminal default: ${argument} (${file})\n`);
  }
  const fromEnvironment = environment.MEGABRAIN_TERMINAL?.trim();
  if (fromEnvironment) return ok(`terminal default: ${fromEnvironment} (source: MEGABRAIN_TERMINAL)\n`);
  const stored = await storedDefault(environment);
  if (stored !== undefined) return ok(`terminal default: ${stored} (source: ${file})\n`);
  return ok(`terminal default: unset (detection would pick ${detectTerminal(environment) ?? "none"})\n`);
}
