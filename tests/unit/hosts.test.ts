import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { hostCloseCommand } from "../../src/cli/commands/orchestrate-close.js";
import { hostCommand } from "../../src/cli/commands/orchestrate-terminal.js";
import { getHost, registerHost, unregisterHost, type HostProvider } from "../../src/hosts/index.js";
import { failed, ok } from "../../src/core/result.js";
import { classifyLiveness } from "../../src/core/liveness.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;

function processFor(outputs: readonly string[]): ProcessAdapter & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  let outputIndex = 0;
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      return ok<ProcessOutput>({ stdout: outputs[outputIndex++] ?? "", stderr: "", exitCode: 0 });
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

const fourthHost: HostProvider = {
  id: "fourth",
  create: () => ok({ command: "fourth", args: ["terminals", "create"] }),
  terminalIdentity: () => undefined,
  readiness: async () => ok(undefined),
  list: ({ workspaceId }) => ok({ command: "fourth", args: ["terminals", "list", "--workspace", workspaceId ?? "", "--json"] }),
  read: ({ workspaceId, terminalId }) => ok({ command: "fourth", args: ["terminals", "read", "--workspace", workspaceId ?? "", "--terminal", terminalId, "--json"] }),
  close: ({ workspaceId, terminalId }) => ok({ command: "fourth", args: ["terminals", "close", "--workspace", workspaceId ?? "", "--terminal", terminalId, "--json"] }),
  send: ({ workspaceId, terminalId, text }) => ok({ command: "fourth", args: ["terminals", "send", "--workspace", workspaceId ?? "", "--terminal", terminalId, "--text", text ?? "", "--json"] }),
  workspaces: () => ok({ command: "fourth", args: ["workspaces", "list", "--json"] }),
};

