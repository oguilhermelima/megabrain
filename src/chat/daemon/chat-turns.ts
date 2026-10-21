import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ChatDaemon } from "../daemon.js";
import type { Chat, ChatLine } from "../store.js";

export const isBusy = (chat: Chat) => chat.state === "working" || chat.state === "waiting-approval";

export const MAX_SEED_CONTEXT_BYTES = 200 * 1024;
const OMITTED_SEED_TURNS = "Earlier turns were omitted to fit the conversation context limit.";

export async function mutate<T>(daemon: ChatDaemon, id: string, action: () => Promise<T>): Promise<T> {
  if (daemon.chatMutations.has(id)) throw Object.assign(new Error("chat is busy"), { code: "chat-busy" });
  daemon.chatMutations.add(id);
  try { return await action(); }
  finally { daemon.chatMutations.delete(id); }
}

export function selectedTurn(lines: readonly ChatLine[], eventId: string): { userIndex: number; end: number; turnId: string | undefined } | null {
  const eventIndex = lines.findIndex((line) => line.event?.id === eventId);
  if (eventIndex < 0) return null;
  let userIndex = eventIndex;
  while (userIndex >= 0 && lines[userIndex]?.event?.kind !== "user") userIndex -= 1;
  if (userIndex < 0) return null;
  let end = eventIndex + 1;
  while (end < lines.length && lines[end]?.event?.kind !== "user") end += 1;
  return { userIndex, end, turnId: lines[userIndex]?.event?.turnId };
}

export function seedContext(lines: readonly ChatLine[]): string {
  const entries = lines.flatMap((line) => {
    const item = line.event;
    if (!item) return [];
    if (item.kind === "user") {
      const content = item.parts?.map((part) => part.type === "text" ? part.text : `[image: ${part.path}]`).join("\n") ?? item.text;
      return [`Human: ${content}`];
    }
    if (item.kind === "assistant") return [`Assistant: ${item.text}`];
    if (item.kind === "tool-call") return [`Tool call (${item.tool?.name ?? item.text}): ${item.tool?.input ?? ""}`];
    if (item.kind === "tool-result") return [`Tool result (${item.tool?.name ?? "tool"}): ${item.text}`];
    return [];
  });
  const turns: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("Human: ") && turns.length > 0) turns.push(entry);
    else if (turns.length > 0) turns[turns.length - 1] += `\n\n${entry}`;
    else turns.push(entry);
  }

  const complete = turns.join("\n\n");
  if (Buffer.byteLength(complete) <= MAX_SEED_CONTEXT_BYTES) return complete;

  const prefix = `${OMITTED_SEED_TURNS}\n\n`;
  const budget = MAX_SEED_CONTEXT_BYTES - Buffer.byteLength(prefix);
  const kept: string[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const separatorBytes = kept.length === 0 ? 0 : Buffer.byteLength("\n\n");
    const turnBytes = Buffer.byteLength(turn);
    if (used + separatorBytes + turnBytes <= budget) {
      kept.unshift(turn);
      used += separatorBytes + turnBytes;
      continue;
    }
    if (kept.length === 0 && budget > 0) {
      const bytes = Buffer.from(turn);
      let start = Math.max(0, bytes.length - budget);
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
      kept.unshift(bytes.subarray(start).toString("utf8"));
    }
    break;
  }
  return prefix + kept.join("\n\n");
}

export async function ensureCodexChild(daemon: ChatDaemon, chat: Chat): Promise<ChildProcessWithoutNullStreams> {
  if (daemon.children.has(chat.id)) return daemon.children.get(chat.id)!;
  await daemon.runAgent(chat);
  const deadline = Date.now() + 10_000;
  while (!daemon.children.has(chat.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const child = daemon.children.get(chat.id);
  if (!child) throw new Error("Codex app-server did not start");
  return child;
}
