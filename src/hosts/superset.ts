import type { ProcessAdapter } from "../adapters/proc.js";
import { failed, ok, unknown, type Result } from "../core/result.js";
import { unavailable, type HostProvider } from "./types.js";

const workspace = (workspaceId: string | null): Result<string> => workspaceId === null
  ? unknown("capability-unavailable: superset cannot address a terminal without a workspace")
  : ok(workspaceId);
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;

function renderedOutput(stdout: string): string {
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value === "string") return value;
    if (typeof value !== "object" || value === null) return String(value);
    const root = record(value);
    const result = record(root.result);
    const rendered = root.text ?? root.output ?? root.content ?? result.text ?? result.output;
    return typeof rendered === "string" ? rendered : JSON.stringify(rendered ?? value);
  } catch {
    return "";
  }
}

export const superset: HostProvider = {
  id: "superset",
  terminalIdentityVariable: "SUPERSET_TERMINAL_ID",
  create: ({ workspaceId, command }) => {
    const target = workspace(workspaceId);
    return target.kind === "ok" ? ok({ command: "superset", args: ["terminals", "create", "--workspace", target.value, ...(command === undefined ? [] : ["--command", command]), "--json"] }) : target;
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
  readiness: async ({ workspaceId, terminalId }, process: ProcessAdapter, timeoutMs) => {
    const target = workspace(workspaceId);
    if (target.kind !== "ok") return target.kind === "unknown" ? unknown(target.reason) : failed(target.error, target.exitCode);
    const attempts = Math.max(1, Math.ceil(Math.max(0, timeoutMs) / 100));
    let previous = "";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await process.run("superset", ["terminals", "read", "--workspace", target.value, "--terminal", terminalId, "--json"]);
      const rendered = response.kind === "ok" ? renderedOutput(response.value.stdout) : "";
      if (rendered.replace(/\s/g, "").length > 0 && rendered === previous) return ok(undefined);
      previous = rendered;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return failed(`superset terminal ${terminalId} did not become ready within ${timeoutMs}ms`);
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