describe("host providers", () => {
  test("orca readiness waits for a stable idle composer from the rendered screen", async () => {
    const orca = getHost("orca");
    const process = processFor([
      JSON.stringify({ result: { terminal: { tail: ["Working (2s)", "esc to interrupt"] } } }),
      ...Array.from({ length: 20 }, () => JSON.stringify({ result: { terminal: { tail: ["› Ask Codex to do anything"] } } })),
    ]);
    const result = await orca?.readiness({ workspaceId: null, terminalId: "terminal-child" }, process, 3210, "codex");

    expect(result).toEqual({ kind: "ok", value: undefined });
    expect(process.calls.length).toBeGreaterThan(10);
    expect(process.calls.every((call) => call.args[1] === "read" && call.args.includes("--screen"))).toBe(true);
    expect(process.calls[0]).toEqual({ command: "orca", args: ["terminal", "read", "--terminal", "terminal-child", "--json", "--screen"] });
  });

  test("orca readiness classifies the captured Codex screen as idle", async () => {
    const captured = await readFile(new URL("../fixtures/orca-terminal-screen-codex-idle.json", import.meta.url), "utf8");
    const response = JSON.parse(captured) as { result: { terminal: { tail: string[] } } };
    const process = processFor(Array.from({ length: 20 }, () => captured));
    const result = await getHost("orca")?.readiness({ workspaceId: null, terminalId: "terminal-child" }, process, 3210, "codex");

    expect(classifyLiveness("codex", response.result.terminal.tail.join("\n")).status).toBe("idle");
    expect(result).toEqual({ kind: "ok", value: undefined });
    expect(process.calls.length).toBeGreaterThan(10);
    expect(process.calls.every((call) => call.args.includes("--screen"))).toBe(true);
  });

  test("orca readiness continues to accept a string terminal tail", async () => {
    const process = processFor(Array.from({ length: 20 }, () => JSON.stringify({ result: { terminal: { tail: "› Ask Codex to do anything" } } })));
    const result = await getHost("orca")?.readiness({ workspaceId: null, terminalId: "terminal-child" }, process, 3210, "codex");

    expect(result).toEqual({ kind: "ok", value: undefined });
  });

  test("orca readiness falls back to native wait when the agent has no liveness classifier", async () => {
    const orca = getHost("orca");
    const process = processFor([]);
    const result = await orca?.readiness({ workspaceId: null, terminalId: "terminal-child" }, process, 3210, "unknown-agent");

    expect(result).toEqual({ kind: "ok", value: undefined });
    expect(process.calls).toEqual([{ command: "orca", args: ["terminal", "wait", "--terminal", "terminal-child", "--for", "tui-idle", "--timeout-ms", "3210"] }]);
  });

  test("orca readiness times out when the screen never shows idle", async () => {
    const orca = getHost("orca");
    const process = processFor([JSON.stringify({ result: { terminal: { tail: ["Working (2s)", "esc to interrupt"] } } })]);
    const result = await orca?.readiness({ workspaceId: null, terminalId: "terminal-child" }, process, 0, "codex");

    expect(result).toEqual({ kind: "failed", error: "orca terminal terminal-child did not become ready within 0ms", exitCode: 1 });
    expect(process.calls).toEqual([{ command: "orca", args: ["terminal", "read", "--terminal", "terminal-child", "--json", "--screen"] }]);
  });

  test("superset readiness polls until two consecutive non-empty reads are identical", async () => {
    const superset = getHost("superset");
    const process = processFor([JSON.stringify({ text: "starting" }), JSON.stringify({ text: "ready" }), JSON.stringify({ text: "ready" })]);
    const result = await superset?.readiness({ workspaceId: "workspace", terminalId: "terminal-child" }, process, 250);

    expect(result).toEqual({ kind: "ok", value: undefined });
    expect(process.calls).toHaveLength(3);
  });

  test("superset readiness does not report ready on a single non-empty read", async () => {
    const superset = getHost("superset");
    const process = processFor([JSON.stringify({ text: "ready" })]);
    const result = await superset?.readiness({ workspaceId: "workspace", terminalId: "terminal-child" }, process, 0);

    expect(result).toEqual({ kind: "failed", error: "superset terminal terminal-child did not become ready within 0ms", exitCode: 1 });
    expect(process.calls).toHaveLength(1);
  });

  test("orca extracts the child handle instead of the request id", () => {
    const orca = getHost("orca");
    expect(orca?.terminalIdentity({ id: "request-id", result: { terminal: { handle: "term_real" } } })).toBe("term_real");
  });

  test("registered hosts are used by terminal listing and close consumers", () => {
    registerHost(fourthHost);
    try {
      expect(hostCommand({ childHost: "fourth", workspaceId: "workspace" })).toEqual({
        command: "fourth",
        args: ["terminals", "list", "--workspace", "workspace", "--json"],
      });
      expect(hostCloseCommand({ childHost: "fourth", workspaceId: "workspace", terminalId: "terminal" })).toEqual({
        command: "fourth",
        args: ["terminals", "close", "--workspace", "workspace", "--terminal", "terminal", "--json"],
      });
    } finally {
      unregisterHost(fourthHost.id);
    }
  });

  test("orca and superset preserve literal terminal commands", () => {
    const orca = getHost("orca");
    const superset = getHost("superset");
    expect(orca?.create({ workspaceId: null, worktreePath: "/work/tree", title: "DEV tree", command: "bun dev" })).toEqual({ kind: "ok", value: { command: "orca", args: ["terminal", "create", "--worktree", "path:/work/tree", "--title", "DEV tree", "--command", "bun dev", "--json"] } });
    expect(orca?.list({ workspaceId: null })).toEqual({ kind: "ok", value: { command: "orca", args: ["terminal", "list", "--json"] } });
    expect(orca?.read({ workspaceId: null, terminalId: "terminal" })).toEqual({ kind: "ok", value: { command: "orca", args: ["terminal", "read", "--terminal", "terminal", "--json"] } });
    expect(orca?.close({ workspaceId: null, terminalId: "terminal" })).toEqual({ kind: "ok", value: { command: "orca", args: ["terminal", "close", "--terminal", "terminal", "--json"] } });
    expect(orca?.send({ workspaceId: null, terminalId: "terminal", text: "hello" })).toEqual({ kind: "ok", value: { command: "orca", args: ["terminal", "send", "--terminal", "terminal", "--text", "hello", "--enter", "--json"] } });
    expect(orca?.send({ workspaceId: null, terminalId: "terminal", interrupt: true })).toEqual({ kind: "ok", value: { command: "orca", args: ["terminal", "send", "--terminal", "terminal", "--interrupt", "--json"] } });
    expect(superset?.create({ workspaceId: "workspace", worktreePath: "/work/tree", title: "DEV tree", command: "bun dev" })).toEqual({ kind: "ok", value: { command: "superset", args: ["terminals", "create", "--workspace", "workspace", "--command", "bun dev", "--json"] } });
    expect(superset?.list({ workspaceId: "workspace" })).toEqual({ kind: "ok", value: { command: "superset", args: ["terminals", "list", "--workspace", "workspace", "--json"] } });
    expect(superset?.read({ workspaceId: "workspace", terminalId: "terminal" })).toEqual({ kind: "ok", value: { command: "superset", args: ["terminals", "read", "--workspace", "workspace", "--terminal", "terminal", "--json"] } });
    expect(superset?.close({ workspaceId: "workspace", terminalId: "terminal" })).toEqual({ kind: "ok", value: { command: "superset", args: ["terminals", "close", "--workspace", "workspace", "--terminal", "terminal", "--json"] } });
    expect(superset?.send({ workspaceId: "workspace", terminalId: "terminal", text: "hello" })).toEqual({ kind: "ok", value: { command: "superset", args: ["terminals", "send", "--workspace", "workspace", "--terminal", "terminal", "--text", "hello", "--json"] } });
  });

  test("orca and superset omit the terminal command when none is provided", () => {
    const orca = getHost("orca");
    const superset = getHost("superset");
    expect(orca?.create({ workspaceId: null, worktreePath: "/work/tree", title: "codex /work/tree", command: undefined as never })).toEqual({ kind: "ok", value: { command: "orca", args: ["terminal", "create", "--worktree", "path:/work/tree", "--title", "codex /work/tree", "--json"] } });
    expect(superset?.create({ workspaceId: "workspace", worktreePath: "/work/tree", title: "codex /work/tree", command: undefined as never })).toEqual({ kind: "ok", value: { command: "superset", args: ["terminals", "create", "--workspace", "workspace", "--json"] } });
  });

  test("unsupported capabilities are unknown and unknown hosts keep empty terminal commands", () => {
    const orca = getHost("orca");
    expect(orca?.workspaces()).toEqual({ kind: "unknown", reason: "capability-unavailable: orca cannot list workspaces", error: "capability-unavailable: orca cannot list workspaces", exitCode: 1 });
    expect(hostCommand({ childHost: "not-registered", workspaceId: "workspace" })).toEqual({ command: "", args: [] });
  });
});
