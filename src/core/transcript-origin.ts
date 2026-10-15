import type { TranscriptEvent, TranscriptOrigin } from "./session-transcript.js";

export type TranscriptOriginDispatch = Readonly<{
  dispatchId: string;
  chatName?: string | null;
  label?: string | null;
  branch?: string | null;
  agent?: string | null;
  parentAgent?: string | null;
  parentChatName?: string | null;
  parentSessionId?: string | null;
}>;

function string(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parentLabel(dispatch: TranscriptOriginDispatch): string {
  const chatName = string(dispatch.parentChatName);
  if (chatName !== undefined) return chatName;
  const agent = string(dispatch.parentAgent) ?? "megabrain";
  const sessionId = string(dispatch.parentSessionId);
  if (sessionId === undefined) return agent;
  const separator = sessionId.indexOf(":");
  const shortId = sessionId.slice(separator < 0 ? 0 : separator + 1).slice(-8);
  return `${agent} · ${shortId}`;
}

function childDispatch(text: string, dispatches: readonly TranscriptOriginDispatch[]): TranscriptOriginDispatch | undefined {
  const suffix = /details:\s*megabrain orchestrate watch ([a-z0-9]{8})\b/i.exec(text)?.[1]?.toLowerCase();
  if (suffix === undefined) return undefined;
  const matches = dispatches.filter((dispatch) => dispatch.dispatchId.toLowerCase().endsWith(suffix));
  return matches.length === 1 ? matches[0] : undefined;
}

function isParentMessage(text: string): boolean {
  return /^\[megabrain dispatch:/i.test(text)
    || /^(?:💬 megabrain · .+ reply|🔀 megabrain · .+ new direction)(?:\r?\n|$)/u.test(text);
}

function isChildNotice(text: string): boolean {
  const peerEnvelope = /<cross-session-message\s+from-name="megabrain"[^>]*>/i.test(text);
  const notice = /(?:✅[^\r\n]*(?:finished)|❓[^\r\n]*(?:has a question)|⚠️[^\r\n]*(?:is stuck|policy action))/u.test(text);
  return notice && (peerEnvelope || /details:\s*megabrain orchestrate watch [a-z0-9]{8}\b/i.test(text));
}

export function tagTranscriptOrigins(
  events: readonly TranscriptEvent[],
  currentDispatch: TranscriptOriginDispatch | null,
  dispatches: readonly TranscriptOriginDispatch[],
): TranscriptEvent[] {
  return events.map((event) => {
    if (currentDispatch !== null && isParentMessage(event.text)) {
      const origin: TranscriptOrigin = {
        kind: "parent",
        label: parentLabel(currentDispatch),
        dispatchId: null,
        sessionId: string(currentDispatch.parentSessionId) ?? null,
      };
      return { ...event, origin };
    }
    if (isChildNotice(event.text)) {
      const child = childDispatch(event.text, dispatches);
      if (child !== undefined) {
        const origin: TranscriptOrigin = {
          kind: "child",
          label: string(child.chatName) ?? string(child.label) ?? string(child.branch) ?? child.dispatchId,
          dispatchId: child.dispatchId,
          sessionId: null,
        };
        return { ...event, origin };
      }
    }
    return event;
  });
}
