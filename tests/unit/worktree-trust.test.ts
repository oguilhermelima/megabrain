import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { preflightWorktreeTrust } from "../../src/agents/worktree-trust.js";

async function fixture() {
  const home = await mkdtemp(`${tmpdir()}/megabrain-trust-config-`);
  const worktreeDirectory = `${home}/repo`;
  await mkdir(worktreeDirectory);
  const worktree = await realpath(worktreeDirectory);
  const config = `${home}/.codex/config.toml`;
  await mkdir(`${home}/.codex`);
  return { home, worktree, config, environment: { HOME: home } };
}

describe("Codex worktree trust config concurrency", () => {
  test("retries after a concurrent config change and preserves the other writer", async () => {
    const state = await fixture();
    try {
      await writeFile(state.config, 'model = "gpt-6-luna"\n');
      let changes = 0;
      const result = await preflightWorktreeTrust("codex", state.worktree, state.environment, {
        async beforeConfigCommit(path) {
          if (changes++ === 0) await writeFile(path, 'model = "gpt-6-luna"\nwriter_note = "preserve me"\n');
        },
      });
      expect(result.kind).toBe("ok");
      expect(changes).toBe(2);
      const config = await readFile(state.config, "utf8");
      expect(config).toContain('writer_note = "preserve me"');
      expect(config).toContain(`[projects."${state.worktree}"]`);
      expect(config).toContain('trust_level = "trusted"');
    } finally { await rm(state.home, { recursive: true, force: true }); }
  });

  test("fails after repeated concurrent changes without overwriting the last writer", async () => {
    const state = await fixture();
    try {
      await writeFile(state.config, 'model = "gpt-6-luna"\n');
      let changes = 0;
      const result = await preflightWorktreeTrust("codex", state.worktree, state.environment, {
        async beforeConfigCommit(path) {
          changes += 1;
          await writeFile(path, `writer_revision = ${changes}\n`);
        },
      });
      expect(result.kind).toBe("failed");
      expect(changes).toBe(3);
      expect(await readFile(state.config, "utf8")).toBe("writer_revision = 3\n");
    } finally { await rm(state.home, { recursive: true, force: true }); }
  });
});
