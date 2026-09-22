import { describe, expect, test } from "bun:test";
import { hostCloseCommand } from "../../src/cli/commands/orchestrate-close.js";
import { hostCommand } from "../../src/cli/commands/orchestrate-terminal.js";
import { getHost, registerHost, unregisterHost, type HostProvider } from "../../src/hosts/index.js";
import { ok } from "../../src/core/result.js";

const fourthHost: HostProvider = {
  id: "fourth",
  create: () => ok({ command: "fourth", args: ["terminals", "create"] }),
  terminalIdentity: () => undefined,
  list: ({ workspaceId }) => ok({ command: "fourth", args: ["terminals", "list", "--workspace", workspaceId ?? "", "--json"] }),
  read: ({ workspaceId, terminalId }) => ok({ command: "fourth", args: ["terminals", "read", "--workspace", workspaceId ?? "", "--terminal", terminalId, "--json"] }),
  close: ({ workspaceId, terminalId }) => ok({ command: "fourth", args: ["terminals", "close", "--workspace", workspaceId ?? "", "--terminal", terminalId, "--json"] }),
  send: ({ workspaceId, terminalId, text }) => ok({ command: "fourth", args: ["terminals", "send", "--workspace", workspaceId ?? "", "--terminal", terminalId, "--text", text ?? "", "--json"] }),
  workspaces: () => ok({ command: "fourth", args: ["workspaces", "list", "--json"] }),
};

describe("host providers", () => {
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

  test("unsupported capabilities are unknown and unknown hosts keep empty terminal commands", () => {
    const orca = getHost("orca");
    expect(orca?.workspaces()).toEqual({ kind: "unknown", reason: "capability-unavailable: orca cannot list workspaces", error: "capability-unavailable: orca cannot list workspaces", exitCode: 1 });
    expect(hostCommand({ childHost: "not-registered", workspaceId: "workspace" })).toEqual({ command: "", args: [] });
  });
});
