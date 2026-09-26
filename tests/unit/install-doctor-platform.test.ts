import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { executeInstall } from "../../src/cli/commands/install-doctor.js";

function processFor(platform: string, available: readonly string[]): ProcessAdapter & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  const commands = new Set(available);
  return {
    calls,
    async run(command, args): Promise<Result<ProcessOutput>> {
      const invocation = [command, ...args].join(" ");
      calls.push(invocation);
      if (command === "which") {
        const executable = args[0] ?? "";
        return commands.has(executable)
          ? ok({ stdout: `/usr/bin/${executable}`, stderr: "", exitCode: 0 })
          : failed(`${executable}: not found`);
      }
      if (command === "uname") return ok({ stdout: `${platform}\n`, stderr: "", exitCode: 0 });
      if (command === "brew") return failed("brew should not be called in this scenario");
      return failed(`${invocation} unavailable`);
    },
    async startDetached() { return failed("detached process unavailable"); },
    invocationCount: () => calls.length,
  };
}

describe("install platform-specific package manager guidance", () => {
  test("Linux adb guidance stays generic even when brew is on PATH", async () => {
    const process = processFor("Linux", ["brew"]);
    const result = await executeInstall(["tv-adb"], { HOME: mkdtempSync("/tmp/megabrain-install-adb-linux-") }, process);

    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toContain("OS package manager");
    expect(result.kind === "failed" ? result.error : "").not.toContain("brew install");
    expect(process.calls).not.toContain("brew install android-platform-tools");
  });

  test("Darwin adb guidance keeps the Homebrew command", async () => {
    const result = await executeInstall(["tv-adb"], { HOME: mkdtempSync("/tmp/megabrain-install-adb-darwin-") }, processFor("Darwin", ["brew"]));

    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toContain("brew install android-platform-tools");
  });

  test("Linux tmux install suggests a package manager without invoking brew", async () => {
    const process = processFor("Linux", ["brew"]);
    const result = await executeInstall(["tmux-runtime"], { HOME: mkdtempSync("/tmp/megabrain-install-tmux-linux-") }, process);

    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toContain("package manager");
    expect(process.calls.some((call) => call.startsWith("brew "))).toBe(false);
  });

  test("Darwin tmux install runs Homebrew", async () => {
    const calls: string[] = [];
    const base = processFor("Darwin", ["brew"]);
    const process: ProcessAdapter = {
      ...base,
      async run(command, args, options) {
        calls.push([command, ...args].join(" "));
        if (command === "brew") return ok({ stdout: "", stderr: "", exitCode: 0 });
        if (command === "which" && args[0] === "tmux") return failed("tmux missing");
        return base.run(command, args, options);
      },
    };
    const result = await executeInstall(["tmux-runtime"], { HOME: mkdtempSync("/tmp/megabrain-install-tmux-darwin-") }, process);

    expect(calls).toContain("brew install tmux");
    expect(result.kind).toBe("failed");
  });
});
