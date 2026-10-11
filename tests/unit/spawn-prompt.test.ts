import { describe, expect, test } from "bun:test";
import { appendReceived, cleanupRun, readMeta, runComposerSpawn } from "./spawn-harness.js";

const longBrief = Array.from({ length: 60 }, (_, index) => `line ${index} ${"abcdefghij ".repeat(7)}`).join("\n");

const agents = ["codex", "claude"] as const;

// The launch line also ends in Enter, so only what follows the first paste is the prompt's.
const afterFirstPaste = (events: readonly string[]): readonly string[] => events.slice(events.findIndex((event) => event === "paste" || event === "send-keys"));

describe("spawn first prompt", () => {
  test.each(agents)("%s: pastes the whole prompt as one paste and submits it once the composer shows it", async (agent) => {
    const run = await runComposerSpawn(`dispatch-paste-${agent}`, { agent, onSubmit: (_prompt, root) => appendReceived(root, `dispatch-paste-${agent}`) }, { MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "2" });
    try {
      expect(run.result.kind).toBe("ok");
      expect(run.pane.pastes).toHaveLength(1);
      expect(run.pane.pastes[0]).toContain("[megabrain dispatch:");
      expect(run.pane.pastes[0]).toContain("do the task\nsecond line");
      expect(run.pane.submissions).toEqual(run.pane.pastes);
      // The prompt travels as a bracketed paste, then exactly one Enter submits it.
      expect(afterFirstPaste(run.events)).toEqual(["paste", "key:Enter"]);
      expect(readMeta(run.root, run.dispatchId)).toMatchObject({ promptReceipt: "received", promptState: "confirmed" });
    } finally {
      await cleanupRun(run);
    }
  });

  test.each(agents)("%s: delivers a long collapsed brief whole", async (agent) => {
    const id = `dispatch-long-${agent}`;
    const run = await runComposerSpawn(id, { agent, onSubmit: (_prompt, root) => appendReceived(root, id) }, { MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "2" }, ["--prompt", longBrief]);
    try {
      expect(run.result.kind).toBe("ok");
      expect(run.pane.submissions).toHaveLength(1);
      expect(run.pane.submissions[0]).toContain(longBrief);
    } finally {
      await cleanupRun(run);
    }
  });

  test.each(agents)("%s: clears and pastes again once when only the tail of the prompt arrived", async (agent) => {
    const id = `dispatch-repaste-${agent}`;
    const run = await runComposerSpawn(id, { agent, swallowPastes: 1, tailBytes: 400, onSubmit: (_prompt, root) => appendReceived(root, id) }, { MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "2" }, ["--prompt", longBrief]);
    try {
      expect(run.result.kind).toBe("ok");
      expect(run.pane.pastes).toHaveLength(2);
      expect(run.pane.submissions).toHaveLength(1);
      expect(run.pane.submissions[0]).toBe(run.pane.pastes[1]);
      expect(run.pane.submissions[0]).toContain(longBrief);
      expect(afterFirstPaste(run.events)).toEqual(["paste", "key:C-u", "paste", "key:Enter"]);
    } finally {
      await cleanupRun(run);
    }
  });

  test.each(agents)("%s: fails without pressing Enter when the repaste is truncated too", async (agent) => {
    const run = await runComposerSpawn(`dispatch-repaste-fails-${agent}`, { agent, swallowPastes: 2, tailBytes: 400 }, {}, ["--prompt", longBrief]);
    try {
      expect(run.result.kind).toBe("failed");
      if (run.result.kind !== "failed") throw new Error("expected a failure");
      expect(run.result.error).toContain("prompt-transport-failed");
      expect(run.pane.pastes).toHaveLength(2);
      expect(run.pane.submissions).toHaveLength(0);
      expect(afterFirstPaste(run.events)).not.toContain("key:Enter");
      expect(readMeta(run.root, run.dispatchId)).toMatchObject({ state: "failed", reason: "prompt-transport-failed" });
    } finally {
      await cleanupRun(run);
    }
  });

  test.each(agents)("%s: presses Enter a second time when the first one did not start a turn", async (agent) => {
    const id = `dispatch-second-enter-${agent}`;
    const run = await runComposerSpawn(id, { agent, ignoreEnters: 1, onSubmit: (_prompt, root) => appendReceived(root, id) }, { MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "2" });
    try {
      expect(run.result.kind).toBe("ok");
      expect(run.pane.pastes).toHaveLength(1);
      expect(afterFirstPaste(run.events)).toEqual(["paste", "key:Enter", "key:Enter"]);
      expect(run.pane.submissions).toHaveLength(1);
    } finally {
      await cleanupRun(run);
    }
  });
});
