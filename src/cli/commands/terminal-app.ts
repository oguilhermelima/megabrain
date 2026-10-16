import type { ProcessAdapter } from "../../adapters/proc.js";
import {
  APP_SESSION_PREFIX,
  forgetAppTerminal,
  readAppTerminals,
} from "../../core/app-terminals.js";
import { readConversations, updateConversations, type ConversationRegistry } from "../../core/conversations.js";
import type { MigrationOptions } from "../../core/conversations-migrate.js";
import { failed, ok, type Result } from "../../core/result.js";
import { OWNED_TMUX_SERVER } from "../../core/session-ownership.js";
import {
  resolveStateDirectory,
  type StateEnvironment,
} from "../../core/state.js";

// Terminals the desktop app opened on its own tmux server, so the app can bring them back after a
// restart and kill them when the person closes them. A chat's terminal mode is the chat's, never a
// terminal of its own; a gone terminal stays listed only while it ran a conversation of ours.

export type AppTerminal = Readonly<{
  id: string;
  sessionName: string;
  cwd: string;
  title: string;
  command: string;
  alive: boolean;
  createdAt: string;
}>;

type Options = Readonly<{
  server: string;
  json: boolean;
  rest: readonly string[];
}>;

function parse(args: readonly string[]): Result<Options> {
  let server = OWNED_TMUX_SERVER;
  let json = false;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--json") json = true;
    else if (arg === "--server") {
      const value = args[++index];
      if (value === undefined || value === "")
        return failed("--server requires a value", 2);
      server = value;
    } else if (arg.startsWith("-")) return failed(`unknown option: ${arg}`, 2);
    else rest.push(arg);
  }
  return ok({ server, json, rest });
}

type Live = Readonly<{ sessionName: string; createdAt: string; cwd: string }>;

async function liveSessions(
  process: ProcessAdapter,
  server: string,
): Promise<readonly Live[]> {
  // A refused list means no server is running, which is no sessions, not a failure.
  const result = await process.run("tmux", [
    "-L",
    server,
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_created}\t#{session_path}",
  ]);
  if (result.kind !== "ok") return [];
  const sessions: Live[] = [];
  for (const line of result.value.stdout.split("\n")) {
    const [sessionName, created, cwd] = line.split("\t");
    if (
      sessionName === undefined ||
      !sessionName.startsWith(APP_SESSION_PREFIX)
    )
      continue;
    sessions.push({
      sessionName,
      createdAt: new Date(Number(created) * 1000).toISOString(),
      cwd: cwd ?? "",
    });
  }
  return sessions;
}

// The registry's migration asks whether an app session lives; the listing already knows.
function aliveOn(live: ReadonlyMap<string, unknown>): MigrationOptions {
  return { isTmuxAlive: (session) => live.has(session) };
}

function holdersOf(registry: ConversationRegistry, alias: string): (readonly [string, ConversationRegistry["conversations"][string]])[] {
  return Object.entries(registry.conversations).filter(([, entry]) => entry.aliases.tmux === alias);
}

