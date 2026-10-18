import { getDeliveryChannel, recordChannelResult } from "../adapters/state-db.js";
import { agyMessageArrived, readAgyLanguageServer, sendAgyMessage } from "../agents/agy-ls.js";
import type { DatabaseHandle } from "../db/db.js";
import type { PeerDeliveryOutcome } from "./claude-peer-delivery.js";
import { channelVerdict } from "./delivery-channel.js";

export const AGY_LS_CHANNEL = "language-server";
const DEFAULT_POLL_MS = 1_000;

export type AgyDeliveryInput = Readonly<{
  database: DatabaseHandle;
  stateRoot: string;
  // The dispatch id for a child, agyParentKey(dispatch id) for a parent.
  endpointKey: string;
  text: string;
  deadline: number;
  pollMs?: number;
  isRead: () => Promise<boolean>;
  renew: () => Promise<void>;
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
  const sent = await sendAgyMessage(endpoint, input.text);
  if (sent.kind === "unavailable") return { kind: "fallback", reason: sent.reason };
  if (sent.kind === "broken") {
    recordChannelResult(input.database, { agent: "agy", channel: AGY_LS_CHANNEL, agentVersion: endpoint.version, ok: false, error: sent.reason, now: now() });
    return { kind: "fallback", reason: sent.reason };
  }
  // A busy conversation takes the message when its turn ends, so the wait runs to the deadline.
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  while (true) {
    if (await agyMessageArrived(endpoint, input.text, sent.before)) {
      recordChannelResult(input.database, { agent: "agy", channel: AGY_LS_CHANNEL, agentVersion: endpoint.version, ok: true, now: now() });
      return { kind: "delivered", msgId: endpoint.conversationId };
    }
    if (await input.isRead()) return { kind: "read" };
    if (now() >= input.deadline) return { kind: "fallback", reason: "agy did not take the queued message before the delivery deadline" };
    await input.renew();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
