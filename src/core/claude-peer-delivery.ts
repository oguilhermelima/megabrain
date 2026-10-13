import { getDeliveryChannel, recordChannelResult } from "../adapters/state-db.js";
import { resolveClaudePeer, scanTranscript, sendClaudePeer, transcriptSize, type PeerPermissionClass } from "../agents/claude-peer.js";
import { commandLine } from "../agents/index.js";
import { resolveClaudeSession } from "../agents/claude-session.js";
import type { DatabaseHandle } from "../db/db.js";
import { channelVerdict } from "./delivery-channel.js";

export const CLAUDE_PEER_CHANNEL = "peer-socket";
const DEFAULT_IDLE_DROP_MS = 20_000;
const POLL_MS = 500;

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

export type PeerDeliveryOutcome =
  | Readonly<{ kind: "delivered"; msgId: string }>
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
  deadline: number;
  // How long the session may sit idle without consuming the message before it counts as dropped.
  // An idle Claude starts a turn on a peer message within a second; a busy one takes it when the
  // running tool or turn ends, so only idle time counts.
  idleDropMs?: number;
  isRead: () => Promise<boolean>;
  renew: () => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}>;

const defaultWait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function deliverThroughClaudePeer(input: PeerDeliveryInput): Promise<PeerDeliveryOutcome> {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? defaultWait;
  const idleDropMs = input.idleDropMs ?? DEFAULT_IDLE_DROP_MS;
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

  let scanned = await transcriptSize(target.transcript);
  const sent = await sendClaudePeer(target, input.text, input.senderMode);
  if (sent.kind !== "ok") return broken(target.version, sent.error);
  const msgId = sent.value;
  let idleSince: number | undefined;
  while (true) {
    const scan = await scanTranscript(target.transcript, scanned, msgId);
    scanned = scan.next;
    if (scan.seen === "consumed") {
      recordChannelResult(input.database, { agent: "claude", channel: CLAUDE_PEER_CHANNEL, agentVersion: target.version, ok: true, now: now() });
      return { kind: "delivered", msgId };
    }
    // A hold is this session's crossSessionInbound policy at work, not a broken channel.
    if (scan.seen === "held") return { kind: "fallback", reason: `Claude held peer message ${msgId} for review (crossSessionInbound policy)` };
    if (await input.isRead()) return { kind: "read" };
    const session = await resolveClaudeSession(input.home, target.pid, target.sessionId);
    if (session === undefined) return { kind: "fallback", reason: "Claude session ended before it consumed the peer message" };
    if (session.status === "idle") {
      idleSince ??= now();
      if (now() - idleSince >= idleDropMs) return broken(target.version, `idle session did not consume peer message ${msgId} within ${idleDropMs} ms`);
    } else {
      idleSince = undefined;
    }
    if (now() >= input.deadline) return { kind: "fallback", reason: "delivery deadline passed before Claude consumed the peer message" };
    await input.renew();
    await wait(POLL_MS);
  }
}
