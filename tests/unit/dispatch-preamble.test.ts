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
      expect(preamble).toContain("Ask only when a decision is genuinely ambiguous and you cannot settle it from the brief; then poll megabrain check --timeout until answered and never proceed on a default. Do not ask for permission to start or to follow the brief.");
      expect(preamble).not.toContain("REQUIRED: Ask");
      expect(preamble).toContain("REQUIRED: Send megabrain done only when the brief's work is finished or blocked; include outcome and evidence. Never send done to report work you have not done.");
      expect(preamble).toContain("CRITICAL: Never close your own dispatch.");
      expect(Buffer.byteLength(preamble)).toBeLessThanOrEqual(600);
    }
  });
});
