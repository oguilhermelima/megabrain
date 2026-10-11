export type DispatchMessageType = "done" | "ask" | "stalled" | "reply" | "change" | string;

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

const labels: Readonly<Record<string, string>> = {
  done: "FINISHED", ask: "QUESTION", stalled: "STUCK", reply: "REPLY", change: "NEW DIRECTION",
};

export function dispatchMessageHeader(input: DispatchMessageInput): string {
  const agent = input.direction === "child-bound" ? input.parentAgent || "megabrain" : input.agent;
  const chatName = input.direction === "child-bound" ? input.parentChatName || "megabrain" : input.chatName;
  const label = labels[input.type] ?? input.type.toUpperCase();
  return `[megabrain][${agent}][${input.dispatchId.slice(-8)} - ${chatName}] - ${label}`;
}

function sentences(text: string): string[] {
  return text.trim().split(/(?<=[.!?])\s+/u).filter(Boolean);
}

export function formatDispatchMessage(input: DispatchMessageInput): string {
  const rawLines = input.text.split(/\r?\n/);
  const hasBullets = rawLines.some((line) => /^\s*[-*]\s/u.test(line));
  const sourceLines = hasBullets ? rawLines.filter((line) => /^\s*[-*]\s/u.test(line)).map((line) => line.trim()) : sentences(input.text).map((sentence) => `- ${sentence}`);
  const selected = sourceLines.slice(0, 4);
  let cut = sourceLines.length > 4;
  const body = selected.map((line) => {
    if (line.length <= 120) return line;
    cut = true;
    return `${line.slice(0, 119)}…`;
  });
  const pointer = input.direction === "child-bound" ? "Full text: megabrain check" : `Full report: megabrain orchestrate watch ${input.dispatchId}`;
  return [dispatchMessageHeader(input), ...body, ...(cut ? [pointer] : [])].join("\n");
}

export function formatFullDirection(input: DispatchMessageInput, text: string): string {
  const header = dispatchMessageHeader({ ...input, type: "change" });
  return `${header}\n${text}`;
}
