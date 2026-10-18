import { getDeliveryChannel, recordChannelResult } from "../adapters/state-db.js";
import { resolveClaudePeer, scanTranscript, sendClaudePeer, transcriptSize, type PeerPermissionClass } from "../agents/claude-peer.js";
import { commandLine } from "../agents/index.js";
import type { DatabaseHandle } from "../db/db.js";
import { channelVerdict } from "./delivery-channel.js";

export const CLAUDE_PEER_CHANNEL = "peer-socket";
// Flags with which each agent's launch line turns off its own approval prompts.
const NO_PROMPT_FLAGS = ["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--always-approve"];

// The permission class megabrain may attest for a notice from a child of this agent: read from the
// launch line megabrain itself builds, so it stops claiming bypass the day that flag goes away.
export function senderPermissionClass(agent: string): PeerPermissionClass | undefined {
  const line = commandLine(agent, { model: null, effort: null, browser: false, agentArgs: [] });
  if (line.kind !== "ok") return undefined;
  const words = line.value.split(/\s+/);
  return NO_PROMPT_FLAGS.some((flag) => words.includes(flag)) ? "bypass" : "prompting";
}

// Claude may hold a peer message when its permission class differs from the sender's. Only use the
// socket when both classes are known and match; otherwise send immediately through the typed path.
export type PeerChannelChoice =
  | Readonly<{ kind: "socket"; senderMode?: PeerPermissionClass }>
  | Readonly<{ kind: "type"; reason: string }>;

export function choosePeerChannel(sender: PeerPermissionClass | undefined, receiver: PeerPermissionClass | undefined): PeerChannelChoice {
  if (sender !== undefined && receiver !== undefined && receiver === sender) return { kind: "socket", senderMode: sender };
  return { kind: "type", reason: `the sender and receiver permission classes are not both known and equal (sender: ${sender ?? "unknown"}, receiver: ${receiver ?? "unknown"})` };
}

export type PeerDeliveryOutcome =
  | Readonly<{ kind: "delivered"; msgId: string; agentVersion?: string }>
  | Readonly<{ kind: "accepted"; msgId: string }>
  | Readonly<{ kind: "read" }>
  | Readonly<{ kind: "fallback"; reason: string }>;

export type PeerDeliveryInput = Readonly<{
  database: DatabaseHandle;
  home: string;
  pid: number;
  sessionId: string;
  text: string;
  // The class of the agent the notice comes from; omitted when it cannot be stated honestly.
  senderMode?: PeerPermissionClass;
  isRead: () => Promise<boolean>;
  onSent?: (msgId: string) => Promise<void> | void;
  onAccepted?: (record: Readonly<{ messageId: string; transcript: string; transcriptOffset: number; agentVersion: string; acceptedAt: number }>) => Promise<void> | void;
  now?: () => number;
}>;

export type PeerConsumption = "consumed" | "held" | undefined;
export type PeerSessionStatus = "idle" | "busy" | "ended";

// The timeout is measured only while Claude reports idle. A busy session may keep a queued
// peer message for as long as needed without turning socket acceptance into a false success.
export async function verifyClaudePeerConsumption(input: Readonly<{
  acknowledged: () => Promise<boolean>;
  status: () => Promise<PeerSessionStatus>;
  scan: () => Promise<PeerConsumption>;
  fallback: () => Promise<void>;
  heartbeat?: () => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
  now?: () => number;
  idleWindowMs?: number;
  pollIntervalMs?: number;
}>): Promise<"delivered" | "fallback"> {
  const now = input.now ?? Date.now;
  const idleWindowMs = input.idleWindowMs ?? 20_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  let idleSince: number | undefined;
  for (;;) {
    await input.heartbeat?.();
    if (await input.acknowledged()) return "delivered";
    const status = await input.status();
    if (status === "ended") break;
    const current = now();
    if (status === "busy") idleSince = undefined;
    else {
      idleSince ??= current;
      if (current - idleSince >= idleWindowMs) break;
    }
    await input.sleep(pollIntervalMs);
  }
  if (await input.scan() === "consumed") return "delivered";
  await input.fallback();
  return "fallback";
}

export async function deliverThroughClaudePeer(input: PeerDeliveryInput): Promise<PeerDeliveryOutcome> {
  const now = input.now ?? Date.now;
  const broken = (agentVersion: string, error: string): PeerDeliveryOutcome => {
    recordChannelResult(input.database, { agent: "claude", channel: CLAUDE_PEER_CHANNEL, agentVersion, ok: false, error, now: now() });
    return { kind: "fallback", reason: error };
  };

  const resolved = await resolveClaudePeer(input.home, input.pid, input.sessionId);
  if (resolved.kind === "unresolved") return { kind: "fallback", reason: resolved.reason };
  if (resolved.kind === "unsupported") return broken(resolved.version, resolved.reason);
  const target = resolved.value;
  const state = getDeliveryChannel(input.database, "claude", CLAUDE_PEER_CHANNEL);
  if (state.kind === "ok" && channelVerdict(state.value, target.version, now()) === "skip") {
    return { kind: "fallback", reason: `peer socket marked broken until ${String(state.value?.retryAfter)}: ${String(state.value?.lastError)}` };
  }
  if (await input.isRead()) return { kind: "read" };
  const transcriptOffset = await transcriptSize(target.transcript);
  const sent = await sendClaudePeer(target, input.text, input.senderMode);
  if (sent.kind !== "ok") return broken(target.version, sent.error);
  const msgId = sent.value;
  try { await input.onSent?.(msgId); } catch { /* Recording acceptance must not undo a sent peer message. */ }
  try { await input.onAccepted?.({ messageId: msgId, transcript: target.transcript, transcriptOffset, agentVersion: target.version, acceptedAt: now() }); } catch { /* The supervisor can recover a peer send without a verifier record. */ }
  return { kind: "accepted", msgId };
}
