import type { ChatDaemon } from "../daemon.js";
import { randomUUID } from "node:crypto";
import { validateParts } from "../daemon.js";
import type { Chat } from "../store.js";
import { ensureCodexChild, isBusy, mutate, seedContext } from "./chat-turns.js";

export async function editLast(daemon: ChatDaemon, id: string, rawParts: unknown): Promise<Chat> {
  return await mutate(daemon, id, async () => {
    const chat = await daemon.requireChat(id);
    if (isBusy(chat)) throw Object.assign(new Error("chat is busy"), { code: "chat-busy" });
    const parts = await daemon.normalizeParts(chat.cwd, validateParts(rawParts));
    const lines = await daemon.store.events(id);
    let userIndex = lines.length - 1;
    while (userIndex >= 0 && lines[userIndex]?.event?.kind !== "user") userIndex -= 1;
    if (userIndex < 0) throw Object.assign(new Error("there is no person message to edit"), { code: "nothing-to-edit" });
    const turnId = lines[userIndex]?.event?.turnId;
    const fromEventId = lines[userIndex]?.event?.id;
    const prefix = lines.slice(0, userIndex);

    if (chat.agent === "codex") {
      if (!chat.agentSessionId || !turnId) throw new Error("Codex turn id is unavailable for the last message");
      const child = await ensureCodexChild(daemon, chat);
      await daemon.codexRequest(child, "thread/revert", { threadId: chat.agentSessionId, beforeTurnId: turnId });
    } else {
      // Claude's CLI cannot rewind its persisted session to a message. Keep prior visible turns as context
      // in a new session, then send the replacement there; the original Claude session is never rewritten.
      chat.seedContext = seedContext(prefix);
      chat.agentSessionId = null;
      const child = daemon.children.get(id);
      if (child) {
        daemon.children.delete(id);
        await new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.kill("SIGTERM");
        });
      }
    }

    await daemon.store.replaceEvents(id, prefix);
    if (fromEventId !== undefined) await daemon.publish(chat, { id: randomUUID(), at: new Date().toISOString(), kind: "rewind", text: "", fromEventId });
    await daemon.save(chat);
    await daemon.deliver(chat, parts);
    return await daemon.requireChat(id);
  });
}
