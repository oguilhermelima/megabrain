import { composerExactlyHoldsText, composerReadback } from "./composer-proof.js";

export type SessionSendAgent = "claude" | "codex" | "grok" | "agy";
export type SessionSendChannel = "peer-socket" | "leader-socket" | "codex-queue" | "tmux";
export type OperatorSendChannel = "tmux" | "orca" | "peer-socket" | "leader-socket" | "codex-queue";
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
  const interval = input.pollIntervalMs ?? 150;
  const readUntil = async (accept: (screen: string | undefined) => boolean, timeoutMs: number): Promise<string | undefined> => {
    const deadline = Date.now() + timeoutMs;
    let screen = await input.read();
    while (!accept(screen) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      screen = await input.read();
    }
    return screen;
  };
  const initial = await readUntil((screen) => {
    if (screen === undefined) return false;
    if (/\b(?:Press|Choose|Allow|Deny|Approve|trust this|permission request)\b/i.test(screen)) return true;
    return composerReadback(input.agent, screen).region?.trim() === "";
  }, input.readyTimeoutMs ?? 0);
  if (initial === undefined) return { delivered: false, detail: "Could not read the session's terminal." };
  if (/\b(?:Press|Choose|Allow|Deny|Approve|trust this|permission request)\b/i.test(initial)) return { delivered: false, detail: "The session is showing a question in its terminal; answer it there first." };
  const before = composerReadback(input.agent, initial).region;
  if (before === undefined) return { delivered: false, detail: "Could not read the session's terminal." };
  if (before.trim() !== "") return { delivered: false, detail: "The session already has text in its input box in its terminal; send it or clear it there, then try again." };
  const typed = await input.send(input.text, false);
  if (typed !== "ok") return { delivered: false, detail: typed };
  const readback = await readUntil((screen) => screen !== undefined && composerExactlyHoldsText(input.agent, screen, input.text), input.confirmTimeoutMs ?? 3000);
  if (readback === undefined || !composerExactlyHoldsText(input.agent, readback, input.text)) {
    const unconfirmed = "The text could not be confirmed in the session's input.";
    if (input.clear === undefined) return { delivered: false, detail: `${unconfirmed} It was left in the input box unsent; send or clear it in the terminal.` };
    const cleared = await input.clear();
    const after = cleared === "ok" ? await input.read() : undefined;
    const region = after === undefined ? undefined : composerReadback(input.agent, after).region;
    return region !== undefined && region.trim() === ""
      ? { delivered: false, detail: `${unconfirmed} What was typed was cleared, so nothing was sent.` }
      : { delivered: false, detail: `${unconfirmed} It may still be in the input box unsent; check its terminal before sending again.` };
  }
  const submitted = await input.send("", true);
  return submitted === "ok" ? { delivered: true } : { delivered: false, detail: submitted };
}
