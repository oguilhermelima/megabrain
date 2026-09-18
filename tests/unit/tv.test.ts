import { describe, expect, test } from "bun:test";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { executeTv } from "../../src/cli/commands/tv.js";
import { failed, ok } from "../../src/core/result.js";
import { parseTv, tvConnectOutput, tvUsage } from "../../src/core/tv.js";

function processStub(devices: string): ProcessAdapter & { readonly calls: readonly { readonly command: string; readonly args: readonly string[] }[] } {
  const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command !== "adb") return failed(`${command} unavailable`);
      if (args[0] === "version") return ok({ stdout: "Android Debug Bridge version\n", stderr: "", exitCode: 0 });
      if (args[0] === "connect") return ok({ stdout: `connected to ${args[1]}\n`, stderr: "", exitCode: 0 });
      if (args[0] === "devices") return ok({ stdout: devices, stderr: "", exitCode: 0 });
      if (args[0] === "disconnect") return ok({ stdout: args[1] === undefined ? "disconnected\n" : `disconnected ${args[1]}\n`, stderr: "", exitCode: 0 });
      return failed(`adb ${args[0] ?? ""} unavailable`);
    },
    async startDetached() { return failed("detached process unavailable"); },
    invocationCount: () => calls.length,
  };
}

test("parses tv connect and disconnect", () => {
  expect(parseTv(["connect", "10.0.0.2", "--port", "1234"])).toEqual({ kind: "ok", value: { operation: "connect", ip: "10.0.0.2", port: "1234" } });
  expect(parseTv(["disconnect"])).toEqual({ kind: "ok", value: { operation: "disconnect", port: "5555" } });
  expect(parseTv(["connect"]).kind).toBe("failed");
  expect(tvConnectOutput("x:5555", "device")).toEqual({ kind: "ok", value: "tv: connected (x:5555)\n" });
  expect(tvConnectOutput("x:5555", "").kind).toBe("failed");
  expect(tvUsage()).toContain("tv connect");
});

describe("tv command", () => {
  test("connects when adb reports a device", async () => {
    const process = processStub("List of devices attached\nx:5555 device\n");
    expect(await executeTv(["connect", "x"], process)).toEqual({ kind: "ok", value: "tv: connected (x:5555)\n" });
    expect(process.calls).toEqual([
      { command: "adb", args: ["version"] },
      { command: "adb", args: ["connect", "x:5555"] },
      { command: "adb", args: ["devices"] },
    ]);
  });

  test("refuses connect when adb does not report a ready device", async () => {
    const process = processStub("List of devices attached\nx:5555 offline\n");
    expect(await executeTv(["connect", "x"], process)).toEqual({ kind: "failed", error: "tv: not ready (x:5555: offline)", exitCode: 1 });
    expect(process.calls).toEqual([
      { command: "adb", args: ["version"] },
      { command: "adb", args: ["connect", "x:5555"] },
      { command: "adb", args: ["devices"] },
    ]);
  });

  test("disconnects all devices without an argument", async () => {
    const process = processStub("");
    expect(await executeTv(["disconnect"], process)).toEqual({ kind: "ok", value: "disconnected\n" });
    expect(process.calls).toEqual([
      { command: "adb", args: ["version"] },
      { command: "adb", args: ["disconnect"] },
    ]);
  });

  test("disconnects the requested device", async () => {
    const process = processStub("");
    expect(await executeTv(["disconnect", "x"], process)).toEqual({ kind: "ok", value: "disconnected x\n" });
    expect(process.calls).toEqual([
      { command: "adb", args: ["version"] },
      { command: "adb", args: ["disconnect", "x"] },
    ]);
  });
});
