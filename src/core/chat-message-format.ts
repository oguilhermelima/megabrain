export type DispatchMessageType = "done" | "ask" | "stalled" | "policy" | "reply" | "change" | string;

export type DispatchMessageInput = Readonly<{
  dispatchId: string;
  chatName: string;
  agent: string;
  type: DispatchMessageType;
  text: string;
  direction: "parent-bound" | "child-bound";
  parentAgent?: string;
  parentChatName?: string;
  fullTextCommand?: string;
}>;

const labels: Readonly<Record<string, Readonly<{ icon: string; words: string }>>> = {
  done: { icon: "✅", words: "finished" },
  ask: { icon: "❓", words: "has a question" },
  stalled: { icon: "⚠️", words: "is stuck" },
  supervise: { icon: "⚠️", words: "is stuck" },
  policy: { icon: "⚠️", words: "policy action" },
  reply: { icon: "💬", words: "reply" },
  change: { icon: "🔀", words: "new direction" },
};

export function dispatchMessageHeader(input: DispatchMessageInput): string {
  const agent = input.direction === "child-bound" ? input.parentAgent ?? "megabrain" : input.agent;
  const chatName = input.direction === "child-bound" ? input.parentChatName ?? "megabrain" : input.chatName;
  const label = labels[input.type] ?? { icon: "💬", words: input.type };
  return `${label.icon} ${agent} · ${chatName} ${label.words}`;
}

function removeBulletMarkers(text: string): string {
  return text.replace(/^\s*(?:(?:[-*•])|(?:\d+[.)]))\s+/u, "").trim();
}

function firstSentence(text: string): string {
  const normalized = text.trim();
  const boundary = /[.!?](?=\s|$)/u.exec(normalized);
  return boundary === null ? normalized : normalized.slice(0, boundary.index + 1).trim();
}

function summary(text: string): string {
  const firstLine = text.trim().split(/\r?\n/u, 1)[0] ?? "";
  const firstSentenceText = firstSentence(text);
  const selected = firstLine.length < firstSentenceText.length ? firstLine : firstSentenceText;
  const cleaned = removeBulletMarkers(selected);
  if (cleaned.length <= 140) return cleaned;
  const prefix = cleaned.slice(0, 139);
  const boundary = prefix.lastIndexOf(" ");
  return `${(boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}

export function formatDispatchMessage(input: DispatchMessageInput): string {
  const pointer = input.direction === "child-bound"
    ? "→ full text: megabrain check"
    : `→ details: megabrain orchestrate watch ${input.dispatchId.slice(-8)}`;
  return [dispatchMessageHeader(input), summary(input.text), pointer].join("\n");
}

export function formatFullDirection(input: DispatchMessageInput, text: string): string {
  const header = dispatchMessageHeader({ ...input, type: "change" });
  return `${header}\n${text}`;
}

/** Joins a message onto one line for hosts that cannot take newlines; the pointer arrow only reads right on its own line. */
export function formatOneLine(message: string): string {
  return message.replace(/\r\n?/g, "\n").replace(/\n→ /g, "\n").replace(/\n/g, " — ");
}
