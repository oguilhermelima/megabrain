import { describe, expect, test } from "bun:test";
import { createProcessAdapter } from "../../src/adapters/proc.js";

describe("createProcessAdapter", () => {
  test("keeps stdout on a failed run", async () => {
    const process = createProcessAdapter();
    const result = await process.run("sh", ["-c", "echo '{\"ok\":false}'; echo boom >&2; exit 1"]);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.stdout).toBe("{\"ok\":false}\n");
    expect(result.error).toBe("boom");
  });

  test("still reports an ok run without a stdout field on Failed", async () => {
    const process = createProcessAdapter();
    const result = await process.run("sh", ["-c", "echo hi"]);
    expect(result.kind).toBe("ok");
  });

  test("normalizes a missing executable across runtimes", async () => {
    const process = createProcessAdapter();
    const result = await process.run("megabrain-test-command-that-is-not-installed", []);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.error).toBe("megabrain-test-command-that-is-not-installed: executable not found");
  });

  test("kills a command that exceeds its timeout", async () => {
    const started = Date.now();
    const result = await createProcessAdapter().run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 25 });
    expect(result).toEqual({ kind: "failed", error: `${process.execPath} timed out`, exitCode: 1 });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
