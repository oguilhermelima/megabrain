import { resolveClaudePeer, sendClaudePeer } from "../../agents/claude-peer.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { listDispatches, recordChannelResult, stateDatabase } from "../../adapters/state-db.js";
import { deliverCodexQueue, findCodexProcessByThread } from "../../core/codex-delivery.js";
import { failed, ok, type Result } from "../../core/result.js";
import { deliverThroughGrokLeader } from "../../core/grok-leader-delivery.js";
import { deliverOperatorText, matchOrcaTerminal, sendSessionMessage, type SessionSendAgent, type SessionSendChannel } from "../../core/session-send.js";
import { deliverThroughAgyLanguageServer } from "../../core/agy-ls-delivery.js";
import { agyParentKey } from "../../agents/agy-ls.js";
import { randomUUID } from "node:crypto";
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
async function sendOwned(tmuxSession: string, agent: SessionSendAgent, request: Readonly<{ text: string; json: boolean }>, process: ProcessAdapter, environment: Environment): Promise<Result<string>> {
  const tmuxProcess = ownedTmuxProcess(process);
  const panes = await getTmux().panesForSession(tmuxSession, tmuxProcess);
  const pane = panes.kind === "ok" ? panes.value[0] : undefined;
  if (pane === undefined) return ok(output({ delivered: false, channel: "tmux", detail: "The session megabrain owns is not running; run megabrain session own again." }, request.json), 1);
  const sent = await sendSessionMessage({ caller: "operator-send", messageId: randomUUID(), target: { agent, id: tmuxSession }, text: request.text, channels: {
    typed: async () => {
      const result = await deliverOperatorText({
        agent, text: request.text,
        read: async () => { const captured = await getTmux().capturePane(pane, 200, tmuxProcess, true); return captured.kind === "ok" ? captured.value : undefined; },
        send: async (text, enter) => {
          if (text !== "") { const pasted = await getTmux().pasteText(pane, text, tmuxProcess); if (pasted.kind !== "ok") return pasted.error; }
          if (enter) { const submitted = await getTmux().sendKey(pane, "Enter", tmuxProcess); if (submitted.kind !== "ok") return submitted.error; }
          return "ok";
        },
      });
      return result.delivered ? true : { delivered: false, detail: result.detail };
    },
  }, recordChannel: (channel) => { const database = stateDatabase(environment); if (database.kind === "ok") recordChannelResult(database.value, { agent, channel, agentVersion: "unknown", ok: true }); } });
  return ok(output({ delivered: sent.delivered, channel: sent.channel, ...(sent.detail === undefined ? {} : { detail: sent.detail }) }, request.json), sent.delivered ? undefined : 1);
}