export async function executeAppTerminalList(
  args: readonly string[],
  environment: StateEnvironment,
  process: ProcessAdapter,
): Promise<Result<string>> {
  const parsed = parse(args);
  if (parsed.kind !== "ok") return parsed;
  if (parsed.value.rest.length > 0)
    return failed(`unexpected argument: ${parsed.value.rest[0]}`, 2);
  const stateDir = resolveStateDirectory(environment);
  const records = readAppTerminals(stateDir);
  const live = new Map(
    (await liveSessions(process, parsed.value.server)).map((session) => [
      session.sessionName,
      session,
    ]),
  );
  const migration = aliveOn(live);
  const registry = readConversations(stateDir, migration);
  const names = new Set(
    [...live.keys(), ...Object.keys(records)].filter((name) =>
      name.startsWith(APP_SESSION_PREFIX),
    ),
  );
  const gone: string[] = [];
  const shown = [...names].filter((sessionName) => {
    const holders = holdersOf(registry, `${parsed.value.server}:${sessionName}`);
    if (holders.some(([, entry]) => entry.owner === "app-chat")) return false;
    if (live.has(sessionName)) return true;
    if (holders.some(([key]) => !key.startsWith("terminal:"))) return true;
    gone.push(sessionName);
    return false;
  });
  // A gone terminal that never held an agent session has nothing to resume: its record and entry go.
  if (gone.length > 0) {
    for (const sessionName of gone) forgetAppTerminal(stateDir, sessionName);
    const aliases = new Set(gone.map((sessionName) => `${parsed.value.server}:${sessionName}`));
    updateConversations(stateDir, (current) => ({
      ...current,
      conversations: Object.fromEntries(Object.entries(current.conversations).filter(([key, entry]) => !(key.startsWith("terminal:") && entry.aliases.tmux !== null && aliases.has(entry.aliases.tmux)))),
    }), migration);
  }
  const terminals: AppTerminal[] = shown
    .map((sessionName) => {
      const session = live.get(sessionName);
      const record = records[sessionName];
      return {
        id: sessionName.slice(APP_SESSION_PREFIX.length),
        sessionName,
        cwd: record?.cwd ?? session?.cwd ?? "",
        title: record?.title ?? "tmux",
        command: record?.command ?? "",
        alive: session !== undefined,
        createdAt: record?.createdAt ?? session?.createdAt ?? "",
      };
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (parsed.value.json) return ok(`${JSON.stringify(terminals, null, 2)}\n`);
  return ok(
    terminals
      .map((terminal) =>
        [
          terminal.id,
          terminal.alive ? "alive" : "gone",
          terminal.cwd,
          terminal.title,
          terminal.command,
          terminal.createdAt,
        ].join("\t"),
      )
      .map((line) => `${line}\n`)
      .join(""),
  );
}

export async function executeAppTerminalClose(
  args: readonly string[],
  environment: StateEnvironment,
  process: ProcessAdapter,
): Promise<Result<string>> {
  const parsed = parse(args);
  if (parsed.kind !== "ok") return parsed;
  const [id, ...extra] = parsed.value.rest;
  if (id === undefined || extra.length > 0)
    return failed("terminal close --app requires exactly one terminal id", 2);
  if (!/^[A-Za-z0-9-]+$/.test(id))
    return failed(`not an app terminal id: ${id}`, 2);
  const sessionName = `${APP_SESSION_PREFIX}${id}`;
  const stateDir = resolveStateDirectory(environment);
  const live = new Map((await liveSessions(process, parsed.value.server)).map((session) => [session.sessionName, session]));
  const running = live.has(sessionName);
  const recorded = readAppTerminals(stateDir)[sessionName] !== undefined;
  if (!running && !recorded) return failed(`no app terminal ${id}`);
  if (running) {
    // "=" makes tmux match the name exactly instead of by prefix.
    const killed = await process.run("tmux", [
      "-L",
      parsed.value.server,
      "kill-session",
      "-t",
      `=${sessionName}`,
    ]);
    if (killed.kind !== "ok")
      return failed(
        `could not close app terminal ${id}: ${killed.error}`,
        killed.exitCode,
      );
  }
  forgetAppTerminal(stateDir, sessionName);
  // Its own conversation goes with it; a chat whose terminal mode it was keeps the chat and loses the alias.
  const alias = `${parsed.value.server}:${sessionName}`;
  updateConversations(stateDir, (current) => ({
    ...current,
    conversations: Object.fromEntries(Object.entries(current.conversations)
      .filter(([, entry]) => !(entry.owner === "app-terminal" && entry.aliases.tmux === alias))
      .map(([key, entry]) => [key, entry.aliases.tmux === alias ? { ...entry, aliases: { ...entry.aliases, tmux: null } } : entry])),
  }), aliveOn(live));
  return ok(
    parsed.value.json
      ? `${JSON.stringify({ id, closed: true })}\n`
      : `closed ${id}\n`,
  );
}
