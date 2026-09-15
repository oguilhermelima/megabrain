export type DispatchIdResult =
  | Readonly<{ kind: "valid"; dispatchId: string }>
  | Readonly<{ kind: "invalid"; dispatchId: string }>;

export function resolveDispatchId(dispatchId: string): DispatchIdResult {
  return /^[A-Za-z0-9._-]+$/.test(dispatchId)
    ? { kind: "valid", dispatchId }
    : { kind: "invalid", dispatchId };
}
