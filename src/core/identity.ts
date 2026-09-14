export type ConsumerIdentityInput = Readonly<{
  readonly mailbox: "parent" | "child";
  readonly environmentConsumer?: string;
  readonly explicitConsumer?: string;
  readonly sessionHost?: string;
  readonly sessionId?: string;
  readonly childHost?: string;
  readonly childSessionId?: string;
  readonly tmux?: Readonly<{
    readonly session?: string;
    readonly pane?: string;
  }>;
}>;

export type ConsumerIdentity =
  | { readonly kind: "known"; readonly value: string }
  | { readonly kind: "unknown"; readonly reason: string };

const known = (value: string): ConsumerIdentity => ({ kind: "known", value });

export function resolveConsumerIdentity(input: ConsumerIdentityInput): ConsumerIdentity {
  const explicit = input.explicitConsumer?.trim();
  if (explicit) return known(explicit);
  const environment = input.environmentConsumer?.trim();
  if (environment) return known(environment);
  if (input.mailbox === "parent") {
    if (input.sessionHost && input.sessionId) return known(`${input.sessionHost}/${input.sessionId}`);
    return { kind: "unknown", reason: "parent session identity is unavailable" };
  }
  if (input.tmux !== undefined && input.tmux.pane) {
    if (!input.tmux.session) return { kind: "unknown", reason: "tmux session could not be resolved" };
    if (!input.childHost) return { kind: "unknown", reason: "child host identity is unavailable" };
    return known(`child/${input.childHost}/${input.tmux.session}/${input.tmux.pane}`);
  }
  if (input.childHost && input.childSessionId) return known(`child/${input.childHost}/${input.childSessionId}`);
  return { kind: "unknown", reason: "child session identity is unavailable" };
}
