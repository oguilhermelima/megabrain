export type ChainStep = Readonly<Record<string, unknown>>;
export type ChainDefinition = Readonly<{
  readonly when?: Readonly<Record<string, string>>;
  readonly steps: readonly ChainStep[];
}>;
export type ChainConfig = Readonly<{
  readonly chains: Readonly<Record<string, ChainDefinition>>;
  readonly defaultSteps: readonly ChainStep[];
  readonly usageLimits?: Readonly<{
    readonly liveProviders?: readonly string[];
    readonly cacheTtlSeconds?: number;
    readonly timeoutSeconds?: number;
    readonly notice?: Readonly<{ readonly enabled?: boolean; readonly intervalSeconds?: number }>;
  }>;
}>;

export type ChainSelection =
  | { readonly kind: "selected"; readonly name: string; readonly steps: readonly ChainStep[]; readonly usedDefault: boolean; readonly reason: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "not-found"; readonly name: string }
  | { readonly kind: "default"; readonly name: "defaultSteps"; readonly steps: readonly ChainStep[]; readonly reason: string };

export function selectChain(
  config: ChainConfig,
  explicitName: string | undefined,
  parent: Readonly<{ readonly agent?: string; readonly model?: string; readonly effort?: string }>,
  explicitSource: "name" | "flag" = "name",
): ChainSelection {
  if (explicitName !== undefined && explicitName.length > 0) {
    const chain = config.chains[explicitName];
    if (chain !== undefined) return { kind: "selected", name: explicitName, steps: chain.steps, usedDefault: false, reason: explicitSource === "flag" ? "explicit --chain requested" : "explicit name given" };
    return { kind: "not-found", name: explicitName };
  }
  const matches = Object.entries(config.chains).filter(([, chain]) => {
    const selector = chain.when ?? {};
    return Object.entries(selector).every(([field, value]) => {
      const actual = field === "parentAgent" ? parent.agent : field === "parentModel" ? parent.model : parent.effort;
      return actual !== undefined && actual.length > 0 && actual === value;
    });
  });
  if (matches.length > 0) {
    const mostSpecific = Math.max(...matches.map(([, chain]) => Object.keys(chain.when ?? {}).length));
    const candidates = matches.filter(([, chain]) => Object.keys(chain.when ?? {}).length === mostSpecific).map(([name]) => name);
    if (candidates.length > 1) return { kind: "ambiguous", candidates };
    const name = candidates[0];
    const chain = config.chains[name];
    return { kind: "selected", name, steps: chain.steps, usedDefault: false, reason: `selector match with ${mostSpecific} field(s)` };
  }
  const hasSelectorFields = Object.values(config.chains).some((chain) => Object.keys(chain.when ?? {}).length > 0);
  const reason = hasSelectorFields && (parent.agent === undefined || parent.agent.length === 0)
    ? "parent agent is unknown; no selector matched; using defaultSteps"
    : "no selector matched; using defaultSteps";
  return { kind: "default", name: "defaultSteps", steps: config.defaultSteps, reason };
}
