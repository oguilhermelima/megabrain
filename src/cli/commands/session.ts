import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { composerReadback } from "../../core/composer-proof.js";
import { failed, ok, type Result } from "../../core/result.js";
import {
  OWNED_TMUX_SERVER, ownedSessionName, ownedTmuxProcess, readOwnedSessions, resumeCommand, writeOwnedSessions, type OwnableAgent,
} from "../../core/session-ownership.js";
import { usageText } from "../../core/usage.js";
import { createTmuxSession, getTmux } from "../../hosts/tmux.js";
import { appHost, appTarget, readAppPanes, readProcessTable } from "../../core/session-origin.js";
import { findMachineSession } from "./projects.js";
import { readConversations, removeConversation, setConversationAlias, upsertConversation } from "../../core/conversations.js";
import { APP_SESSION_PREFIX, forgetAppTerminal } from "../../core/app-terminals.js";
import { join } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;
export type SessionOptions = Readonly<{ readyTimeoutMs?: number; pollMs?: number }>;

const READY_TIMEOUT_MS = 45_000;
const POLL_MS = 500;

export function stateDirectory(environment: Environment): string {
  return environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? ".", ".megabrain");
}

function parseKey(args: readonly string[]): Result<Readonly<{ agent: string; id: string; key: string; json: boolean }>> {
  const json = args.includes("--json");
  const rest = args.filter((argument) => argument !== "--json");
  const key = rest[0];
  if (key === undefined || rest.length !== 1 || key.startsWith("-")) return failed("Usage: megabrain session own|release <agent:id> [--json]", 2);
  const separator = key.indexOf(":");
  const agent = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (separator < 1 || id === "" || /[\\/\s]/.test(id)) return failed("session must be <agent>:<session-id>", 2);
  return ok({ agent, id, key, json });
}

async function waitForComposer(agent: string, pane: string, process: ProcessAdapter, options: SessionOptions): Promise<boolean> {
  const deadline = Date.now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);
  for (;;) {
    const screen = await getTmux().capturePane(pane, 200, process, true);
    if (screen.kind === "ok" && composerReadback(agent, screen.value).region !== undefined) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? POLL_MS));
  }
}

// The registry is what the app lists: an owned session is its own entry unless a chat already owns it.
function recordOwnedConversation(stateDir: string, key: string, cwd: string, tmux: string): void {
  if (readConversations(stateDir).conversations[key] !== undefined) { setConversationAlias(stateDir, key, { tmux }); return; }
  upsertConversation(stateDir, key, { owner: "app-terminal", cwd, aliases: { chatId: null, tmux, pid: null, dispatchId: null }, createdAt: new Date().toISOString(), hidden: false });
}

function releaseOwnedConversation(stateDir: string, key: string): void {
  const entry = readConversations(stateDir).conversations[key];
  if (entry === undefined) return;
  if (entry.owner === "app-terminal") removeConversation(stateDir, key);
  else setConversationAlias(stateDir, key, { tmux: null });
}

async function own(target: Readonly<{ agent: string; id: string; key: string; json: boolean }>, environment: Environment, process: ProcessAdapter, options: SessionOptions): Promise<Result<string>> {
  if (target.agent !== "claude" && target.agent !== "codex") return failed(`megabrain cannot take ownership of a ${target.agent} session`, 2);
  const agent: OwnableAgent = target.agent;
  const found = await findMachineSession(environment.HOME ?? "", process, target.agent, target.id);
  if (found === undefined) return failed(`no ${agent} session ${target.id} was found on this machine`);
  const tmuxProcess = ownedTmuxProcess(process);
  const name = ownedSessionName(agent, target.id);
  const command = resumeCommand(agent, target.id, found.model ?? undefined);
  const alive = await getTmux().sessionExists(name, tmuxProcess);
  if (alive.kind !== "ok") return failed(alive.error);
  if (!alive.value) {
    const created = await createTmuxSession(name, found.cwd, command, tmuxProcess, false);
    if (created.kind !== "ok") return failed(created.error);
  }
  const panes = await getTmux().panesForSession(name, tmuxProcess);
  const pane = panes.kind === "ok" ? panes.value[0] : undefined;
  if (pane === undefined || !(await waitForComposer(agent, pane, tmuxProcess, options))) {
    if (!alive.value) await getTmux().killSession(name, tmuxProcess);
    return failed(`the ${agent} composer did not appear in tmux session ${name}; ownership was not taken`);
  }
  const stateDir = stateDirectory(environment);
  writeOwnedSessions(stateDir, { ...readOwnedSessions(stateDir), [target.key]: { tmuxServer: OWNED_TMUX_SERVER, tmuxSession: name, command, cwd: found.cwd, ownedAt: new Date().toISOString() } });
  recordOwnedConversation(stateDir, target.key, found.cwd, `${OWNED_TMUX_SERVER}:${name}`);
  const report = { session: target.key, owner: "megabrain", tmuxServer: OWNED_TMUX_SERVER, tmuxSession: name, command };
  return ok(target.json ? `${JSON.stringify(report, null, 2)}\n` : `owned: ${target.key}\ntmux: -L ${OWNED_TMUX_SERVER} ${name}\n`);
}

