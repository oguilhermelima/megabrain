export type NativeSessionKey = Readonly<{ udid: string; bundleId: string }>;
export type NativeSession = NativeSessionKey & Readonly<{ sessionId: string }>;

export function nativeSessionIdentity(key: NativeSessionKey): string {
  return `${key.udid}\u0000${key.bundleId}`;
}

export function parseNativeSessions(value: unknown): NativeSession[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as { version?: unknown; sessions?: unknown };
  if (record.version !== 1 || !Array.isArray(record.sessions)) return [];
  const sessions: NativeSession[] = [];
  const identities = new Set<string>();
  for (const entry of record.sessions) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.udid !== "string" || item.udid === "" || typeof item.bundleId !== "string" || item.bundleId === "" || typeof item.sessionId !== "string" || item.sessionId === "") continue;
    const session = { udid: item.udid, bundleId: item.bundleId, sessionId: item.sessionId };
    const identity = nativeSessionIdentity(session);
    if (!identities.has(identity)) {
      identities.add(identity);
      sessions.push(session);
    }
  }
  return sessions;
}

export function nativeSessionFor(sessions: readonly NativeSession[], key: NativeSessionKey): NativeSession | undefined {
  const identity = nativeSessionIdentity(key);
  return sessions.find((session) => nativeSessionIdentity(session) === identity);
}

export function replaceNativeSession(sessions: readonly NativeSession[], replacement: NativeSession): NativeSession[] {
  const identity = nativeSessionIdentity(replacement);
  return [...sessions.filter((session) => nativeSessionIdentity(session) !== identity), replacement];
}

export function removeNativeSession(sessions: readonly NativeSession[], key: NativeSessionKey): NativeSession[] {
  const identity = nativeSessionIdentity(key);
  return sessions.filter((session) => nativeSessionIdentity(session) !== identity);
}
