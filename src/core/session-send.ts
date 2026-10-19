import { composerExactlyHoldsText, composerReadback } from "./composer-proof.js";

export type SessionSendAgent = "claude" | "codex" | "grok" | "agy";
export type SessionSendChannel = "peer-socket" | "leader-socket" | "agy-language-server" | "codex-queue" | "typed" | "tmux";
export type OperatorSendChannel = "tmux" | "orca" | "peer-socket" | "leader-socket" | "codex-queue";
export type SessionDeliveryCaller = "reply" | "change" | "parent-notice" | "supervisor" | "operator-send" | "turn-end" | "spawn-fallback";
export type SessionDeliveryResult = Readonly<{ delivered: boolean; channel: SessionSendChannel; detail?: string }>;
export type SessionDeliveryHandlers = Partial<Record<SessionSendChannel, () => Promise<boolean | Readonly<{ delivered: boolean; stop?: boolean; detail?: string }>>>>;

const SESSION_CHANNEL_ORDER: readonly SessionSendChannel[] = ["peer-socket", "leader-socket", "agy-language-server", "codex-queue", "typed"];
const SESSION_SEND_DEDUPLICATION_TTL_MS = 5 * 60 * 1000;
const SESSION_SEND_DEDUPLICATION_LIMIT = 1_000;
type SessionSendEntry = { promise: Promise<SessionDeliveryResult>; settledAt?: number };
const inFlightOrDelivered = new Map<string, SessionSendEntry>();

function pruneSessionSendCache(now: number): void {
  for (const [key, entry] of inFlightOrDelivered) {
    if (entry.settledAt !== undefined && now - entry.settledAt >= SESSION_SEND_DEDUPLICATION_TTL_MS) inFlightOrDelivered.delete(key);
  }
  if (inFlightOrDelivered.size <= SESSION_SEND_DEDUPLICATION_LIMIT) return;
  for (const [key, entry] of inFlightOrDelivered) {
    if (entry.settledAt === undefined) continue;
    inFlightOrDelivered.delete(key);
    if (inFlightOrDelivered.size <= SESSION_SEND_DEDUPLICATION_LIMIT) break;
  }
}

