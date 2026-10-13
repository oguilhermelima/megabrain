// Policy for an alternate delivery channel (Claude's peer socket) that can stop working after an
// agent update. A broken channel is skipped until its retry time, and re-probed at once when the
// agent's version changes, so an update that fixes or breaks it is noticed on the next delivery.

export type ChannelState = Readonly<{
  status: "working" | "broken";
  agentVersion: string | null;
  retryAfter: string | null;
}>;

const BASE_RETRY_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;

export function channelVerdict(state: ChannelState | undefined, agentVersion: string, now: number): "try" | "skip" {
  if (state === undefined || state.status === "working") return "try";
  if (state.agentVersion !== agentVersion) return "try";
  const retryAfter = state.retryAfter === null ? Number.NaN : Date.parse(state.retryAfter);
  return Number.isFinite(retryAfter) && now < retryAfter ? "skip" : "try";
}

export function nextRetryAt(failures: number, now: number): number {
  const exponent = Math.max(0, Math.min(failures - 1, 16));
  return now + Math.min(BASE_RETRY_MS * 2 ** exponent, MAX_RETRY_MS);
}
