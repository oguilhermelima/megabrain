import type { ChatStore } from "../store.js";
import type { ChatDaemon } from "../daemon.js";
import type { Chat } from "../store.js";
import type { MessagePart } from "../protocol.js";
import { commandOutputEvent, infoCommandData } from "./info-command.js";

/**
 * The slash command a local command's output answers: the user event right before it, when that event is a
 * slash command. A synthetic message after anything else (Claude's "No response requested.") answers none.
 */
export async function answeredCommand(store: ChatStore, id: string): Promise<string | undefined> {
  const said = (await store.events(id)).flatMap((line) => line.event !== undefined && line.event.kind !== "state" && line.event.kind !== "summary" ? [line.event] : []).at(-1);
  return said?.kind === "user" ? /^\/[^\s/]+/.exec(said.text.trim())?.[0] : undefined;
}

/** Codex's status is only painted in its TUI; answer the local info commands without a model turn. */
export async function handleLocalInfoCommand(daemon: ChatDaemon, chat: Chat, parts: readonly MessagePart[]): Promise<boolean> {
  if (chat.agent !== "codex") return false;
  if (parts.length !== 1 || parts[0]?.type !== "text") return false;
  const text = parts.filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text").map((part) => part.text).join("").trim();
  if (!/^\/(?:status|usage|context)$/.test(text)) return false;
  const data = await infoCommandData(chat, { ...daemon.environment, MEGABRAIN_STATE_DIR: daemon.stateDir });
  await daemon.publish(chat, commandOutputEvent(chat.agent, text, data));
  chat.state = "idle";
  await daemon.save(chat);
  void daemon.drain(chat.id);
  return true;
}

/** Claude usually prints its own status; this only supplies a panel when its completed turn was silent. */
export async function fallbackClaudeStatus(daemon: ChatDaemon, chat: Chat): Promise<void> {
  if (chat.agent !== "claude") return;
  const lines = await daemon.store.events(chat.id);
  const events = lines.flatMap((line) => line.event === undefined ? [] : [line.event]);
  const userIndex = events.map((item) => item.kind === "user").lastIndexOf(true);
  if (userIndex < 0 || /^\/status(?:\s|$)/.test(events[userIndex]?.text.trim() ?? "") === false) return;
  if (events.slice(userIndex + 1).some((item) => item.kind === "assistant" || item.kind === "command-output")) return;
  const data = await infoCommandData(chat, { ...daemon.environment, MEGABRAIN_STATE_DIR: daemon.stateDir });
  await daemon.publish(chat, commandOutputEvent(chat.agent, "/status", data));
}
