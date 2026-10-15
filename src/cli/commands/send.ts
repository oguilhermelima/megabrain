import { resolveClaudePeer, sendClaudePeer } from "../../agents/claude-peer.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { listDispatches, stateDatabase } from "../../adapters/state-db.js";
import { deliverCodexQueue, findCodexProcess, findCodexProcessByThread } from "../../core/codex-delivery.js";
import { failed, ok, type Result } from "../../core/result.js";
import { deliverThroughGrokLeader } from "../../core/grok-leader-delivery.js";
import { selectSessionSendChannel, type SessionSendAgent } from "../../core/session-send.js";
import { usageText } from "../../core/usage.js";
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

export async function executeSend(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("send"));
  if (environment.MEGABRAIN_OPERATOR !== "1") return failed("megabrain send is for the operator; pass --operator");
  const parsed = parseArgs(args);
  if (parsed.kind !== "ok") return parsed;
  const target = parseTarget(parsed.value.session);
  if (target.kind !== "ok") return target;
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
  const channel = selectSessionSendChannel(target.value.agent, {
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
  if (channel === "peer-socket" && peer?.kind === "ok") {
    // An operator has no honest permission-mode attestation, so the envelope deliberately omits it.
    const sent = await sendClaudePeer(peer.value, parsed.value.text);
    if (sent.kind === "ok") return ok(output({ delivered: true, channel }, parsed.value.json));
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
