import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { composerHoldsText } from "../../src/core/composer-proof.js";

// Frames and prompts are captured from the real agents in a private tmux server (Claude Code
// 2.1.296, Codex 0.162.1), not written by hand: see tests/fixtures/composer.
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/composer/${name}.txt`, import.meta.url), "utf8");

describe("composerHoldsText", () => {
  const longPrompt = fixture("prompt-58-lines");
  const shortPrompt = fixture("prompt-short");

  test("accepts the single collapsed paste Claude shows for a whole multi-line prompt", () => {
    expect(longPrompt.split("\n").length - 1).toBe(58);
    expect(composerHoldsText("claude", fixture("claude-pasted-58-lines"), longPrompt)).toBe(true);
  });

  test("rejects the tail-only composer a fast send-keys leaves behind in Claude", () => {
    expect(composerHoldsText("claude", fixture("claude-send-keys-fragments"), longPrompt)).toBe(false);
  });

  test("rejects a collapsed paste whose line count differs from the prompt", () => {
    const shorter = longPrompt.split("\n").slice(0, 40).join("\n");
    expect(composerHoldsText("claude", fixture("claude-pasted-58-lines"), shorter)).toBe(false);
  });

  test("rejects several collapsed pastes even when their line counts add up", () => {
    const screen = "──────\n❯ [Pasted text #1 +12 lines][Pasted text #2 +46 lines]\n──────\n";
    expect(composerHoldsText("claude", screen, longPrompt)).toBe(false);
  });

  test("accepts a one-line paste that Claude collapses without a line count", () => {
    expect(composerHoldsText("claude", fixture("claude-pasted-one-line"), "x".repeat(1500))).toBe(true);
    expect(composerHoldsText("claude", fixture("claude-pasted-one-line"), `${"x".repeat(1500)}\nsecond line`)).toBe(false);
  });

  test("accepts a short prompt typed inline, whatever the wrapping", () => {
    expect(composerHoldsText("claude", fixture("claude-short-inline"), shortPrompt)).toBe(true);
    expect(composerHoldsText("codex", fixture("codex-short-inline"), shortPrompt)).toBe(true);
    expect(composerHoldsText("codex", fixture("codex-short-inline"), `${shortPrompt}\nfourth line`)).toBe(false);
  });

  test("accepts Codex's collapsed paste only when the character count matches", () => {
    expect(longPrompt.length).toBe(4660);
    expect(composerHoldsText("codex", fixture("codex-pasted-4660-chars"), longPrompt)).toBe(true);
    expect(composerHoldsText("codex", fixture("codex-pasted-4660-chars"), longPrompt.slice(0, 4659))).toBe(false);
  });

  test("counts Codex characters as code points, not UTF-16 units", () => {
    const text = `${"é".repeat(100)}😀\n${"x".repeat(900)}`;
    const screen = `› [Pasted Content ${[...text].length} chars]\n`;
    expect(text.length).not.toBe([...text].length);
    expect(composerHoldsText("codex", screen, text)).toBe(true);
  });

  test("never mistakes an empty composer for a delivered prompt", () => {
    expect(composerHoldsText("claude", fixture("claude-idle"), longPrompt)).toBe(false);
    expect(composerHoldsText("codex", fixture("codex-idle"), longPrompt)).toBe(false);
    expect(composerHoldsText("codex", fixture("codex-idle"), shortPrompt)).toBe(false);
  });
});
