import { describe, expect, test } from "bun:test";
import { finalPrompt, type SpawnOptions } from "../../src/cli/commands/orchestrate-spawn-options.js";

const options = (agent: string): SpawnOptions => ({
  worktree: "/work/tree", agent, model: null, effort: null, prompt: "", label: null,
  tmux: null, browser: false, agentArgs: [], json: false, admission: "wait",
});

describe("dispatch worker preamble", () => {
  test("keeps the current worker contract under 440 UTF-8 bytes for every agent", () => {
    for (const agent of ["claude", "codex", "grok", "agy"]) {
      const preamble = finalPrompt(options(agent), "dispatch-preamble-test").split("\n\nDispatch identity:")[0];
      expect(preamble).toContain("REQUIRED: Run megabrain received first.");
      expect(preamble).toContain("REQUIRED: Ask with megabrain ask; poll megabrain check --timeout until answered. Never proceed on a default.");
      expect(preamble).toContain("REQUIRED: Finish with megabrain done, including outcome and evidence.");
      expect(preamble).toContain("CRITICAL: Never close your own dispatch.");
      expect(Buffer.byteLength(preamble)).toBeLessThanOrEqual(440);
    }
  });
});
