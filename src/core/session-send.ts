export type SessionSendAgent = "claude" | "codex" | "grok" | "agy";
export type SessionSendChannel = "peer-socket" | "leader-socket" | "codex-queue" | "tmux";
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
