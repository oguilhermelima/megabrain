import { ok, unknown, type Result } from "../core/result.js";
import { unavailable, type HostProvider } from "./types.js";

const workspace = (workspaceId: string | null): Result<string> => workspaceId === null
  ? unknown("capability-unavailable: superset cannot address a terminal without a workspace")
  : ok(workspaceId);
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;

export const superset: HostProvider = {
  id: "superset",
  create: ({ workspaceId, command }) => {
    const target = workspace(workspaceId);
    return target.kind === "ok" ? ok({ command: "superset", args: ["terminals", "create", "--workspace", target.value, "--command", command, "--json"] }) : target;
  },
  terminalIdentity: (value) => {
    const root = record(value);
    const result = record(root.result);
    const terminal = record(root.terminal);
    const resultTerminal = record(result.terminal);
    return stringValue(root.terminalId)
      ?? stringValue(root.sessionId)
      ?? stringValue(result.terminalId)
      ?? stringValue(result.sessionId)
      ?? stringValue(terminal.sessionId)
      ?? stringValue(resultTerminal.sessionId)
      ?? stringValue(terminal.id)
      ?? stringValue(resultTerminal.id)
      ?? stringValue(root.id);
  },
  list: ({ workspaceId }) => {
    const target = workspace(workspaceId);
    return target.kind === "ok" ? ok({ command: "superset", args: ["terminals", "list", "--workspace", target.value, "--json"] }) : target;
  },
  read: ({ workspaceId, terminalId }) => {
    const target = workspace(workspaceId);
    return target.kind === "ok" ? ok({ command: "superset", args: ["terminals", "read", "--workspace", target.value, "--terminal", terminalId, "--json"] }) : target;
  },
  close: ({ workspaceId, terminalId }) => {
    const target = workspace(workspaceId);
    return target.kind === "ok" ? ok({ command: "superset", args: ["terminals", "close", "--workspace", target.value, "--terminal", terminalId, "--json"] }) : target;
  },
  send: ({ workspaceId, terminalId, text, interrupt }) => {
    if (interrupt === true) return unavailable("superset", "interrupt a terminal");
    const target = workspace(workspaceId);
    return target.kind !== "ok"
      ? target
      : text === undefined
        ? unavailable("superset", "send terminal text")
        : ok({ command: "superset", args: ["terminals", "send", "--workspace", target.value, "--terminal", terminalId, "--text", text, "--json"] });
  },
  workspaces: () => ok({ command: "superset", args: ["workspaces", "list", "--local", "--json"] }),
};
