import { recordAppTerminal, APP_SESSION_PREFIX } from "../../core/app-terminals.js";
import { chatKey, setConversationAlias, upsertConversation } from "../../core/conversations.js";
import { OWNED_TMUX_SERVER, ownedTmuxProcess } from "../../core/session-ownership.js";
import type { Chat } from "../store.js";
import { chatProtocolAdapters } from "../protocol.js";
import { readAgentSettings, startCommand } from "../../core/agent-settings.js";
import type { ChatDaemon } from "../daemon.js";

function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

/** Starts agy in a private app-owned terminal so chatd can follow its transcript and send safely. */
export async function startAgyTerminal(daemon: ChatDaemon, chat: Chat): Promise<void> {
  const session = `${APP_SESSION_PREFIX}${chat.id}`;
  const command = chatProtocolAdapters.agy.terminalCommand(chat, undefined, startCommand(await readAgentSettings(daemon.stateDir), "agy")).map(quote).join(" ");
  const tmux = ownedTmuxProcess(daemon.processes());
  const started = await tmux.run("tmux", ["new-session", "-d", "-s", session, "-c", chat.cwd, command]);
  if (started.kind !== "ok") {
    const exists = await tmux.run("tmux", ["has-session", "-t", `=${session}`]);
    if (exists.kind !== "ok") throw new Error(`could not start agy terminal: ${started.error}`);
  }
  const alias = `${OWNED_TMUX_SERVER}:${session}`;
  const key = daemon.entryOf(chat.id)?.[0] ?? chatKey(chat.id);
  recordAppTerminal(daemon.stateDir, session, { title: `agy · ${chat.title ?? "New chat"}`, command, cwd: chat.cwd, createdAt: new Date().toISOString() });
  if (daemon.entryOf(chat.id) === undefined) upsertConversation(daemon.stateDir, key, { owner: "app-chat", cwd: chat.cwd, aliases: { chatId: chat.id, tmux: alias, pid: null, dispatchId: null }, createdAt: chat.createdAt, hidden: false });
  setConversationAlias(daemon.stateDir, key, { tmux: alias });
  await daemon.syncTerminalPolling();
}
