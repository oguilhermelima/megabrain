import { getDeliveryChannel, recordChannelResult } from "../adapters/state-db.js";
import { sendGrokLeaderPrompt } from "../agents/grok-leader.js";
import type { DatabaseHandle } from "../db/db.js";
import type { PeerDeliveryOutcome } from "./claude-peer-delivery.js";
import { channelVerdict } from "./delivery-channel.js";

export const GROK_LEADER_CHANNEL = "leader-socket";

export type GrokLeaderDeliveryInput = Readonly<{
  database: DatabaseHandle;
  socketPath: string;
  sessionId: string;
  text: string;
  timeoutMs?: number;
  now?: () => number;
}>;

// The leader acceptance only proves that the prompt entered its queue. The receiver's ack is the
// delivery proof, so the caller verifies it before marking this channel healthy.
export async function deliverThroughGrokLeader(input: GrokLeaderDeliveryInput): Promise<PeerDeliveryOutcome> {
  const now = input.now ?? Date.now;
  const state = getDeliveryChannel(input.database, "grok", GROK_LEADER_CHANNEL);
  const recorded = state.kind === "ok" ? state.value : undefined;
  if (recorded !== undefined && channelVerdict(recorded, recorded.agentVersion ?? "", now()) === "skip") {
    return { kind: "fallback", reason: `Grok leader socket marked broken until ${String(recorded.retryAfter)}: ${String(recorded.lastError)}` };
  }
  const sent = await sendGrokLeaderPrompt(input.socketPath, input.sessionId, input.text, input.timeoutMs);
  const agentVersion = sent.version ?? recorded?.agentVersion ?? "unknown";
  if (sent.kind === "failed") {
    recordChannelResult(input.database, { agent: "grok", channel: GROK_LEADER_CHANNEL, agentVersion, ok: false, error: sent.reason, now: now() });
    return { kind: "fallback", reason: sent.reason };
  }
  return { kind: "delivered", msgId: sent.promptId, agentVersion };
}
