import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolveParentContext } from "../../src/core/context.js";
import { classifyLiveness, isFirstRunDialog } from "../../src/core/liveness.js";
import { composerHoldsText } from "../../src/core/composer-proof.js";
import { commandLine, getAgent, interruptKey, resolveAgentDescriptor, submitKey } from "../../src/agents/index.js";

const fixture = (name: string) => readFile(new URL(`../fixtures/tmux-capture-grok-${name}.txt`, import.meta.url), "utf8");

describe("grok agent", () => {
  test("owns its launch line: model, reasoning effort and auto-approve", () => {
    expect(commandLine("grok", { model: "grok-4.7", effort: "low", browser: false, agentArgs: [] })).toEqual({
      kind: "ok",
      value: 'grok --always-approve -m "grok-4.7" --reasoning-effort "low"',
    });
    expect(commandLine("grok", { model: null, effort: null, browser: false, agentArgs: ["--no-alt-screen"] })).toEqual({
      kind: "ok",
      value: "grok --always-approve --no-alt-screen",
    });
  });

  test("submits with Enter and interrupts with Ctrl+C, because Escape does not cancel a turn", () => {
    expect(submitKey("grok")).toEqual({ kind: "ok", value: "Enter" });
    expect(interruptKey("grok")).toEqual({ kind: "ok", value: "C-c" });
    expect(interruptKey("claude")).toEqual({ kind: "ok", value: "Escape" });
  });

  test("is found by its descriptor", () => {
    expect(resolveAgentDescriptor("grok")).toBe("grok");
    expect(resolveAgentDescriptor("grok-build")).toBe("grok");
    expect(resolveParentContext({ aiAgent: "grok" }).agent).toBe("grok");
  });

  test("an empty composer is idle", async () => {
    expect(classifyLiveness("grok", await fixture("idle"))).toEqual({ status: "idle", reason: "terminal shows an empty Grok composer" });
  });

  test("the stop affordance above the composer means working", async () => {
    expect(classifyLiveness("grok", await fixture("working")).status).toBe("working");
  });

  test("a permission dialog is blocked even though a tool is still running behind it", async () => {
    expect(classifyLiveness("grok", await fixture("permission")).status).toBe("blocked");
  });

  test("typed but unsubmitted text is not idle", async () => {
    const idle = await fixture("idle");
    const typed = idle.replace(/│ ❯ +│/, "│ ❯ half a prompt │");
    expect(typed).not.toBe(idle);
    expect(classifyLiveness("grok", typed).status).toBe("unknown");
  });

  test("a queued message above the composer does not make a working frame idle", async () => {
    const queued = `${await fixture("working")}\n   ▾ Queued 1\n     #1 queued msg\n`;
    expect(classifyLiveness("grok", queued).status).toBe("working");
  });

  test("the trust dialog is a first-run dialog answered with y, and is never idle", async () => {
    const trust = await fixture("trust");
    expect(isFirstRunDialog("grok", trust)).toBe(true);
    expect(getAgent("grok")?.firstRunDialogKey).toBe("y");
    expect(classifyLiveness("grok", trust).status).toBe("unknown");
    expect(isFirstRunDialog("grok", await fixture("idle"))).toBe(false);
    expect(isFirstRunDialog("grok", trust.replace("Yes, proceed", "Maybe"))).toBe(false);
  });

  test("an unrecognised screen is unknown", () => {
    expect(classifyLiveness("grok", "anything")).toEqual({ status: "unknown", reason: null });
    expect(classifyLiveness("grok", "").status).toBe("unknown");
  });

  test("the composer proof reads a prompt wrapped inside the bordered box, and rejects a partial one", async () => {
    const prompt = "This is a smoke test. Run exactly this shell command: megabrain received . Then run: megabrain done 'Grok smoke test finished fine' . Then stop.";
    const wrapped = await fixture("wrapped-paste");
    expect(composerHoldsText("grok", wrapped, prompt)).toBe(true);
    expect(composerHoldsText("grok", wrapped, `${prompt} And then keep going.`)).toBe(false);
    expect(composerHoldsText("grok", await fixture("idle"), prompt)).toBe(false);
  });

  test("the composer proof accepts the collapsed paste placeholder only when its line count matches", async () => {
    const collapsed = await fixture("collapsed-paste");
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
    expect(collapsed).toContain("[Pasted: 7 lines]");
    expect(composerHoldsText("grok", collapsed, lines(7))).toBe(true);
    expect(composerHoldsText("grok", collapsed, lines(8))).toBe(false);
    expect(composerHoldsText("grok", collapsed, `${lines(7)}\n`)).toBe(true);
    expect(composerHoldsText("grok", collapsed.replace("[Pasted: 7 lines]", "[Pasted: 7 lines] [Pasted: 2 lines]"), lines(7))).toBe(false);
  });
});
