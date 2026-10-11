import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classifyPromptState, promptFinding, type PromptState } from "../../src/cli/commands/prompt-state.js";
import { mayAutoRecover, recommendationFor, shouldNotifyFinding } from "../../src/core/supervise.js";

const frame = (name: string): string => readFileSync(new URL(`../fixtures/prompt-state/${name}.txt`, import.meta.url), "utf8");

const claudeShell = "Run this shell command and report its output: sleep 60; echo done";
const claudeForeground = "Use the Bash tool in the foreground to run exactly: python3 -c 'import time; time.sleep(50); print(\"finished\")'  and then report the output.";
const codexShell = "Run this exact shell command and report output: python3 -c 'import time; time.sleep(50); print(1)'";

describe("prompt state from the pane", () => {
  test.each<[string, string, string, string, PromptState]>([
    ["claude: pasted and never submitted", "claude", "claude-unsubmitted", claudeShell, "unsubmitted"],
    ["codex: pasted and never submitted", "codex", "codex-unsubmitted", codexShell, "unsubmitted"],
    ["claude: working on the prompt", "claude", "claude-working-draft", claudeForeground, "delivered-working"],
    ["codex: working on the prompt", "codex", "codex-working", codexShell, "delivered-working"],
    ["claude: a message waits for the turn to end", "claude", "claude-queued", claudeForeground, "queued"],
    ["codex: a steered message waits above the working line", "codex", "codex-steered", codexShell, "queued"],
    ["codex: a queued reply waits above the working line", "codex", "codex-queue-item", codexShell, "queued"],
    ["claude: turn finished, prompt shown as a submitted turn", "claude", "claude-delivered-idle", claudeShell, "delivered"],
    ["claude: idle at an empty composer, prompt nowhere", "claude", "claude-idle", claudeShell, "lost"],
    ["codex: idle at an empty composer, prompt nowhere", "codex", "codex-idle", codexShell, "lost"],
  ])("%s", (_name, agent, fixture, prompt, expected) => {
    expect(classifyPromptState({ agent, frame: frame(fixture), prompt, received: false }).state).toBe(expected);
  });

  test("a receipt settles the prompt whatever the pane shows", () => {
    expect(classifyPromptState({ agent: "codex", frame: frame("codex-idle"), prompt: codexShell, received: true }).state).toBe("received");
    expect(classifyPromptState({ agent: "claude", frame: frame("claude-unsubmitted"), prompt: claudeShell, received: true }).state).toBe("received");
  });

  test("the codex title spinner proves a turn is running when the frame alone does not", () => {
    const quiet = "› Ask Codex to do anything\n  GPT-6-Luna medium · Context 100% left";
    expect(classifyPromptState({ agent: "codex", frame: quiet, prompt: codexShell, received: false }).state).toBe("lost");
    expect(classifyPromptState({ agent: "codex", frame: quiet, prompt: codexShell, received: false, title: "⠋ Confirm dispatch receipt | feat-x" }).state).toBe("delivered-working");
    expect(classifyPromptState({ agent: "codex", frame: quiet, prompt: codexShell, received: false, title: "Confirm dispatch receipt | feat-x" }).state).toBe("lost");
  });

  test("a prompt that wrapped across lines in the transcript still counts as shown", () => {
    const wrapped = "Task PS: no deadline for the first prompt; the supervisor judges, from the terminal, whether\n  a prompt is delivered, queued, waiting or lost.";
    const screen = `› ${wrapped.split("\n")[0]}\n${wrapped.split("\n")[1]}\n• Working (3s • esc to interrupt)\n› Ask Codex to do anything`;
    const prompt = wrapped.replace("\n  ", " ");
    expect(classifyPromptState({ agent: "codex", frame: screen, prompt, received: false }).state).toBe("delivered-working");
  });

  test("an empty or unreadable frame proves nothing", () => {
    expect(classifyPromptState({ agent: "claude", frame: "", prompt: claudeShell, received: false }).state).toBe("unknown");
    expect(classifyPromptState({ agent: "other", frame: "$ ", prompt: claudeShell, received: false }).state).toBe("unknown");
  });
});

describe("prompt findings", () => {
  test("queued and delivered-working are never findings, however long they last", () => {
    for (const state of ["queued", "delivered-working", "delivered", "received", "unknown"] as const) {
      const finding = promptFinding(state);
      expect(finding.cause).toBe("unknown");
      // Thirty minutes, a day and a week into the same state: still nothing to tell the parent.
      for (const age of [30 * 60_000, 24 * 3_600_000, 7 * 24 * 3_600_000]) {
        expect(shouldNotifyFinding({ cause: "unknown", notifiedAt: 0 }, finding, age)).toBe(false);
      }
    }
  });

  test("lost is a finding that tells the parent to resend through orchestrate reply", () => {
    const finding = promptFinding("lost");
    expect(finding.cause).toBe("prompt-lost");
    expect(shouldNotifyFinding(undefined, finding, 1_000)).toBe(true);
    expect(mayAutoRecover(finding)).toBe(false);
    const advice = recommendationFor(finding, "dispatch-1");
    expect(advice).toContain("megabrain orchestrate reply dispatch-1");
    expect(advice).toContain("resend");
  });

  test("unsubmitted is a finding the supervisor recovers by itself", () => {
    const finding = promptFinding("unsubmitted");
    expect(finding.cause).toBe("prompt-unsubmitted");
    expect(mayAutoRecover(finding)).toBe(true);
  });
});
