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
});