/** Select and execute one session transport in the shared, stable priority order. */
export function sendSessionMessage(input: Readonly<{
  caller: SessionDeliveryCaller;
  messageId: string;
  target: Readonly<{ agent: string; id?: string }>;
  text: string;
  channels: SessionDeliveryHandlers;
  recordChannel: (channel: SessionSendChannel) => Promise<void> | void;
}>): Promise<SessionDeliveryResult> {
  if (input.messageId === "") return Promise.resolve({ delivered: false, channel: "typed", detail: "message id is required" });
  pruneSessionSendCache(Date.now());
  // A queue id can be reused by a different session (for example, parent and child queues both
  // use a local sequence). Scope the id to its destination so that does not suppress delivery.
  const deliveryKey = `${input.target.agent}\0${input.target.id ?? "unknown"}\0${input.messageId}`;
  const previous = inFlightOrDelivered.get(deliveryKey);
  if (previous !== undefined) return previous.promise;
  const delivery = (async (): Promise<SessionDeliveryResult> => {
    let detail: string | undefined;
    let attempted = false;
    for (const channel of SESSION_CHANNEL_ORDER) {
      const send = input.channels[channel];
      if (send === undefined) continue;
      attempted = true;
      try {
        const attempt = await send();
        const result = typeof attempt === "boolean" ? { delivered: attempt } : attempt;
        if (result.stop === true) return { delivered: false, channel, ...(result.detail === undefined ? {} : { detail: result.detail }) };
        if (!result.delivered) { detail = result.detail ?? detail; continue; }
        try { await input.recordChannel(channel); } catch { /* A send that landed cannot be undone by channel telemetry. */ }
        return { delivered: true, channel };
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
    }
    return { delivered: false, channel: "typed", ...(detail === undefined ? attempted ? {} : { detail: "no delivery channel is available for this session" } : { detail }) };
  })();
  const entry: SessionSendEntry = { promise: delivery };
  inFlightOrDelivered.set(deliveryKey, entry);
  void delivery.then((result) => {
    if (!result.delivered && inFlightOrDelivered.get(deliveryKey) === entry) inFlightOrDelivered.delete(deliveryKey);
    else if (result.delivered) {
      entry.settledAt = Date.now();
      pruneSessionSendCache(entry.settledAt);
    }
  });
  return delivery;
}
export type SessionSendAvailability = Readonly<{
  peerSocket?: boolean;
  leaderSocket?: boolean;
  codexQueue?: boolean;
  tmux?: boolean;
}>;

export function selectSessionSendChannel(agent: SessionSendAgent, available: SessionSendAvailability): SessionSendChannel | undefined {
  const preferred: Partial<Record<SessionSendAgent, SessionSendChannel>> = {
    claude: "peer-socket",
    codex: "codex-queue",
    grok: "leader-socket",
  };
  const channel = preferred[agent];
  if (channel === "peer-socket" && available.peerSocket === true) return channel;
  if (channel === "leader-socket" && available.leaderSocket === true) return channel;
  if (channel === "codex-queue" && available.codexQueue === true) return channel;
  if (available.tmux === true) return "tmux";
  return undefined;
}
export function selectOperatorSendChannel(agent: SessionSendAgent, available: SessionSendAvailability & { orca?: boolean }): OperatorSendChannel | undefined {
  if (available.tmux === true) return "tmux";
  if (available.orca === true) return "orca";
  if (agent === "claude" && available.peerSocket === true) return "peer-socket";
  if (agent === "grok" && available.leaderSocket === true) return "leader-socket";
  if (agent === "codex" && available.codexQueue === true) return "codex-queue";
  return undefined;
}

type OrcaTerminal = Readonly<Record<string, unknown> & { handle: string }>;
function normalizedTitle(value: string): string {
  return value.replace(/^\s*[✳✻✽✢⟳⏵◐◑◒◓]\s*/u, "").replace(/^(?:claude|codex|grok|agy)\s·\s/iu, "").trim();
}

export function matchOrcaTerminal(value: unknown, target: Readonly<{ agent: string; worktreePath: string; title?: string }>): OrcaTerminal | undefined {
  if (!Array.isArray(value) || target.title === undefined || target.title.trim() === "") return undefined;
  const candidates = value.filter((entry): entry is OrcaTerminal => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const terminal = entry as Record<string, unknown>;
    return typeof terminal.handle === "string" && terminal.connected === true && terminal.writable === true &&
      terminal.agentIdentity === target.agent && terminal.worktreePath === target.worktreePath;
  });
  const matches = candidates.filter((terminal) => typeof terminal.title === "string" && normalizedTitle(terminal.title) === normalizedTitle(target.title ?? ""));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function deliverOperatorText(input: Readonly<{
  agent: string; text: string;
  read: () => Promise<string | undefined>;
  send: (text: string, enter: boolean) => Promise<"ok" | string>;
  // Removes what send typed. Absent when the channel cannot clear the composer.
  clear?: () => Promise<"ok" | string>;
  // A freshly resumed session draws its history before it shows the composer, and renders a paste late.
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  confirmTimeoutMs?: number;
}>): Promise<Readonly<{ delivered: boolean; detail?: string }>> {
  const submitted = await input.send(input.text, true);
  if (submitted !== "ok") return { delivered: false, detail: submitted };
  let screen = await input.read();
  // A successful submit command is the only usable proof when the target cannot be read.
  if (screen === undefined) return { delivered: true };
  if (!composerExactlyHoldsText(input.agent, screen, input.text)) return { delivered: true };
  const resubmitted = await input.send("", true);
  if (resubmitted !== "ok") return { delivered: false, detail: resubmitted };
  screen = await input.read();
  if (screen !== undefined && composerExactlyHoldsText(input.agent, screen, input.text)) {
    return { delivered: false, detail: "The submitted text could not be verified in the session." };
  }
  return { delivered: true };
}