export async function executeSend(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("send"));
  if (environment.MEGABRAIN_OPERATOR !== "1") return failed("megabrain send is for the operator; pass --operator");
  const parsed = parseArgs(args);
  if (parsed.kind !== "ok") return parsed;
  const target = parseTarget(parsed.value.session);
  if (target.kind !== "ok") return target;
  const owned = readOwnedSessions(stateDirectory(environment))[parsed.value.session];
  if (owned !== undefined) return sendOwned(owned.tmuxSession, target.value.agent, parsed.value, process, environment);
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
  const typedHost = pane !== undefined ? "tmux" : operator && orcaTerminal !== undefined ? "orca" : undefined;
  const sendTyped = async (text: string, enter: boolean): Promise<"ok" | string> => {
    if (typedHost === "tmux") {
      if (pane === undefined) return "no tmux pane is associated with this session";
      if (text !== "") {
        const pasted = await getTmux().pasteText(pane, text, process, targetValue(context, "tmuxSessionId", "parentTmuxSessionId"));
        if (pasted.kind !== "ok") return pasted.error;
      }
      if (enter) {
        const submitted = await getTmux().sendKey(pane, "Enter", process, targetValue(context, "tmuxSessionId", "parentTmuxSessionId"));
        if (submitted.kind !== "ok") return submitted.error;
      }
      return "ok";
    }
    if (typedHost === "orca" && orcaTerminal !== undefined) {
      const host = getHost("orca");
      const call = host?.send({ workspaceId: null, terminalId: orcaTerminal, ...(text === "" && enter ? {} : { text }), enter });
      if (call?.kind !== "ok") return "could not build Orca terminal send";
      const sent = await runHostSend("orca", process, call.value);
      return sent.kind === "ok" ? "ok" : sent.error;
    }
    return "no typed session channel is available";
  };
  const readTyped = async (): Promise<string | undefined> => {
    if (typedHost === "tmux" && pane !== undefined) {
      const captured = await getTmux().capturePane(pane, 200, process, true, targetValue(context, "tmuxSessionId", "parentTmuxSessionId"));
      return captured.kind === "ok" ? captured.value : undefined;
    }
    if (typedHost === "orca" && orcaTerminal !== undefined) {
      const captured = await process.run("orca", ["terminal", "read", "--terminal", orcaTerminal, "--json", "--screen"]);
      if (captured.kind !== "ok") return undefined;
      try {
        const root = JSON.parse(captured.value.stdout) as { result?: { terminal?: { tail?: unknown; draft?: unknown } } };
        const terminal = root.result?.terminal;
        const tail = typeof terminal?.tail === "string" ? terminal.tail : Array.isArray(terminal?.tail) && terminal.tail.every((line): line is string => typeof line === "string") ? terminal.tail.join("\n") : undefined;
        return tail === undefined ? undefined : typeof terminal?.draft === "string" && terminal.draft !== "" ? `${tail}\nMEGABRAIN_COMPOSER_DRAFT:${terminal.draft}` : tail;
      } catch { return undefined; }
    }
    return undefined;
  };
  const channels: Partial<Record<SessionSendChannel, () => Promise<boolean | Readonly<{ delivered: boolean; stop?: boolean; detail?: string }>>>> = {};
  if (target.value.agent === "claude" && peer?.kind === "ok") {
    channels["peer-socket"] = async () => {
      const sent = await sendClaudePeer(peer.value, parsed.value.text);
      return sent.kind === "ok"
        ? { delivered: false, stop: true, detail: noTerminalMatch ?? "the peer message may be held for operator approval because it has no permission-mode attestation" }
        : { delivered: false, detail: sent.error };
    };
  }
  if (target.value.agent === "grok" && socketPath !== undefined) {
    channels["leader-socket"] = async () => {
      const sent = await deliverThroughGrokLeader({ database: database.value, socketPath, sessionId: grokSessionId, text: parsed.value.text });
      return sent.kind === "delivered" ? true : { delivered: false, detail: sent.kind === "fallback" ? sent.reason : "Grok leader did not confirm prompt queueing" };
    };
  }
  if (target.value.agent === "agy" && context !== undefined && typeof meta?.dispatchId === "string") {
    channels["agy-language-server"] = async () => {
      const key = context.side === "parent" ? agyParentKey(String(meta.dispatchId)) : String(meta.dispatchId);
      const sent = await deliverThroughAgyLanguageServer({ database: database.value, stateRoot: stateDirectory(environment), endpointKey: key, text: parsed.value.text, isRead: async () => false });
      return sent?.kind === "delivered" ? true : { delivered: false, detail: sent?.kind === "fallback" ? sent.reason : "agy language server is unavailable" };
    };
  }
  if (target.value.agent === "codex") {
    channels["codex-queue"] = async () => {
      const found = await findCodexProcessByThread(target.value.id, process);
      if (!("pid" in found)) return { delivered: false, detail: found.reason };
      const sent = await deliverCodexQueue(target.value.id, found.pid, parsed.value.text, process);
      return sent.kind === "queued" ? true : { delivered: false, detail: sent.reason };
    };
  }
  if (typedHost !== undefined) {
    channels.typed = async () => {
      const result = await deliverOperatorText({ agent: target.value.agent, text: parsed.value.text, read: readTyped, send: sendTyped });
      return result.delivered ? true : { delivered: false, detail: result.detail };
    };
  }
  const sent = await sendSessionMessage({
    caller: "operator-send", messageId: randomUUID(), target: { agent: target.value.agent, id: target.value.id }, text: parsed.value.text,
    channels,
    recordChannel: (channel) => { recordChannelResult(database.value, { agent: target.value.agent, channel, agentVersion: "unknown", ok: true }); },
  });
  return ok(output({ delivered: sent.delivered, channel: sent.channel, ...(sent.detail === undefined ? {} : { detail: sent.detail }) }, parsed.value.json), sent.delivered ? undefined : 1);
}
