import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { failed } from "../../src/core/result.js";
import { route } from "../../src/cli/router.js";

const dependencies = {
  environment: {},
  processAdapter: {
    run: async () => failed("unexpected process invocation"),
    startDetached: async () => failed("unexpected process invocation"),
    invocationCount: () => 0,
  },
};

const rootUsage = await readFile(new URL("../fixtures/root-usage.txt", import.meta.url), "utf8");

describe("CLI root help and version", () => {
  test.each([["version"], ["-V"], ["--version"]] as const)("prints the version for %s", async (argument) => {
    expect(await route([argument], dependencies)).toEqual({
      kind: "ok",
      value: "megabrain 0.2.4\n",
    });
  });

  test.each([[], ["help"], ["-h"], ["--help"]] as const)("prints root usage for %j", async (args) => {
    expect(await route(args, dependencies)).toEqual({ kind: "ok", value: rootUsage });
  });

  test("returns the wrapper's unknown-command error code", async () => {
    expect(await route(["not-a-command"], dependencies)).toEqual({
      kind: "failed",
      error: "unknown command: not-a-command",
      exitCode: 2,
    });
  });
});
