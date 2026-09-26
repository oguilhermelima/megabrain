import type { ProcessAdapter } from "../adapters/proc.js";
import { failed, ok, type Result } from "../core/result.js";
import { hasLivenessClassifier, waitForStableIdle } from "../core/liveness.js";
import { unavailable, type HostCommand, type HostProvider, type SendText } from "./types.js";

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;

function terminalTail(stdout: string): Result<string> {
  try {
    const root = record(JSON.parse(stdout));
    const result = record(root.result);
    const terminal = record(result.terminal);
    const tail = terminal.tail;
    if (typeof tail === "string") return ok(tail);
    if (Array.isArray(tail) && tail.every((line): line is string => typeof line === "string")) return ok(tail.join("\n"));
    return failed("orca terminal read did not include result.terminal.tail");
  } catch {
    return failed("orca terminal read returned invalid JSON");
  }
}

function sendText({ terminalId, text, interrupt }: SendText): Result<HostCommand> {
  return interrupt === true
    ? ok({ command: "orca", args: ["terminal", "send", "--terminal", terminalId, "--interrupt", "--json"] })
    : text === undefined
      ? unavailable("orca", "send terminal text or interrupt")
      : ok({ command: "orca", args: ["terminal", "send", "--terminal", terminalId, "--text", text, "--enter", "--json"] });
}

async function sendEnter(terminalId: string, process: ProcessAdapter): Promise<Result<void>> {
  const call = sendText({ workspaceId: null, terminalId, text: "" });
  if (call.kind !== "ok") return call.kind === "failed" ? failed(call.error, call.exitCode) : failed(call.reason);
  const result = await process.run(call.value.command, call.value.args);
  if (result.kind === "ok") return ok(undefined);
  return result.kind === "failed" ? failed(result.error, result.exitCode) : failed(result.reason);
}

export const orca: HostProvider = {
  id: "orca",
  terminalIdentityVariable: "ORCA_TERMINAL_HANDLE",
  create: ({ worktreePath, title, command }) => ok({
    command: "orca",
    args: ["terminal", "create", "--worktree", `path:${worktreePath}`, ...(title === null ? [] : ["--title", title]), ...(command === undefined ? [] : ["--command", command]), "--json"],
  }),
  terminalIdentity: (value) => {
    const root = record(value);
    const result = record(root.result);
    const resultTerminal = record(result.terminal);
    const terminal = record(root.terminal);
    return stringValue(resultTerminal.handle) ?? stringValue(terminal.handle) ?? stringValue(root.handle);
  },
  readiness: async ({ workspaceId, terminalId }, process: ProcessAdapter, timeoutMs, agentId) => {
    const timeoutError = `orca terminal ${terminalId} did not become ready within ${timeoutMs}ms`;
    if (!hasLivenessClassifier(agentId)) {
      const result = await process.run("orca", ["terminal", "wait", "--terminal", terminalId, "--for", "tui-idle", "--timeout-ms", String(timeoutMs)]);
      return result.kind === "ok" ? ok(undefined) : failed(timeoutError, result.exitCode);
    }
    return waitForStableIdle(agentId, timeoutMs, async () => {
      const call = orca.read({ workspaceId, terminalId });
      if (call.kind !== "ok") return call;
      const result = await process.run(call.value.command, [...call.value.args, "--screen"]);
      return result.kind === "ok" ? terminalTail(result.value.stdout) : failed(result.error, result.exitCode);
    }, timeoutError, () => sendEnter(terminalId, process));
  },
  list: () => ok({ command: "orca", args: ["terminal", "list", "--json"] }),
  read: ({ terminalId }) => ok({ command: "orca", args: ["terminal", "read", "--terminal", terminalId, "--json"] }),
  close: ({ terminalId }) => ok({ command: "orca", args: ["terminal", "close", "--terminal", terminalId, "--json"] }),
  send: sendText,
  workspaces: () => unavailable("orca", "list workspaces"),
};
