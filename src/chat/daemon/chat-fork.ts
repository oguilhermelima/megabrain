import { randomUUID } from "node:crypto";
import type { ChatDaemon } from "../daemon.js";
import type { Chat } from "../store.js";
import { ensureCodexChild, isBusy, mutate, seedContext, selectedTurn } from "./chat-turns.js";

export async function fork(daemon: ChatDaemon, id: string, eventId: string): Promise<Chat> {
  return await mutate(daemon, id, async () => {
    const source = await daemon.requireChat(id);
    if (isBusy(source)) throw Object.assign(new Error("chat is busy"), { code: "chat-busy" });
    const lines = await daemon.store.events(id);
    const turn = selectedTurn(lines, eventId);
    if (!turn) throw new Error(`event is not in a person turn: ${eventId}`);
    const history = lines.slice(0, turn.end);
    let agentSessionId: string | null = null;
    let context = "";

    if (source.agent === "codex") {
      if (!source.agentSessionId || !turn.turnId) throw new Error("Codex turn id is unavailable for this event");
      const child = await ensureCodexChild(daemon, source);
      const response = await daemon.codexRequest(child, "thread/fork", {
        threadId: source.agentSessionId,
        lastTurnId: turn.turnId,
        cwd: source.cwd,
        ...(source.approvals === true ? { approvalPolicy: "on-request", sandbox: "workspace-write" } : { approvalPolicy: "never", sandbox: "danger-full-access" }),
      });
      const thread = object(object(response).thread);
      if (typeof thread.id !== "string" || thread.id === "") throw new Error("Codex did not return a forked thread id");
      agentSessionId = thread.id;
    } else {
      // The installed Claude CLI can fork a whole resumed session, but it has no historical resume point.
      // Start a separate session with the visible transcript as context so the source remains untouched.
      context = seedContext(history);
    }

    const createdAt = new Date().toISOString();
    const chat: Chat = {
      ...source,
      id: randomUUID(),
      title: `${source.title ?? "Chat"} (branch)`,
      summary: null,
      seedContext: context || undefined,
      state: "idle",
      mode: "chat",
      owner: "none",
      agentSessionId,
      createdAt,
      lastActivityAt: createdAt,
      error: null,
      terminalSince: undefined,
      terminalLogCursor: undefined,
    };
    await daemon.save(chat);
    await daemon.store.replaceEvents(chat.id, history);
    return chat;
  });
}

function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
