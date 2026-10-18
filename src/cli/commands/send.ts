import { resolveClaudePeer, sendClaudePeer } from "../../agents/claude-peer.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { listDispatches, stateDatabase } from "../../adapters/state-db.js";
import { deliverCodexQueue, findCodexProcess, findCodexProcessByThread } from "../../core/codex-delivery.js";
import { failed, ok, type Result } from "../../core/result.js";
import { deliverThroughGrokLeader } from "../../core/grok-leader-delivery.js";
import { selectSessionSendChannel, type SessionSendAgent } from "../../core/session-send.js";
import { deliverOperatorText, matchOrcaTerminal, selectOperatorSendChannel } from "../../core/session-send.js";
import { getHost, runHostSend } from "../../hosts/index.js";
import { usageText } from "../../core/usage.js";
import { ownedTmuxProcess, readOwnedSessions } from "../../core/session-ownership.js";
import { stateDirectory } from "./session.js";
import { getTmux } from "../../hosts/tmux.js";

type Environment = Readonly<Record<string, string | undefined>>;
type SessionTarget = Readonly<{ agent: SessionSendAgent; id: string }>;
type SendResult = Readonly<{ delivered: boolean; channel: string; detail?: string }>;
type DispatchMeta = Readonly<Record<string, unknown> & { dispatchId: string }>;
type SessionContext = Readonly<{ meta: DispatchMeta; side: "child" | "parent" }>;

function parseTarget(value: string): Result<SessionTarget> {
  const separator = value.indexOf(":");
  const agent = separator < 0 ? "" : value.slice(0, separator);
  const id = separator < 0 ? "" : value.slice(separator + 1);
  if (!["claude", "codex", "grok", "agy"].includes(agent)) return failed(`unknown agent in session id: ${agent || value}`, 2);
  if (id === "" || id.includes("/") || id.includes("\\")) return failed("--session must use <agent>:<session-id>", 2);
  return ok({ agent: agent as SessionSendAgent, id });
}

function parseArgs(args: readonly string[]): Result<Readonly<{ session: string; text: string; json: boolean }>> {
  let session: string | undefined;
  let text: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--session") {
      if (session !== undefined) return failed("--session may only be supplied once", 2);
      session = args[index + 1];
      if (session === undefined || session.startsWith("--")) return failed("--session requires <agent>:<session-id>", 2);
      index += 1;
    } else if (argument === "--text") {
      if (text !== undefined) return failed("--text may only be supplied once", 2);
      text = args[index + 1];
      if (text === undefined || text.startsWith("--")) return failed("--text requires a message", 2);
      index += 1;
    } else if (argument === "--json") json = true;
    else if (argument.startsWith("-")) return failed(`unknown send option: ${argument}`, 2);
    else return failed(`unexpected send argument: ${argument}`, 2);
  }
  if (session === undefined) return failed(usageText("send"), 2);
  if (text === undefined || text.trim() === "") return failed("--text requires a non-empty message", 2);
  return ok({ session, text, json });
}

function sessionContexts(records: readonly DispatchMeta[], target: SessionTarget): SessionContext[] {
  const childKeys = target.agent === "codex" ? ["agentThreadId"]
    : target.agent === "grok" ? ["grokSessionId", "agentSessionId"]
      : ["agentSessionId"];
  const parentKeys = target.agent === "codex" ? ["parentAgentThreadId"]
    : target.agent === "grok" ? ["parentGrokSessionId", "parentAgentSessionId"]
      : ["parentAgentSessionId"];
  const matches: SessionContext[] = [];
  for (const meta of records) {
    if (meta.agent === target.agent && childKeys.some((key) => meta[key] === target.id)) matches.push({ meta, side: "child" });
    else if (meta.parentAgent === target.agent && parentKeys.some((key) => meta[key] === target.id)) matches.push({ meta, side: "parent" });
  }
  return matches.sort((left, right) => String(right.meta.updatedAt ?? "").localeCompare(String(left.meta.updatedAt ?? "")));
}

