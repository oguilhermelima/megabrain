export type DispatchIdResult =
  | Readonly<{ kind: "valid"; dispatchId: string }>
  | Readonly<{ kind: "invalid"; dispatchId: string }>;

export type DispatchIdSuffixResult =
  | Readonly<{ kind: "resolved"; dispatchId: string }>
  | Readonly<{ kind: "ambiguous"; dispatchIds: readonly string[] }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "too-short" }>;

export function resolveDispatchId(dispatchId: string): DispatchIdResult {
  return /^[A-Za-z0-9._-]+$/.test(dispatchId)
    ? { kind: "valid", dispatchId }
    : { kind: "invalid", dispatchId };
}

export function resolveDispatchIdSuffix(requested: string, visibleDispatchIds: readonly string[]): DispatchIdSuffixResult {
  if (!/^[A-Za-z0-9._-]+$/.test(requested)) return { kind: "unknown" };
  if (visibleDispatchIds.includes(requested)) return { kind: "resolved", dispatchId: requested };
  const matches = visibleDispatchIds.filter((dispatchId) => dispatchId.endsWith(requested));
  if (requested.length < 8) return matches.length === 0 ? { kind: "unknown" } : { kind: "too-short" };
  if (matches.length === 1) return { kind: "resolved", dispatchId: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", dispatchIds: matches };
  return { kind: "unknown" };
}
