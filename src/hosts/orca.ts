import type { ProcessAdapter } from "../adapters/proc.js";
import { failed, ok } from "../core/result.js";
import { unavailable, type HostProvider } from "./types.js";

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;

export const orca: HostProvider = {
  id: "orca",
  create: ({ worktreePath, title, command }) => ok({
    command: "orca",
    args: ["terminal", "create", "--worktree", `path:${worktreePath}`, ...(title === null ? [] : ["--title", title]), "--command", command, "--json"],
  }),
  terminalIdentity: (value) => {
    const root = record(value);
    const result = record(root.result);
    const resultTerminal = record(result.terminal);
    const terminal = record(root.terminal);
    return stringValue(resultTerminal.handle) ?? stringValue(terminal.handle) ?? stringValue(root.handle);
  },
  readiness: async ({ terminalId }, process: ProcessAdapter, timeoutMs) => {
    const result = await process.run("orca", ["terminal", "wait", "--terminal", terminalId, "--for", "tui-idle", "--timeout-ms", String(timeoutMs)]);
    return result.kind === "ok" ? ok(undefined) : failed(`orca terminal ${terminalId} did not become ready within ${timeoutMs}ms`, result.exitCode);
  },
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