function targetValue(context: SessionContext | undefined, childKey: string, parentKey: string): string | undefined {
  const value = context === undefined ? undefined : context.side === "child" ? context.meta[childKey] : context.meta[parentKey];
  return typeof value === "string" && value !== "" ? value : undefined;
}

async function sendTmux(context: SessionContext, text: string, process: ProcessAdapter): Promise<Result<void>> {
  const pane = targetValue(context, "tmuxPane", "parentTmuxPane");
  if (pane === undefined) return failed("no tmux pane is associated with this session");
  const stableSession = targetValue(context, "tmuxSessionId", "parentTmuxSessionId");
  const pasted = await getTmux().pasteText(pane, text, process, stableSession);
  if (pasted.kind !== "ok") return pasted;
  return getTmux().sendKey(pane, "Enter", process, stableSession);
}

function output(result: SendResult, json: boolean): string {
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  return `delivered: ${result.delivered}\nchannel: ${result.channel}${result.detail === undefined ? "" : `\ndetail: ${result.detail}`}\n`;
}

// A session megabrain resumed itself: its terminal is a tmux session on megabrain's own server, so the
// same verified paste applies and no Orca terminal is looked up.
async function sendOwned(tmuxSession: string, agent: SessionSendAgent, request: Readonly<{ text: string; json: boolean }>, process: ProcessAdapter): Promise<Result<string>> {
  const tmuxProcess = ownedTmuxProcess(process);
  const panes = await getTmux().panesForSession(tmuxSession, tmuxProcess);
  const pane = panes.kind === "ok" ? panes.value[0] : undefined;
  if (pane === undefined) return ok(output({ delivered: false, channel: "tmux", detail: "The session megabrain owns is not running; run megabrain session own again." }, request.json), 1);
  const result = await deliverOperatorText({
    agent, text: request.text, readyTimeoutMs: 10_000,
    read: async () => {
      const captured = await getTmux().capturePane(pane, 200, tmuxProcess, true);
      return captured.kind === "ok" ? captured.value : undefined;
    },
    send: async (text, enter) => {
      const sent = text === "" && enter ? await getTmux().sendKey(pane, "Enter", tmuxProcess) : await getTmux().pasteText(pane, text, tmuxProcess);
      return sent.kind === "ok" ? "ok" : sent.error;
    },
  });
  return ok(output({ delivered: result.delivered, channel: "tmux", ...(result.detail === undefined ? {} : { detail: result.detail }) }, request.json), result.delivered ? undefined : 1);
}

