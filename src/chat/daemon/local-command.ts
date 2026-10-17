import type { ChatStore } from "../store.js";

/**
 * The slash command a local command's output answers: the user event right before it, when that event is a
 * slash command. A synthetic message after anything else (Claude's "No response requested.") answers none.
 */
export async function answeredCommand(store: ChatStore, id: string): Promise<string | undefined> {
  const said = (await store.events(id)).flatMap((line) => line.event !== undefined && line.event.kind !== "state" && line.event.kind !== "summary" ? [line.event] : []).at(-1);
  return said?.kind === "user" ? /^\/[^\s/]+/.exec(said.text.trim())?.[0] : undefined;
}
