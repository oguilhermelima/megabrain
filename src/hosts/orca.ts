import { ok } from "../core/result.js";
import { unavailable, type HostProvider } from "./types.js";

export const orca: HostProvider = {
  id: "orca",
  create: ({ worktreePath, title, command }) => ok({
    command: "orca",
    args: ["terminal", "create", "--worktree", `path:${worktreePath}`, ...(title === null ? [] : ["--title", title]), "--command", command, "--json"],
  }),
  list: () => ok({ command: "orca", args: ["terminal", "list", "--json"] }),
  read: ({ terminalId }) => ok({ command: "orca", args: ["terminal", "read", "--terminal", terminalId, "--json"] }),
  close: ({ terminalId }) => ok({ command: "orca", args: ["terminal", "close", "--terminal", terminalId, "--json"] }),
  send: ({ terminalId, text, interrupt }) => interrupt === true
    ? ok({ command: "orca", args: ["terminal", "send", "--terminal", terminalId, "--interrupt", "--json"] })
    : text === undefined
      ? unavailable("orca", "send terminal text or interrupt")
      : ok({ command: "orca", args: ["terminal", "send", "--terminal", terminalId, "--text", text, "--enter", "--json"] }),
  workspaces: () => unavailable("orca", "list workspaces"),
};
