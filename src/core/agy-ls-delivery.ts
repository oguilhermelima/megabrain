import { getDeliveryChannel, recordChannelResult } from "../adapters/state-db.js";
import { readAgyLanguageServer, sendAgyMessage } from "../agents/agy-ls.js";
import type { DatabaseHandle } from "../db/db.js";
import type { PeerDeliveryOutcome } from "./claude-peer-delivery.js";
import { channelVerdict } from "./delivery-channel.js";

export const AGY_LS_CHANNEL = "language-server";
export type AgyDeliveryInput = Readonly<{
  database: DatabaseHandle;
  stateRoot: string;
  // The dispatch id for a child, agyParentKey(dispatch id) for a parent.
  endpointKey: string;
  text: string;
  isRead: () => Promise<boolean>;
  now?: () => number;
}>;

// Undefined when this agy never reported an endpoint, so the caller keeps its typed path.
export async function deliverThroughAgyLanguageServer(input: AgyDeliveryInput): Promise<PeerDeliveryOutcome | undefined> {
  const now = input.now ?? Date.now;
  const endpoint = await readAgyLanguageServer(input.stateRoot, input.endpointKey);
  if (endpoint === undefined) return undefined;
  const state = getDeliveryChannel(input.database, "agy", AGY_LS_CHANNEL);
  if (state.kind === "ok" && channelVerdict(state.value, endpoint.version, now()) === "skip") {
    return { kind: "fallback", reason: `agy language server marked broken until ${String(state.value?.retryAfter)}: ${String(state.value?.lastError)}` };
  }
  if (await input.isRead()) return { kind: "read" };
  const sent = await sendAgyMessage(endpoint, input.text);
  if (sent.kind === "unavailable") return { kind: "fallback", reason: sent.reason };
  if (sent.kind === "broken") {
    recordChannelResult(input.database, { agent: "agy", channel: AGY_LS_CHANNEL, agentVersion: endpoint.version, ok: false, error: sent.reason, now: now() });
    return { kind: "fallback", reason: sent.reason };
  }
  recordChannelResult(input.database, { agent: "agy", channel: AGY_LS_CHANNEL, agentVersion: endpoint.version, ok: true, now: now() });
  return { kind: "delivered", msgId: endpoint.conversationId };
}