export async function executeSend(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("send"));
  if (environment.MEGABRAIN_OPERATOR !== "1") return failed("megabrain send is for the operator; pass --operator");
  const parsed = parseArgs(args);
  if (parsed.kind !== "ok") return parsed;
  const target = parseTarget(parsed.value.session);
  if (target.kind !== "ok") return target;
  const owned = readOwnedSessions(stateDirectory(environment))[parsed.value.session];
  if (owned !== undefined) return sendOwned(owned.tmuxSession, target.value.agent, parsed.value, process);
  const database = stateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const records = listDispatches(database.value);
  if (records.kind !== "ok") return records;
  const contexts = sessionContexts(records.value as DispatchMeta[], target.value);
  const context = contexts[0];
  const meta = context?.meta;
  const pane = targetValue(context, "tmuxPane", "parentTmuxPane");
  const socketPath = targetValue(context, "grokLeaderSocket", "parentGrokLeaderSocket");
  const grokSessionId = targetValue(context, "grokSessionId", "parentGrokSessionId")
    ?? targetValue(context, "agentSessionId", "parentAgentSessionId") ?? target.value.id;
  const peer = target.value.agent === "claude" && environment.HOME !== undefined
    ? await resolveClaudePeer(environment.HOME, 0, target.value.id)
    : undefined;
  const terminalCwd = (typeof meta?.cwd === "string" ? meta.cwd : typeof meta?.worktreePath === "string" ? meta.worktreePath : undefined)
    ?? (target.value.agent === "claude" ? peer?.kind === "ok" ? peer.value.cwd : undefined : undefined);
  const terminalTitle = (typeof meta?.label === "string" ? meta.label : typeof meta?.chatName === "string" ? meta.chatName : undefined)
    ?? (target.value.agent === "claude" ? peer?.kind === "ok" ? peer.value.title : undefined : undefined);
  let orcaTerminal: string | undefined;
  if (terminalCwd !== undefined) {
    const listed = await process.run("orca", ["terminal", "list", "--json"]);
    if (listed.kind === "ok") {
      try {
        const root = JSON.parse(listed.value.stdout) as { result?: { terminals?: unknown } };
        orcaTerminal = matchOrcaTerminal(root.result?.terminals, { agent: target.value.agent, worktreePath: terminalCwd, ...(terminalTitle === undefined ? {} : { title: terminalTitle }) })?.handle;
      } catch { /* An unreadable inventory cannot safely identify a terminal. */ }
    }
  }
  const host = context === undefined ? undefined : String(context.side === "child" ? meta?.childHost ?? "" : meta?.parentHost ?? "");
  const recordedTerminal = context === undefined ? undefined : targetValue(context, "terminalId", "parentTerminalId");
  if (orcaTerminal === undefined && host === "orca") orcaTerminal = recordedTerminal;
  const noTerminalMatch = target.value.agent === "claude" && orcaTerminal === undefined
    ? "no open Orca terminal matched this Claude session; the peer message may be held for approval"
    : undefined;
  const operator = environment.MEGABRAIN_OPERATOR === "1";
  const channel = operator ? selectOperatorSendChannel(target.value.agent, {
    peerSocket: peer?.kind === "ok",
    leaderSocket: target.value.agent === "grok" && socketPath !== undefined,
    codexQueue: target.value.agent === "codex",
    tmux: pane !== undefined,
    orca: orcaTerminal !== undefined,
  }) : selectSessionSendChannel(target.value.agent, {
    peerSocket: peer?.kind === "ok",
    leaderSocket: target.value.agent === "grok" && socketPath !== undefined,
    codexQueue: target.value.agent === "codex",
    tmux: pane !== undefined,
  });
  if (channel === undefined) {
    const result: SendResult = { delivered: false, channel: "none", detail: "no delivery channel is available for this session" };
    return ok(output(result, parsed.value.json), 1);
  }

  let failure = "delivery channel did not accept the message";
  const tryTmux = async (): Promise<SendResult | undefined> => {
    if (meta === undefined || pane === undefined) return undefined;
    const sent = await sendTmux(context, parsed.value.text, process);
    return sent.kind === "ok" ? { delivered: true, channel: "tmux" } : { delivered: false, channel: "tmux", detail: sent.error };
  };
  if (operator && (channel === "tmux" || channel === "orca")) {
    const agent = target.value.agent;
    const read = async (): Promise<string | undefined> => {
      if (channel === "tmux") {
        if (pane === undefined) return undefined;
        const captured = await getTmux().capturePane(pane, 200, process, true, targetValue(context, "tmuxSessionId", "parentTmuxSessionId"));
        return captured.kind === "ok" ? captured.value : undefined;
      }
      if (orcaTerminal === undefined) return undefined;
      const captured = await process.run("orca", ["terminal", "read", "--terminal", orcaTerminal, "--json", "--screen"]);
      if (captured.kind !== "ok") return undefined;
      try {
        const root = JSON.parse(captured.value.stdout) as { result?: { terminal?: { tail?: unknown; draft?: unknown } } };
        const terminal = root.result?.terminal;
        const tail = typeof terminal?.tail === "string" ? terminal.tail : Array.isArray(terminal?.tail) && terminal.tail.every((line): line is string => typeof line === "string") ? terminal.tail.join("\n") : undefined;
        return tail === undefined ? undefined : typeof terminal?.draft === "string" && terminal.draft !== "" ? `${tail}\nMEGABRAIN_COMPOSER_DRAFT:${terminal.draft}` : tail;
      } catch { return undefined; }
    };
    const send = async (text: string, enter: boolean): Promise<"ok" | string> => {
      if (channel === "tmux") {
        if (pane === undefined) return "no tmux pane is associated with this session";
        const sent = text === "" && enter
          ? await getTmux().sendKey(pane, "Enter", process, targetValue(context, "tmuxSessionId", "parentTmuxSessionId"))
          : await getTmux().pasteText(pane, text, process, targetValue(context, "tmuxSessionId", "parentTmuxSessionId"));
        return sent.kind === "ok" ? "ok" : sent.error;
      }
      if (orcaTerminal === undefined) return "no matching Orca terminal is available";
      const host = getHost("orca");
      const call = host?.send({ workspaceId: null, terminalId: orcaTerminal, ...(text === "" && enter ? {} : { text }), enter });
      if (call?.kind !== "ok") return "could not build Orca terminal send";
      const sent = await runHostSend("orca", process, call.value);
      return sent.kind === "ok" ? "ok" : sent.error;
    };
    // C-u clears a line per press in some agents, so a few presses empty a multi-line paste.
    const clear = channel === "tmux" && pane !== undefined ? async (): Promise<"ok" | string> => {
      for (let press = 0; press < 3; press += 1) {
        const cleared = await getTmux().sendKey(pane, "C-u", process, targetValue(context, "tmuxSessionId", "parentTmuxSessionId"));
        if (cleared.kind !== "ok") return cleared.error;
      }
      return "ok";
    } : undefined;
    const result = await deliverOperatorText({ agent, text: parsed.value.text, read, send, ...(clear === undefined ? {} : { clear }) });
    return ok(output({ delivered: result.delivered, channel, ...(result.detail === undefined ? {} : { detail: result.detail }) }, parsed.value.json), result.delivered ? undefined : 1);
  }
  if (channel === "peer-socket" && peer?.kind === "ok") {
    // An operator has no honest permission-mode attestation, so the envelope deliberately omits it.
    const sent = await sendClaudePeer(peer.value, parsed.value.text);
    if (sent.kind === "ok") return ok(output({ delivered: false, channel: "peer-socket-held", detail: noTerminalMatch ?? "the session may hold this message for operator approval because it has no permission-mode attestation" }, parsed.value.json), 1);
    failure = sent.error;
  } else if (channel === "leader-socket" && socketPath !== undefined) {
    const sent = await deliverThroughGrokLeader({ database: database.value, socketPath, sessionId: grokSessionId, text: parsed.value.text });
    if (sent.kind === "delivered") return ok(output({ delivered: true, channel }, parsed.value.json));
    failure = sent.kind === "fallback" ? sent.reason : "Grok leader did not confirm prompt queueing";
  } else if (channel === "codex-queue") {
    const thread = target.value.id;
    const scope = meta === undefined ? undefined : {
      runtime: context.side === "child" ? meta.runtime : "tmux",
      host: context.side === "child" ? meta.childHost : meta.parentHost,
      childHost: context.side === "child" ? meta.childHost : meta.parentHost,
      terminalId: context.side === "child" ? meta.terminalId : meta.parentTerminalId,
      workspaceId: context.side === "child" ? meta.workspaceId : meta.parentWorkspaceId,
      tmuxPane: context.side === "child" ? meta.tmuxPane : meta.parentTmuxPane,
      tmuxSessionId: context.side === "child" ? meta.tmuxSessionId : meta.parentTmuxSessionId,
    };
    const found = scope === undefined ? await findCodexProcessByThread(thread, process) : await findCodexProcess(thread, scope, process);
    if ("pid" in found) {
      const sent = await deliverCodexQueue(thread, found.pid, parsed.value.text, process);
      if (sent.kind === "queued") return ok(output({ delivered: true, channel }, parsed.value.json));
      failure = sent.reason;
    } else failure = found.reason;
  }
  const fallback = await tryTmux();
  if (fallback !== undefined) return ok(output(fallback, parsed.value.json), fallback.delivered ? undefined : 1);
  return ok(output({ delivered: false, channel, detail: failure }, parsed.value.json), 1);
}
