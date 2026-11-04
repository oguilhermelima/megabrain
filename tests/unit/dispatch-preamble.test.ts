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
      expect(preamble).toContain("Ask only when the brief cannot settle a decision: megabrain ask, then poll megabrain check --timeout; never proceed on a default. Never ask permission to start.");
      expect(preamble).not.toContain("REQUIRED: Ask");
      expect(preamble).toContain("REQUIRED: Send megabrain done only when the work is finished or blocked, with outcome and evidence. Never send done for unfinished work.");
      expect(preamble).toContain("Start ask and done with one plain sentence a nontechnical person understands; no filenames, commands or counts.");
      expect(preamble).toContain("CRITICAL: Never close your own dispatch.");
      expect(Buffer.byteLength(preamble)).toBeLessThanOrEqual(600);
    }
  });
});