async function release(target: Readonly<{ key: string; json: boolean }>, environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const stateDir = stateDirectory(environment);
  const owned = readOwnedSessions(stateDir);
  const entry = owned[target.key];
  if (entry === undefined) return releaseAppSession(target, environment, process);
  const { [target.key]: _released, ...remaining } = owned;
  writeOwnedSessions(stateDir, remaining);
  releaseOwnedConversation(stateDir, target.key);
  await getTmux().killSession(entry.tmuxSession, ownedTmuxProcess(process));
  return ok(target.json ? `${JSON.stringify({ session: target.key, owner: "external" }, null, 2)}\n` : `released: ${target.key}\n`);
}

// A terminal conversation of the app closes for good: its tmux session (either naming scheme) ends if it
// still runs, its record goes, and so does its entry. One that already ended has only its entry to drop.
async function closeTerminalConversation(target: Readonly<{ key: string; json: boolean }>, stateDir: string, tmux: string | null, process: ProcessAdapter): Promise<Result<string>> {
  const [server, session] = (tmux ?? "").split(":");
  if (server === OWNED_TMUX_SERVER && session !== undefined && session !== "") {
    await getTmux().killSession(session, ownedTmuxProcess(process));
    if (session.startsWith(APP_SESSION_PREFIX)) forgetAppTerminal(stateDir, session);
  }
  removeConversation(stateDir, target.key);
  return ok(target.json ? `${JSON.stringify({ session: target.key, owner: "external" }, null, 2)}\n` : `released: ${target.key}\n`);
}

// A session the desktop app launched in a terminal it no longer shows: end its tmux session or its process.
async function releaseAppSession(target: Readonly<{ key: string; json: boolean }>, environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const stateDir = stateDirectory(environment);
  const registered = readConversations(stateDir).conversations[target.key];
  if (registered?.owner === "app-terminal" && registered.aliases.tmux !== null) return closeTerminalConversation(target, stateDir, registered.aliases.tmux, process);
  const separator = target.key.indexOf(":");
  const found = await findMachineSession(environment.HOME ?? "", process, target.key.slice(0, separator), target.key.slice(separator + 1));
  const host = found?.status === "ended" ? undefined : appHost(await readProcessTable(process), found?.processId);
  const app = appTarget(host, host?.kind === "tmux" ? await readAppPanes(process) : new Map<number, string>());
  if (app === undefined) return registered?.owner === "app-terminal" ? closeTerminalConversation(target, stateDir, null, process) : failed(`${target.key} is not owned by megabrain`);
  if ("tmuxSession" in app) {
    const killed = await getTmux().killSession(app.tmuxSession, ownedTmuxProcess(process));
    if (killed.kind !== "ok") return failed(killed.error);
  } else {
    const killed = await process.run("kill", ["-TERM", String(app.terminalPid)]);
    if (killed.kind !== "ok") return failed(killed.error);
  }
  if (registered?.owner === "app-terminal") removeConversation(stateDir, target.key);
  return ok(target.json ? `${JSON.stringify({ session: target.key, owner: "external" }, null, 2)}\n` : `released: ${target.key}\n`);
}

export async function executeSession(args: readonly string[], environment: Environment, process: ProcessAdapter = createProcessAdapter(), options: SessionOptions = {}): Promise<Result<string>> {
  const [verb, ...rest] = args;
  if (verb === undefined || verb === "-h" || verb === "--help") return ok(`Usage: megabrain ${usageText("session-own")}\nUsage: megabrain ${usageText("session-release")}\n`);
  if (verb !== "own" && verb !== "release") return failed(`unknown session command: ${verb}`, 2);
  if (rest.includes("-h") || rest.includes("--help")) return ok(`Usage: megabrain ${usageText(verb === "own" ? "session-own" : "session-release")}\n`);
  const target = parseKey(rest);
  if (target.kind !== "ok") return target;
  return verb === "own" ? own(target.value, environment, process, options) : release(target.value, environment, process);
}
