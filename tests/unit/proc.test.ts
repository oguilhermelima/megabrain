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

  test("does not signal an exited command while a descendant holds its output open", async () => {
    const started = Date.now();
    const result = await createProcessAdapter().run("sh", ["-c", "(sleep 0.25) & exit 0"], { timeoutMs: 25 });
    expect(result).toEqual({ kind: "ok", value: { stdout: "", stderr: "", exitCode: 0 } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  test("caps captured stdout and stderr independently", async () => {
    const result = await createProcessAdapter().run("sh", ["-c", "printf 123456; printf abcdef >&2"], { maxOutputBytes: 4 });
    expect(result).toEqual({ kind: "ok", value: { stdout: "1234", stderr: "abcd", exitCode: 0 } });
  });

  test("uses the default deadline when no timeout is supplied", async () => {
    const result = await createProcessAdapter({ defaultTimeoutMs: 25 }).run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
    expect(result).toEqual({ kind: "failed", error: `${process.execPath} timed out`, exitCode: 1 });
  });

  test("kills a run child when its owner is killed", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "mb-proc-parent-"));
    const marker = join(directory, "child.pid");
    const script = `import { createProcessAdapter } from ${JSON.stringify(new URL("../../src/adapters/proc.js", import.meta.url).href)}; createProcessAdapter().run("sh", ["-c", "echo $$ > ${marker}; exec sleep 30"]); setInterval(() => {}, 1000);`;
    const owner = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" });
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try { await readFile(marker, "utf8"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
      }
      const childPid = Number((await readFile(marker, "utf8")).trim());
      owner.kill("SIGKILL");
      await owner.exited;
      const goneBy = Date.now() + 3000;
      let alive = true;
      while (Date.now() < goneBy) {
        alive = (await createProcessAdapter().run("kill", ["-0", String(childPid)])).kind === "ok";
        if (!alive) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (alive) await createProcessAdapter().run("kill", ["-KILL", String(childPid)]);
      expect(alive).toBe(false);
    } finally { owner.kill("SIGKILL"); await owner.exited; await rm(directory, { recursive: true, force: true }); }
  }, 10000);
});
