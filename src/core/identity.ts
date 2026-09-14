export type ConsumerIdentityInput = Readonly<{
  readonly environmentConsumer?: string;
  readonly explicitConsumer?: string;
  readonly sessionHost?: string;
  readonly sessionId?: string;
  readonly fallbackConsumer?: string;
}>;

export function resolveConsumerIdentity(input: ConsumerIdentityInput): string | undefined {
  const explicit = input.explicitConsumer?.trim();
  if (explicit) return explicit;
  const environment = input.environmentConsumer?.trim();
  if (environment) return environment;
  if (input.sessionHost && input.sessionId) return `${input.sessionHost}/${input.sessionId}`;
  const fallback = input.fallbackConsumer?.trim();
  return fallback || undefined;
}
